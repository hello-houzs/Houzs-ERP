import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

declare module "cloudflare:test" {
  // Surface the test-only bindings so TypeScript stops complaining.
  // Both are injected by vitest.config.ts at pool startup.
  interface ProvidedEnv {
    TEST_BASELINE_SQL: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
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
  // Per-query loop so we can tolerate baseline overlaps mid-file.
  for (const mig of env.TEST_MIGRATIONS) {
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
