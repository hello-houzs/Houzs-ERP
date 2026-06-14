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
    test: {
      globals: true,
      setupFiles: ["./tests/setup.ts"],
      // Each suite's setup hook applies the full D1 migration stack; under CI
      // runner contention that occasionally exceeds vitest's 10s default and
      // flakes EVERY suite with "Hook timed out in 10000ms" (deploy.yml also
      // gates on this, so a flake can block a prod deploy). 30s gives ample
      // headroom — local suites run ~7s — and also covers slow tests.
      testTimeout: 30000,
      hookTimeout: 30000,
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
