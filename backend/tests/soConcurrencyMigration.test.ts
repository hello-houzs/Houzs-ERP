import { describe, expect, test } from 'vitest';
import migration0169 from '../src/db/migrations-pg/0169_scm_so_concurrency_domain_closure.sql?raw';
import migration0170 from '../src/db/migrations-pg/0170_scm_stock_allocation_recompute_queue.sql?raw';

describe('SO concurrency domain migration', () => {
  test('ships the transactional header CAS and payment/amendment row generations together', () => {
    expect(migration0169).toContain('CREATE OR REPLACE FUNCTION scm.apply_so_header_cas');
    expect(migration0169).toContain('FOR UPDATE');
    expect(migration0169).toContain('jsonb_populate_record');
    expect(migration0169).toContain("jsonb_typeof(p_patch) IS DISTINCT FROM 'object'");
    expect(migration0169).toContain('CASE WHEN $1 ?');
    expect(migration0169).toContain('FROM jsonb_populate_record(NULL::scm.mfg_sales_orders, $1) AS p');
    expect(migration0169).not.toContain('jsonb_populate_record(t, $1)');
    expect(migration0169).toContain('mfg_sales_order_payments');
    expect(migration0169).toContain('ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1');
    expect(migration0169).toContain('ALTER TABLE scm.so_amendments');
    expect(migration0169).toContain('REVOKE ALL ON FUNCTION scm.apply_so_header_cas');
  });

  test('allocation retries use a collision-proof generation fence and durable cross-request mutex', () => {
    expect(migration0170).toContain('request_token uuid NOT NULL DEFAULT gen_random_uuid()');
    expect(migration0170).toContain('CREATE TABLE IF NOT EXISTS scm.stock_allocation_recompute_lock');
    expect(migration0170).toContain("VALUES ('GLOBAL')");
    expect(migration0170).toContain('ENABLE ROW LEVEL SECURITY');
  });
});
