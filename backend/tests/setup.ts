import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

declare module "cloudflare:test" {
  // Surface the test-only bindings so TypeScript stops complaining.
  // Both are injected by vitest.config.ts at pool startup.
  interface ProvidedEnv {
    TEST_BASELINE_SQL: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers/config").D1Migration[];
    DASHBOARD_API_KEY: string;
  }
}

/**
 * Production uses a hybrid schema-management pattern: `schema.sql`
 * was snapshotted at some point, and incremental migrations build on
 * top of it. The migration tracker on remote D1 has the pre-snapshot
 * ones marked as "applied" via `db:migrate --baseline` so they're
 * never re-run.
 *
 * For tests we rebuild from a clean D1, which means we apply both:
 * `schema.sql` (the baseline) PLUS every migration file from scratch.
 * That replays migrations whose effects are already in `schema.sql`,
 * so we swallow predictable errors:
 *   - "duplicate column"     — ALTER TABLE ADD COLUMN already in baseline
 *   - "already exists"       — CREATE TABLE/INDEX already in baseline
 *
 * Anything else still throws so a real bug doesn't get masked.
 */
beforeAll(async () => {
  // exec() runs multi-statement raw SQL — perfect for schema.sql.
  await env.DB.exec(
    env.TEST_BASELINE_SQL.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim(),
  );
  // Production's D1 runner creates this tracker before applying files. Phase 2
  // deliberately requires Phase 1 to have soaked for 24 hours, so the clean
  // test database models that precondition instead of bypassing the SQL gate.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ).run();
  // Resolved by suffix, never by number: migration numbers here are assigned at
  // merge time against whatever main looks like that minute, so a literal goes
  // stale without anything failing.
  const phase1Name = env.TEST_MIGRATIONS.map((m) => m.name).find((name) =>
    name.endsWith("_idempotency_principal_company_hash.sql"),
  );
  if (!phase1Name) throw new Error("D1 idempotency Phase-1 migration is missing");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO _migrations (name, applied_at)
     VALUES (?, datetime('now', '-26 hours'))`,
  )
    .bind(phase1Name)
    .run();
  // Per-query loop so we can tolerate baseline overlaps mid-file.
  for (const mig of env.TEST_MIGRATIONS) {
    if (mig.name.endsWith("_idempotency_phase2_constraints.sql")) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
         VALUES ('rollout.idempotency_phase1_worker_live', '{"deployed":true}', datetime('now', '-25 hours'))`,
      ).run();
    }
    for (const q of mig.queries) {
      const sql = q.trim();
      if (!sql) continue;
      try {
        await env.DB.prepare(sql).run();
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? "");
        if (
          msg.includes("duplicate column") ||
          msg.includes("already exists")
        ) {
          continue;
        }
        throw new Error(`Migration ${mig.name} failed on:\n${sql}\n→ ${msg}`);
      }
    }
  }
});
