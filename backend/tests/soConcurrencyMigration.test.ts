import { describe, expect, test } from 'vitest';
import migration0161 from '../src/db/migrations-pg/0161_scm_so_concurrency_domain_closure.sql?raw';
import migration0162 from '../src/db/migrations-pg/0162_scm_stock_allocation_recompute_queue.sql?raw';

describe('SO concurrency domain migration', () => {
  test('ships the transactional header CAS and payment/amendment row generations together', () => {
    expect(migration0161).toContain('CREATE OR REPLACE FUNCTION scm.apply_so_header_cas');
    expect(migration0161).toContain('FOR UPDATE');
    expect(migration0161).toContain('jsonb_populate_record');
    expect(migration0161).toContain("jsonb_typeof(p_patch) IS DISTINCT FROM 'object'");
    expect(migration0161).toContain('CASE WHEN $1 ?');
    expect(migration0161).toContain('FROM jsonb_populate_record(NULL::scm.mfg_sales_orders, $1) AS p');
    expect(migration0161).not.toContain('jsonb_populate_record(t, $1)');
    expect(migration0161).toContain('mfg_sales_order_payments');
    expect(migration0161).toContain('ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1');
    expect(migration0161).toContain('ALTER TABLE scm.so_amendments');
    expect(migration0161).toContain('REVOKE ALL ON FUNCTION scm.apply_so_header_cas');
  });

  test('allocation retries use a collision-proof generation fence and durable cross-request mutex', () => {
    expect(migration0162).toContain('request_token uuid NOT NULL DEFAULT gen_random_uuid()');
    expect(migration0162).toContain('CREATE TABLE IF NOT EXISTS scm.stock_allocation_recompute_lock');
    expect(migration0162).toContain("VALUES ('GLOBAL')");
    expect(migration0162).toContain('ENABLE ROW LEVEL SECURITY');
  });
});
