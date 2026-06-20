// ----------------------------------------------------------------------------
// Accounting page — PR #36.
//
// Tab strip:
//   1. Journal Entries — list w/ filter, drill into lines
//   2. General Ledger — flat GL stream, filter by account / date
//   3. Balances — trial-balance-style view (Σ Dr, Σ Cr, balance)
//   4. AR Aging — outstanding SI bucketed (CURRENT / 1-30 / 31-60 / 61-90 / 90+)
//   5. AP Aging — outstanding PI bucketed
//
// Commander 2026-05-25 "OK A": don't fork Odoo (AGPL), reference ERPNext
// (MIT), build a simple journal-entries + GL + AR/AP aging.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { BookOpen, FileText, Receipt, TrendingDown, TrendingUp } from 'lucide-react';
import {
  useJournalEntries,
  useGlEntries,
  useAccountBalances,
  useArAging,
  useApAging,
  useAccounts,
  type ArAgingRow,
  type ApAgingRow,
  type JournalEntry,
} from '../../vendor/scm/lib/accounting-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import styles from './Suppliers.module.css';
import { fmtDateOrDash } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmt = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Tab = 'je' | 'gl' | 'balances' | 'ar' | 'ap';

export const Accounting = () => {
  const [tab, setTab] = useState<Tab>('je');

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Accounting</h1>
        </div>
      </div>

      <div className={styles.statusChips} style={{ gap: 'var(--space-2)' }}>
        <TabBtn label="Journal Entries" icon={<BookOpen {...ICON} />} active={tab === 'je'}    onClick={() => setTab('je')} />
        <TabBtn label="General Ledger"  icon={<FileText {...ICON} />} active={tab === 'gl'}    onClick={() => setTab('gl')} />
        <TabBtn label="Balances"        icon={<Receipt {...ICON} />}  active={tab === 'balances'} onClick={() => setTab('balances')} />
        <TabBtn label="AR Aging"        icon={<TrendingUp {...ICON} />} active={tab === 'ar'}  onClick={() => setTab('ar')} />
        <TabBtn label="AP Aging"        icon={<TrendingDown {...ICON} />} active={tab === 'ap'} onClick={() => setTab('ap')} />
      </div>

      {tab === 'je'       && <JeTab />}
      {tab === 'gl'       && <GlTab />}
      {tab === 'balances' && <BalancesTab />}
      {tab === 'ar'       && <ArAgingTab />}
      {tab === 'ap'       && <ApAgingTab />}
    </div>
  );
};

const TabBtn = ({
  label, icon, active, onClick,
}: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) => (
  <button type="button" onClick={onClick}
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 12px',
      border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
      borderRadius: 'var(--radius-md)',
      background: active ? 'var(--c-ink)' : 'transparent',
      color: active ? 'var(--c-cream)' : 'var(--c-ink)',
      fontSize: 'var(--fs-13)',
      cursor: 'pointer',
    }}>
    {icon}
    <span>{label}</span>
  </button>
);

/* ── Journal Entries ─────────────────────────────────────────────────── */

/* JE status label — REVERSED wins over POSTED, then DRAFT. */
const jeStatus = (r: JournalEntry): string =>
  r.reversed ? 'REVERSED' : r.posted ? 'POSTED' : 'DRAFT';

/* Shared DataGrid conversion (2026-06-12) — journal-entry LIST only; the
   other Accounting tabs (GL / Balances / AR / AP) keep their legacy tables.
   Static column spec at module scope so DataGrid's memo hits. */
const JE_COLUMNS: DataGridColumn<JournalEntry>[] = [
  {
    key: 'jeNo',
    label: 'JE No',
    width: 140,
    accessor: (r) => <span className={styles.codeChip}>{r.je_no}</span>,
    searchValue: (r) => r.je_no,
    filterValue: (r) => r.je_no,
    sortFn: (a, b) => a.je_no.localeCompare(b.je_no),
  },
  {
    key: 'date',
    label: 'Date',
    width: 110,
    accessor: (r) => fmtDateOrDash(r.entry_date),
    filterValue: (r) => fmtDateOrDash(r.entry_date),
    sortFn: (a, b) => (a.entry_date ?? '').localeCompare(b.entry_date ?? ''),
    filterType: 'date', dateValue: (r) => r.entry_date,
  },
  {
    key: 'source',
    label: 'Source',
    width: 110,
    accessor: (r) => r.source_type,
    filterValue: (r) => r.source_type,
  },
  {
    key: 'doc',
    label: 'Doc',
    width: 140,
    accessor: (r) => r.source_doc_no ?? '—',
    filterValue: (r) => r.source_doc_no ?? '—',
  },
  {
    key: 'debit',
    label: 'Debit',
    width: 130,
    align: 'right',
    accessor: (r) => fmt(r.total_debit_sen),
    searchValue: () => '',
    filterValue: (r) => fmt(r.total_debit_sen),
    sortFn: (a, b) => a.total_debit_sen - b.total_debit_sen,
  },
  {
    key: 'credit',
    label: 'Credit',
    width: 130,
    align: 'right',
    accessor: (r) => fmt(r.total_credit_sen),
    searchValue: () => '',
    filterValue: (r) => fmt(r.total_credit_sen),
    sortFn: (a, b) => a.total_credit_sen - b.total_credit_sen,
  },
  {
    key: 'status',
    label: 'Status',
    width: 110,
    accessor: (r) => (
      <span className={`${styles.statusPill} ${r.posted ? styles.statusActive : styles.statusInactive}`}>
        {jeStatus(r)}
      </span>
    ),
    searchValue: (r) => jeStatus(r),
    filterValue: (r) => jeStatus(r),
  },
];

