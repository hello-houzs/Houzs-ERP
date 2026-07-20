import { describe, expect, test } from 'vitest';
import migration0161 from '../src/db/migrations-pg/0161_scm_so_concurrency_domain_closure.sql?raw';

describe('SO concurrency domain migration', () => {
  test('ships the transactional header CAS and payment/amendment row generations together', () => {
    expect(migration0161).toContain('CREATE OR REPLACE FUNCTION scm.apply_so_header_cas');
    expect(migration0161).toContain('FOR UPDATE');
    expect(migration0161).toContain('jsonb_populate_record');
    expect(migration0161).toContain('mfg_sales_order_payments');
    expect(migration0161).toContain('ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1');
    expect(migration0161).toContain('ALTER TABLE scm.so_amendments');
    expect(migration0161).toContain('REVOKE ALL ON FUNCTION scm.apply_so_header_cas');
  });
});
