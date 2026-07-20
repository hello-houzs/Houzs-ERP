import { describe, expect, test, vi } from 'vitest';
import type { Sql } from 'postgres';
import { pgTransactionSupabase } from '../src/scm/lib/pg-supabase-transaction';

describe('SCM PostgreSQL transaction adapter', () => {
  test('encodes JSON arrays as JSON while preserving native PostgreSQL arrays', async () => {
    const unsafe = vi.fn(async (text: string) => text.startsWith('INSERT') ? [{ id: 'line-1' }] : []);
    const sb = pgTransactionSupabase({ unsafe } as unknown as Sql);

    const result = await sb.from('mfg_sales_order_items').insert({
      variants: { buildKey: 'B-1' },
      custom_specials: [{ code: 'SPECIAL' }],
      photo_urls: ['so/line/photo.jpg'],
    }).select('id').single();

    expect(result.data).toEqual({ id: 'line-1' });
    const insert = unsafe.mock.calls.find(([text]) => String(text).startsWith('INSERT'));
    expect(insert).toBeDefined();
    expect(insert?.[1]).toEqual([
      JSON.stringify({ buildKey: 'B-1' }),
      JSON.stringify([{ code: 'SPECIAL' }]),
      ['so/line/photo.jpg'],
    ]);
  });

  test('unexpected statement errors escape the savepoint and abort the command', async () => {
    const unsafe = vi.fn(async (text: string) => {
      if (text.startsWith('UPDATE')) throw new Error('injected write failure');
      return [];
    });
    const sb = pgTransactionSupabase({ unsafe } as unknown as Sql);

    await expect(sb.from('mfg_sales_orders').update({ status: 'BROKEN' }).eq('doc_no', 'SO-1'))
      .rejects.toThrow(/injected write failure/);
    expect(unsafe.mock.calls.some(([text]) => String(text).startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  test('expected voucher-code collisions remain retryable inside the transaction', async () => {
    const unsafe = vi.fn(async (text: string) => {
      if (text.startsWith('INSERT')) throw new Error('duplicate key value violates unique constraint');
      return [];
    });
    const sb = pgTransactionSupabase({ unsafe } as unknown as Sql);

    const result = await sb.from('pwp_codes').insert({ code: 'DUPLICATE' });
    expect(result.error?.message).toMatch(/duplicate key/);
  });
});