const JeTab = () => {
  const [sourceType, setSourceType] = useState<string>('');
  const q = useJournalEntries(sourceType ? { sourceType } : undefined);
  const rows = useMemo(() => q.data?.journalEntries ?? [], [q.data]);

  return (
    <DataGrid
      rows={rows}
      columns={JE_COLUMNS}
      storageKey="dg-accounting-je"
      rowKey={(r) => r.id}
      searchPlaceholder="Filter visible entries…"
      groupBanner={false}
      isLoading={q.isLoading}
      emptyMessage="No entries."
      toolbar={
        <>
          <select
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value)}
            className={styles.searchInput}
            style={{ maxWidth: 200 }}>
            <option value="">All sources</option>
            <option value="SI">SI — Sales Invoice</option>
            <option value="PI">PI — Purchase Invoice</option>
            <option value="SI_PAYMENT">SI Payment</option>
            <option value="PI_PAYMENT">PI Payment</option>
            <option value="MANUAL">Manual</option>
          </select>
          <span className={styles.subtitle}>{rows.length} entries</span>
        </>
      }
    />
  );
};

/* ── GL ──────────────────────────────────────────────────────────────── */
const GlTab = () => {
  const accounts = useAccounts();
  const [accountCode, setAccountCode] = useState<string>('');
  const q = useGlEntries(accountCode ? { accountCode } : undefined);
  const rows = q.data?.glEntries ?? [];

  return (
    <section className={styles.tableCard}>
      <div className={styles.actionsRow} style={{ padding: 'var(--space-3) var(--space-4)' }}>
        <select
          value={accountCode}
          onChange={(e) => setAccountCode(e.target.value)}
          className={styles.searchInput}
          style={{ maxWidth: 320 }}>
          <option value="">All accounts</option>
          {(accounts.data?.accounts ?? []).map((a) => (
            <option key={a.account_code} value={a.account_code}>
              {a.account_code} — {a.account_name}
            </option>
          ))}
        </select>
        <span className={styles.subtitle}>{rows.length} entries</span>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Date</th><th>JE No</th><th>Source</th><th>Account</th>
            <th style={{ textAlign: 'right' }}>Debit</th>
            <th style={{ textAlign: 'right' }}>Credit</th>
            <th>Party</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} className={styles.emptyRow}>No GL entries posted yet.</td></tr>
          ) : rows.map((r) => (
            <tr key={r.line_id}>
              <td>{fmtDateOrDash(r.entry_date)}</td>
              <td><span className={styles.codeChip}>{r.je_no}</span></td>
              <td>{r.source_type}{r.source_doc_no ? ` · ${r.source_doc_no}` : ''}</td>
              <td>{r.account_code} — {r.account_name}</td>
              <td style={{ textAlign: 'right' }}>{r.debit_sen > 0 ? fmt(r.debit_sen) : '—'}</td>
              <td style={{ textAlign: 'right' }}>{r.credit_sen > 0 ? fmt(r.credit_sen) : '—'}</td>
              <td>{r.party_name ?? r.party_code ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

/* ── Balances ────────────────────────────────────────────────────────── */
const BalancesTab = () => {
  const q = useAccountBalances();
  const rows = useMemo(() => q.data?.balances ?? [], [q.data]);

  const grouped = useMemo(() => {
    const order = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
    const g: Record<string, typeof rows> = {};
    for (const r of rows) (g[r.account_type] ??= []).push(r);
    return order.map((t) => ({ type: t, rows: g[t] ?? [] }));
  }, [rows]);

  return (
    <section className={styles.tableCard}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Account</th>
            <th style={{ textAlign: 'right' }}>Σ Debit</th>
            <th style={{ textAlign: 'right' }}>Σ Credit</th>
            <th style={{ textAlign: 'right' }}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {grouped.map((g) => (
            g.rows.length > 0 && (
              <>
                <tr key={`g-${g.type}`}>
                  <td colSpan={4} style={{
                    fontWeight: 700, background: 'var(--c-cream)',
                    color: 'var(--c-burnt)',
                  }}>
                    {g.type}
                  </td>
                </tr>
                {g.rows.map((r) => (
                  <tr key={r.account_code}>
                    <td>{r.account_code} — {r.account_name}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.total_debit_sen)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.total_credit_sen)}</td>
                    <td style={{
                      textAlign: 'right', fontWeight: 700,
                      color: r.balance_sen < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)',
                    }}>
                      {fmt(r.balance_sen)}
                    </td>
                  </tr>
                ))}
              </>
            )
          ))}
        </tbody>
      </table>
    </section>
  );
};

