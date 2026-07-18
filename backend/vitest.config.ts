import fs from "node:fs/promises";
import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// Wires vitest into the Cloudflare Workers runtime. Each test file gets
// its own isolated D1 instance with the same schema as production
// (schema.sql baseline + migrations under src/db/migrations applied at
// suite setup time).
export default defineWorkersConfig(async () => {
  // wrangler.toml now carries the [[hyperdrive]] binding (Supabase cutover).
  // Parsing it locally demands an emulation connection string — provide a
  // dummy so config parse succeeds. Tests never connect through it:
  // resolveDatabaseUrl prefers the DATABASE_URL="" pinned below, which keeps
  // the whole suite on the isolated D1.
  process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??=
    "postgresql://test:test@127.0.0.1:5432/test";
  const migrationsPath = path.join(__dirname, "src/db/migrations");
  const migrations = await readD1Migrations(migrationsPath);
  // schema.sql is the legacy baseline (sales_orders, order_details,
  // etc.) that the numbered migrations assume already exists.
  const baselineSql = await fs.readFile(
    path.join(__dirname, "src/db/schema.sql"),
    "utf8",
  );

  return {
    // Vitest uses Vite to load modules and does NOT read tsconfig "paths", so
    // the @shared/* alias (resolved by esbuild at deploy + tsc at typecheck)
    // must be declared here too, or every suite that imports an scm route
    // fails with "Failed to load url @shared/...".
    resolve: {
      alias: { "@shared": path.resolve(__dirname, "../shared") },
    },
    test: {
      globals: true,
      setupFiles: ["./tests/setup.ts"],
      // The shared workerd module-fetch + D1 migration setup runs in the
      // suite hook; under CI runner contention it can take ~400s, which blew
      // past the previous 30s and flaked EVERY suite at once with an identical
      // "Hook timed out in 30000ms" (0 assertions fail — tests never collect).
      // deploy.yml gates on this, so a flake blocks a prod deploy and forced a
      // manual `gh run rerun --failed` on the #337 deploy. 180s covers the
      // slow cold setup without masking real failures — a genuinely broken
      // test still fails its assertion well under 60s. Local suites run ~7s.
      testTimeout: 60000,
      hookTimeout: 180000,
      // POOL SIZE IS PINNED because this suite collapses at full concurrency,
      // and it does so WITHOUT a single failing assertion — the signature is
      // 50-65 of 66 files "failed", zero `AssertionError`, zero `error TS####`,
      // and 100+ `[vitest-worker]: Timeout calling "onTaskUpdate"`. That RPC
      // timeout means the worker could not reach the main thread, not that the
      // code under test is wrong; every one of those files passes when run on
      // its own.
      //
      // It is a CAPACITY CLIFF, not a random flake, and the suite walked off it
      // by growing. Measured on 2026-07-18: at 63 test files the suite passed;
      // at 65 (main) it passed 11 of 12 deploys; at 66 — the file count after
      // tests/entityAudit.test.ts landed — it failed 5 of 5 runs on the same
      // commit. Each file gets its own workerd isolate, so an unbounded pool
      // scales isolates with CPU count and starves the main thread that is
      // meant to be servicing their RPC.
      //
      // The previous mitigation for this same class was raising hookTimeout to
      // 180s (see above). That bought two more test files. A longer timeout
      // does not help once the main thread is the bottleneck, so bound the
      // concurrency instead. 2 keeps CI green with headroom to grow; raise it
      // only with a green full-suite run to back the new number.
      maxWorkers: 2,
      minWorkers: 1,
      poolOptions: {
        workers: {
          // Reuse production wrangler.toml so bindings line up.
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            // Isolated test D1 for `env.DB`. Declared here (not inherited from
            // wrangler.toml) so the prod [[d1_databases]] binding can be removed
            // for the D1 write-lockout without breaking the suite.
            d1Databases: ["DB"],
            // Isolated KV for SESSION_CACHE so rate-limit + session-cache tests
            // exercise the real KV path instead of the fail-open fallback.
            kvNamespaces: ["SESSION_CACHE"],
            // Bindings exposed inside tests via `cloudflare:test` `env`.
            // TEST_MIGRATIONS is consumed by setup.ts → applyD1Migrations.
            // DASHBOARD_API_KEY mirrors the auth middleware's
            // service-token escape hatch (see middleware/auth.ts:66) so
            // tests can authenticate as admin without minting sessions.
            bindings: {
              TEST_BASELINE_SQL: baselineSql,
              TEST_MIGRATIONS: migrations,
              DASHBOARD_API_KEY: "test-dashboard-key",
              // Pin empty so the suite can never pick up a real Supabase URL
              // from .dev.vars and run tests against the live database. The
              // dbInject middleware falls back to the isolated D1 above.
              DATABASE_URL: "",
            },
          },
        },
      },
    },
  };
});
