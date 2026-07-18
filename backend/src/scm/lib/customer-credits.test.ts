// Atomicity of "apply customer credit to a Sales Invoice".
//
// The credit payment row on the SI and the negative APPLIED_TO_SI ledger row are
// two writes in different tables that MUST move together — a failure between them
// pays the invoice from a credit that was never debited (the customer keeps the
// balance and can spend it twice). PostgREST cannot span two statements in one
// transaction, so applyCustomerCreditToSi now routes the write through the
// scm.apply_customer_credit_to_si function (one implicit transaction) and only
// falls back to the legacy two-write path when that function is absent.
//
// scm rides Supabase Postgres, which the D1 test harness does not rebuild, so
// these drive a minimal fake PostgREST client and pin the CONTRACT: the primary
// path is a single write unit (the RPC), the fallback is the two-write path, and
// a live RPC error never silently degrades to the non-atomic path.
import { describe, expect, test } from 'vitest';
import { applyCustomerCreditToSi } from './customer-credits';

type Row = Record<string, unknown>;

type Store = {
  rpcCalls: Array<{ fn: string; params: Row }>;
  rpcResponse: { data: unknown; error: { code?: string; message?: string } | null };
  inserts: Array<{ table: string; payload: Row }>;
  updates: Array<{ table: string; payload: Row }>;
  existingCreditPayments: Row[];
  creditRows: Row[]; // customer_credits balance rows for the debtor
  companyId: number | null;
  paidCenti: number;
};

/** Chainable, awaitable PostgREST stand-in covering the reads/writes the legacy
 *  fallback performs plus the .rpc() the primary path uses. */
