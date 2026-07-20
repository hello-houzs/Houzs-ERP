import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? '';
const enabled = Boolean(url);
const describePg = enabled ? describe : describe.skip;

let admin: Sql;

const migration = (name: string) => readFile(
  fileURLToPath(new URL(`../src/db/migrations-pg/${name}`, import.meta.url)),
  'utf8',
);

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'untrusted_test') THEN
        CREATE ROLE untrusted_test NOLOGIN;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA scm TO service_role;
    GRANT USAGE ON SCHEMA scm TO untrusted_test;

    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY,
      version integer NOT NULL DEFAULT 1,
      note text,
      customer_id uuid
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_no text NOT NULL,
      cancelled boolean NOT NULL DEFAULT false,
      warehouse_id uuid,
      line_delivery_date date,
      line_delivery_date_overridden boolean NOT NULL DEFAULT false
    );
    CREATE TABLE scm.pwp_codes (
      code text PRIMARY KEY,
      source_doc_no text,
      customer_id uuid,
      updated_at timestamptz
    );
    CREATE TABLE scm.mfg_sales_order_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE scm.so_amendments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

    CREATE OR REPLACE FUNCTION scm.upsert_customer_by_name_phone(text, text, text)
    RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  `);
  await sql.unsafe(await migration('0160_scm_so_edit_lease_and_followers.sql'));
  await sql.unsafe(await migration('0161_scm_so_concurrency_domain_closure.sql'));
}

async function callHeaderCas(
  sql: Sql,
  note: string,
  expectedVersion = 1,
  applyWarehouse = false,
) {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE service_role');
    return tx.unsafe<Array<{ applied: boolean; current_version: number; conflict_reason: string | null }>>(
      `SELECT * FROM scm.apply_so_header_cas(
        $1, $2, NULL, $3::jsonb, false, NULL, NULL, NULL, $4, $5::uuid, false, NULL
      )`,
      ['SO-PG-1', expectedVersion, JSON.stringify({ note, version: expectedVersion + 1 }), applyWarehouse, '00000000-0000-0000-0000-000000000001'],
    );
  });
}

describePg('Sales Order PostgreSQL concurrency migration', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 4 });
    await resetFixture(admin);
  });

  afterAll(async () => {
    if (admin) await admin.end();
  });

  test('SECURITY DEFINER function is callable only through its granted service role', async () => {
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, note) VALUES ('SO-PG-1', 'original')`;
    await expect(admin.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE untrusted_test');
      await tx.unsafe(
        `SELECT * FROM scm.apply_so_header_cas(
          $1, 1, NULL, $2::jsonb, false, NULL, NULL, NULL, false, NULL, false, NULL
        )`,
        ['SO-PG-1', JSON.stringify({ note: 'must not land', version: 2 })],
      );
    })).rejects.toThrow(/permission denied/i);
    const result = await callHeaderCas(admin, 'service write');
    expect(result[0]).toMatchObject({ applied: true, current_version: 2, conflict_reason: null });
    const [row] = await admin`SELECT note, version FROM scm.mfg_sales_orders WHERE doc_no = 'SO-PG-1'`;
    expect(row).toMatchObject({ note: 'service write', version: 2 });
  });

  test('two real connections racing at v1 produce exactly one winner and one conflict', async () => {
    await admin`TRUNCATE scm.mfg_sales_orders`;
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, note) VALUES ('SO-PG-1', 'original')`;
    const left = postgres(url, { max: 1 });
    const right = postgres(url, { max: 1 });
    try {
      const results = await Promise.all([
        callHeaderCas(left, 'left'),
        callHeaderCas(right, 'right'),
      ]);
      const outcomes = results.map((rows) => rows[0]?.applied).sort();
      expect(outcomes).toEqual([false, true]);
      const conflict = results.flat().find((row) => !row.applied);
      expect(conflict).toMatchObject({ current_version: 2, conflict_reason: 'version' });
      const [saved] = await admin`SELECT note, version FROM scm.mfg_sales_orders WHERE doc_no = 'SO-PG-1'`;
      expect(['left', 'right']).toContain(saved?.note);
      expect(saved?.version).toBe(2);
    } finally {
      await Promise.all([left.end(), right.end()]);
    }
  });

  test('a follower exception rolls back the already-attempted header update', async () => {
    await admin`TRUNCATE scm.mfg_sales_order_items, scm.mfg_sales_orders`;
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, note) VALUES ('SO-PG-1', 'before failure')`;
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no) VALUES ('SO-PG-1')`;
    await admin.unsafe(`
      CREATE OR REPLACE FUNCTION scm.fail_so_follower() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected follower failure'; END $$;
      CREATE TRIGGER fail_so_follower BEFORE UPDATE ON scm.mfg_sales_order_items
      FOR EACH ROW EXECUTE FUNCTION scm.fail_so_follower();
    `);

    await expect(callHeaderCas(admin, 'must rollback', 1, true)).rejects.toThrow(/injected follower failure/);
    const [saved] = await admin`SELECT note, version FROM scm.mfg_sales_orders WHERE doc_no = 'SO-PG-1'`;
    expect(saved).toMatchObject({ note: 'before failure', version: 1 });
  });
});