/* ── AR Aging ────────────────────────────────────────────────────────── */
const ArAgingTab = () => {
  const q = useArAging();
  const rows = useMemo(() => q.data?.arAging ?? [], [q.data]);
  const totals = useMemo(() => bucketTotals<ArAgingRow>(rows), [rows]);

  return (
    <>
      <BucketSummary totals={totals} grandTotal={rows.reduce((s, r) => s + r.outstanding_centi, 0)} />
      <section className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Invoice</th><th>Customer</th><th>Date</th><th>Due</th>
              <th style={{ textAlign: 'right' }}>Outstanding</th>
              <th>Days Overdue</th><th>Bucket</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className={styles.emptyRow}>No outstanding AR.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.invoice_id}>
                <td><span className={styles.codeChip}>{r.invoice_number}</span></td>
                <td>{r.debtor_name}{r.debtor_code ? ` (${r.debtor_code})` : ''}</td>
                <td>{fmtDateOrDash(r.invoice_date)}</td>
                <td>{r.due_date ?? '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(r.outstanding_centi)}</td>
                <td>{r.days_overdue > 0 ? r.days_overdue : '—'}</td>
                <td><BucketPill bucket={r.aging_bucket} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
};

/* ── AP Aging ────────────────────────────────────────────────────────── */
const ApAgingTab = () => {
  const q = useApAging();
  const rows = useMemo(() => q.data?.apAging ?? [], [q.data]);
  const totals = useMemo(() => bucketTotals<ApAgingRow>(rows), [rows]);

  return (
    <>
      <BucketSummary totals={totals} grandTotal={rows.reduce((s, r) => s + r.outstanding_centi, 0)} />
      <section className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Invoice</th><th>Supplier</th><th>Date</th><th>Due</th>
              <th style={{ textAlign: 'right' }}>Outstanding</th>
              <th>Days Overdue</th><th>Bucket</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className={styles.emptyRow}>No outstanding AP.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.invoice_id}>
                <td><span className={styles.codeChip}>{r.invoice_number}</span></td>
                <td>{r.supplier_name ?? '—'}{r.supplier_code ? ` (${r.supplier_code})` : ''}</td>
                <td>{fmtDateOrDash(r.invoice_date)}</td>
                <td>{r.due_date ?? '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(r.outstanding_centi)}</td>
                <td>{r.days_overdue > 0 ? r.days_overdue : '—'}</td>
                <td><BucketPill bucket={r.aging_bucket} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
};

/* ── Helpers ─────────────────────────────────────────────────────────── */
type Bucket = 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';

const bucketTotals = <T extends { aging_bucket: Bucket; outstanding_centi: number }>(rows: T[]) => {
  const out: Record<Bucket, number> = { 'CURRENT': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rows) out[r.aging_bucket] += r.outstanding_centi;
  return out;
};

const BucketSummary = ({
  totals, grandTotal,
}: { totals: Record<Bucket, number>; grandTotal: number }) => (
  <section style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 'var(--space-3)' }}>
    {(['CURRENT', '1-30', '31-60', '61-90', '90+'] as const).map((b) => (
      <SummaryTile key={b} label={b} value={fmt(totals[b])} muted={b === 'CURRENT'} />
    ))}
    <SummaryTile label="Total" value={fmt(grandTotal)} bold />
  </section>
);

const SummaryTile = ({
  label, value, muted, bold,
}: { label: string; value: string; muted?: boolean; bold?: boolean }) => (
  <div style={{
    padding: 'var(--space-3) var(--space-4)',
    background: 'var(--c-cream)',
    border: `1px solid ${muted ? 'var(--c-line, rgba(34,31,32,0.08))' : 'var(--c-orange)'}`,
    borderRadius: 'var(--radius-md)',
  }}>
    <div className={styles.subtitle} style={{ marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: 'var(--fs-16)', fontWeight: bold ? 900 : 700, color: 'var(--c-ink)' }}>
      {value}
    </div>
  </div>
);

const BucketPill = ({ bucket }: { bucket: Bucket }) => {
  const colorMap: Record<Bucket, { bg: string; fg: string }> = {
    'CURRENT': { bg: 'rgba(47, 93, 79, 0.12)', fg: 'var(--c-secondary-a, #2F5D4F)' },
    '1-30':    { bg: 'rgba(232, 107, 58, 0.10)', fg: 'var(--c-orange)' },
    '31-60':   { bg: 'rgba(232, 107, 58, 0.18)', fg: 'var(--c-orange)' },
    '61-90':   { bg: 'rgba(184, 51, 31, 0.10)', fg: 'var(--c-festive-b, #B8331F)' },
    '90+':     { bg: 'rgba(184, 51, 31, 0.18)', fg: 'var(--c-festive-b, #B8331F)' },
  };
  const c = colorMap[bucket];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      borderRadius: 999, background: c.bg, color: c.fg,
      fontSize: 'var(--fs-12)', fontWeight: 700,
    }}>
      {bucket}
    </span>
  );
};
