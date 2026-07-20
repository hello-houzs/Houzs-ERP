import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";

const pgMigration = Object.values(
  import.meta.glob("../src/db/migrations-pg/0159_*.sql", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
)[0] as string;

function phase2Migration() {
  const migration = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === "128_idempotency_phase2_constraints.sql",
  );
  if (!migration) throw new Error("D1 idempotency Phase-2 migration is missing");
  return migration;
}

async function resetToPhase1(): Promise<void> {
  const statements = [
    `DROP TABLE IF EXISTS __idempotency_phase2_guard`,
    `DROP TABLE IF EXISTS idempotency_keys_phase2`,
    `DROP TABLE IF EXISTS idempotency_keys`,
    `CREATE TABLE idempotency_keys (
      key TEXT NOT NULL,
      scope TEXT NOT NULL,
      user_id INTEGER,
      status_code INTEGER,
      response_body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      tenant_scope TEXT,
      request_hash TEXT,
      PRIMARY KEY (key, scope)
    )`,
    `CREATE INDEX idx_idempotency_keys_created_at
      ON idempotency_keys (created_at)`,
    `INSERT OR REPLACE INTO _migrations (name, applied_at)
     VALUES ('127_idempotency_principal_company_hash.sql', datetime('now', '-26 hours'))`,
    `DELETE FROM app_settings
      WHERE key IN ('rollout.idempotency_phase1_worker_live', 'rollout.idempotency_phase2_offline_bootstrap')`,
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('rollout.idempotency_phase1_worker_live', '{"deployed":true}', datetime('now', '-25 hours'))`,
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}

async function applyPhase2(): Promise<void> {
  for (const query of phase2Migration().queries) {
    await env.DB.prepare(query).run();
  }
}

describe("idempotency Phase-2 migration contract", () => {
  beforeEach(resetToPhase1);

  test("rejects a same-batch Phase-1/Phase-2 rollout before mutating the table", async () => {
    await env.DB.prepare(
      `UPDATE _migrations SET applied_at = datetime('now') WHERE name = ?`,
    )
      .bind("127_idempotency_principal_company_hash.sql")
      .run();
    await env.DB.prepare(
      `UPDATE app_settings SET updated_at = datetime('now') WHERE key = ?`,
    )
      .bind("rollout.idempotency_phase1_worker_live")
      .run();

    await expect(applyPhase2()).rejects.toThrow(/constraint failed/i);

    const columns = await env.DB.prepare(`PRAGMA table_info(idempotency_keys)`).all<{
      name: string;
      notnull: number;
      pk: number;
    }>();
    const tenant = columns.results.find((column) => column.name === "tenant_scope");
    expect(tenant?.notnull).toBe(0);
    expect(columns.results.find((column) => column.name === "key")?.pk).toBe(1);
  });

  test("allows an explicit recent offline-bootstrap marker without a 24-hour wait", async () => {
    await env.DB.prepare(
      `UPDATE _migrations SET applied_at = datetime('now') WHERE name = ?`,
    )
      .bind("127_idempotency_principal_company_hash.sql")
      .run();
    await env.DB.prepare(
      `DELETE FROM app_settings WHERE key = 'rollout.idempotency_phase1_worker_live'`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
    )
      .bind(
        "rollout.idempotency_phase2_offline_bootstrap",
        '{"mode":"offline-bootstrap","old_worker_traffic":"blocked"}',
      )
      .run();

    await applyPhase2();

    const marker = await env.DB.prepare(
      `SELECT key FROM app_settings WHERE key = ?`,
    )
      .bind("rollout.idempotency_phase2_offline_bootstrap")
      .first<{ key: string }>();
    expect(marker).toBeNull();
  });

  test("rejects an offline-bootstrap marker whose proof value is not exact", async () => {
    await env.DB.prepare(
      `UPDATE _migrations SET applied_at = datetime('now') WHERE name = ?`,
    )
      .bind("127_idempotency_principal_company_hash.sql")
      .run();
    await env.DB.prepare(
      `DELETE FROM app_settings WHERE key = 'rollout.idempotency_phase1_worker_live'`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
    )
      .bind(
        "rollout.idempotency_phase2_offline_bootstrap",
        '{"mode":"offline-bootstrap","old_worker_traffic":"unknown"}',
      )
      .run();

    await expect(applyPhase2()).rejects.toThrow(/constraint failed/i);
  });

  test("rejects a legacy NULL claim from the last 24 hours", async () => {
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (key, scope, created_at)
       VALUES ('recent-legacy', 'POST /orders', datetime('now', '-1 hour'))`,
    ).run();

    await expect(applyPhase2()).rejects.toThrow(/constraint failed/i);

    const row = await env.DB.prepare(
      `SELECT key FROM idempotency_keys WHERE key = 'recent-legacy'`,
    ).first<{ key: string }>();
    expect(row?.key).toBe("recent-legacy");
  });

  test("expires stale NULL claims and installs principal/company constraints", async () => {
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (key, scope, created_at)
       VALUES ('stale-legacy', 'POST /orders', datetime('now', '-25 hours'))`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO idempotency_keys
        (key, scope, user_id, status_code, response_body, created_at, tenant_scope, request_hash)
      VALUES
        ('shared-key', 'POST /orders', 7, 201, '{"ok":true}', datetime('now'), 'company:1', 'hash-one')`,
    ).run();

    await applyPhase2();

    const stale = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = 'stale-legacy'`,
    ).first<{ count: number }>();
    expect(stale?.count).toBe(0);

    const columns = await env.DB.prepare(`PRAGMA table_info(idempotency_keys)`).all<{
      name: string;
      notnull: number;
      pk: number;
    }>();
    const byName = new Map(columns.results.map((column) => [column.name, column]));
    expect(byName.get("user_id")).toMatchObject({ notnull: 1, pk: 1 });
    expect(byName.get("tenant_scope")).toMatchObject({ notnull: 1, pk: 2 });
    expect(byName.get("key")).toMatchObject({ notnull: 1, pk: 3 });
    expect(byName.get("scope")).toMatchObject({ notnull: 1, pk: 4 });
    expect(byName.get("request_hash")?.notnull).toBe(1);

    await env.DB.prepare(
      `INSERT INTO idempotency_keys
        (key, scope, user_id, created_at, tenant_scope, request_hash)
       VALUES ('shared-key', 'POST /orders', 8, datetime('now'), 'company:2', 'hash-two')`,
    ).run();
    const scoped = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = 'shared-key'`,
    ).first<{ count: number }>();
    expect(scoped?.count).toBe(2);

    const indexes = await env.DB.prepare(`PRAGMA index_list(idempotency_keys)`).all<{
      name: string;
    }>();
    expect(indexes.results.map((index) => index.name)).toContain(
      "idx_idempotency_keys_created_at",
    );
  });

  test("Postgres migration locks, times out, soaks and replaces the primary key", () => {
    expect(pgMigration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(pgMigration).toContain("SET LOCAL statement_timeout = '60s'");
    expect(pgMigration).toContain(
      "LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE",
    );
    expect(pgMigration).toContain("0158_idempotency_principal_company_hash.sql");
    expect(pgMigration).toContain("interval '24 hours'");
    expect(pgMigration).toContain("rollout.idempotency_phase1_worker_live");
    expect(pgMigration).toContain("interval '24 hours'");
    expect(pgMigration).toContain("rollout.idempotency_phase2_offline_bootstrap");
    expect(pgMigration).toContain("interval '1 hour'");
    expect(pgMigration).toContain("interval '5 minutes'");
    expect(pgMigration).toContain(
      '{"mode":"offline-bootstrap","old_worker_traffic":"blocked"}',
    );
    expect(pgMigration).toContain("old_primary_key_columns <> ARRAY['key', 'scope']");
    expect(pgMigration).toContain(
      "PRIMARY KEY (user_id, tenant_scope, key, scope)",
    );
  });
});
