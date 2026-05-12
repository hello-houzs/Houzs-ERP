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
      poolOptions: {
        workers: {
          // Reuse production wrangler.toml so bindings line up.
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            // Bindings exposed inside tests via `cloudflare:test` `env`.
            // TEST_MIGRATIONS is consumed by setup.ts → applyD1Migrations.
            // DASHBOARD_API_KEY mirrors the auth middleware's
            // service-token escape hatch (see middleware/auth.ts:66) so
            // tests can authenticate as admin without minting sessions.
            bindings: {
              TEST_BASELINE_SQL: baselineSql,
              TEST_MIGRATIONS: migrations,
              DASHBOARD_API_KEY: "test-dashboard-key",
            },
          },
        },
      },
    },
  };
});