function fakeSb(store: Store) {
  class Q {
    table: string;
    op: 'select' | 'insert' | 'update' = 'select';
    cols = '';
    filters: Record<string, unknown> = {};
    payload: Row | null = null;
    singleRow = false;
    constructor(table: string) { this.table = table; }
    select(cols?: string) { if (this.op === 'select') this.cols = cols ?? ''; return this; }
    insert(payload: Row) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
    eq(col: string, val: unknown) { this.filters[col] = val; return this; }
    in() { return this; }
    limit() { return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    private result(): { data: unknown; error: unknown } {
      if (this.op === 'insert') {
        store.inserts.push({ table: this.table, payload: this.payload ?? {} });
        return { data: this.singleRow ? { id: 'new-id' } : [{ id: 'new-id' }], error: null };
      }
      if (this.op === 'update') {
        store.updates.push({ table: this.table, payload: this.payload ?? {} });
        return { data: [{ id: this.filters.id ?? 'x' }], error: null };
      }
      // selects
      if (this.table === 'sales_invoice_payments') {
        return { data: store.existingCreditPayments, error: null };
      }
      if (this.table === 'customer_credits') {
        return { data: store.creditRows, error: null };
      }
      if (this.table === 'sales_invoices') {
        const row = this.cols.includes('paid_centi')
          ? { paid_centi: store.paidCenti }
          : { company_id: store.companyId };
        return { data: this.singleRow ? row : [row], error: null };
      }
      return { data: this.singleRow ? null : [], error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return {
    from: (table: string) => new Q(table),
    rpc: (fn: string, params: Row) => {
      store.rpcCalls.push({ fn, params });
      return Promise.resolve(store.rpcResponse);
    },
  };
}

function baseStore(over: Partial<Store> = {}): Store {
  return {
    rpcCalls: [],
    rpcResponse: { data: null, error: null },
    inserts: [],
    updates: [],
    existingCreditPayments: [],
    creditRows: [],
    companyId: 1,
    paidCenti: 0,
    ...over,
  };
}

const ARGS = {
  debtorCode: 'CUST-1',
  debtorName: 'Alice',
  siId: 'si-uuid-1',
  siNumber: 'SI-2607-001',
  remainingDueCenti: 5000,
  createdBy: 'staff-1',
};

describe('applyCustomerCreditToSi — atomic RPC path', () => {
  test('routes through the single atomic RPC and does NO direct table writes', async () => {
    const store = baseStore({
      rpcResponse: { data: [{ applied_centi: 3000, reason: null }], error: null },
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);

    expect(res).toEqual({ applied: 3000 });
    // The whole write is ONE unit — the payment row and ledger debit cannot diverge.
    expect(store.rpcCalls).toHaveLength(1);
    expect(store.rpcCalls[0].fn).toBe('apply_customer_credit_to_si');
    expect(store.inserts).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });

  test('passes the SI + debtor through to the function params', async () => {
    const store = baseStore({ rpcResponse: { data: [{ applied_centi: 5000, reason: null }], error: null } });
    await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(store.rpcCalls[0].params).toMatchObject({
      p_debtor_code: 'CUST-1',
      p_si_id: 'si-uuid-1',
      p_si_number: 'SI-2607-001',
      p_remaining_due_centi: 5000,
      p_created_by: 'staff-1',
    });
  });

  test("the function's idempotent no-op (already_applied) surfaces without any write", async () => {
    const store = baseStore({
      rpcResponse: { data: [{ applied_centi: 0, reason: 'already_applied' }], error: null },
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'already_applied' });
    expect(store.inserts).toHaveLength(0);
  });

  test('a LIVE RPC error never degrades to the non-atomic path — nothing is written', async () => {
    const store = baseStore({
      rpcResponse: { data: null, error: { code: '40001', message: 'deadlock detected' } },
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res.applied).toBe(0);
    expect(res.reason).toBe('deadlock detected');
    // The function ran and rolled back; we must not re-attempt via the racy path.
    expect(store.inserts).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });
});

describe('applyCustomerCreditToSi — legacy fallback (function not yet applied)', () => {
  const MISSING = { code: 'PGRST202', message: 'Could not find the function scm.apply_customer_credit_to_si in the schema cache' };

  test('falls back to the two-write path when the RPC is absent', async () => {
    const store = baseStore({
      rpcResponse: { data: null, error: MISSING },
      creditRows: [{ amount_centi: 8000 }], // balance 8000, due 5000 → apply 5000
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);

    expect(res.applied).toBe(5000);
    // The fallback IS the two separate cross-table writes the RPC replaces.
    const tables = store.inserts.map((i) => i.table).sort();
    expect(tables).toEqual(['customer_credits', 'sales_invoice_payments']);
    const ledger = store.inserts.find((i) => i.table === 'customer_credits');
    expect(ledger?.payload).toMatchObject({ amount_centi: -5000, source_type: 'APPLIED_TO_SI' });
  });

  test('fallback still honours the credit-payment idempotency guard', async () => {
    const store = baseStore({
      rpcResponse: { data: null, error: MISSING },
      existingCreditPayments: [{ id: 'pay-1', amount_centi: 5000 }],
      creditRows: [{ amount_centi: 8000 }],
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'already_applied' });
    expect(store.inserts).toHaveLength(0);
  });

  test('fallback no-ops when the balance is zero', async () => {
    const store = baseStore({ rpcResponse: { data: null, error: MISSING }, creditRows: [] });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'no_balance' });
    expect(store.inserts).toHaveLength(0);
  });
});

describe('applyCustomerCreditToSi — guards (no DB touched)', () => {
  test('no debtor → no_debtor, no RPC', async () => {
    const store = baseStore();
    const res = await applyCustomerCreditToSi(fakeSb(store), { ...ARGS, debtorCode: '  ' });
    expect(res).toEqual({ applied: 0, reason: 'no_debtor' });
    expect(store.rpcCalls).toHaveLength(0);
  });

  test('nothing due → no_due, no RPC', async () => {
    const store = baseStore();
    const res = await applyCustomerCreditToSi(fakeSb(store), { ...ARGS, remainingDueCenti: 0 });
    expect(res).toEqual({ applied: 0, reason: 'no_due' });
    expect(store.rpcCalls).toHaveLength(0);
  });
});
