import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  PG_QUERY_SHAPES,
  PG_REAL_SCHEMA_DDL,
  SO_LIST_COLUMNS,
  pgSeedSql,
} from "../scripts/scale-pg-real-schema.mjs";

test("uses production relation names, payment view and hot indexes, never perf_* lookalikes", () => {
  assert.doesNotMatch(PG_REAL_SCHEMA_DDL, /\bperf_(users|skus|orders|order_lines)\b/);
  for (const relation of [
    "public.users",
    "public.user_companies",
    "scm.mfg_products",
    "scm.mfg_sales_orders",
    "scm.mfg_sales_order_items",
    "scm.mfg_sales_order_payments",
    "scm.mfg_sales_orders_with_payment_totals",
  ]) assert.match(PG_REAL_SCHEMA_DDL, new RegExp(relation.replaceAll(".", "\\.")));
  for (const index of [
    "idx_scm_mfg_so_company_so_date",
    "idx_scm_mfg_so_items_doc_no",
    "trgm_mfg_so_debtor_name",
    "trgm_mfg_prod_code",
    "trgm_users_name",
  ]) assert.match(PG_REAL_SCHEMA_DDL, new RegExp(index));
  assert.match(PG_REAL_SCHEMA_DDL, /sum\(amount_centi\).*paid_total/s);
});

test("seeds requested cardinality for each of two tenants", () => {
  const seed = pgSeedSql({ orders: 100_000, lines: 100_000, skus: 10_000, users: 10_000 });
  assert.equal(seed.match(/generate_series\(1, 100000\) g/g)?.length, 3);
  assert.match(seed, /INSERT INTO scm\.mfg_sales_orders[\s\S]*generate_series\(1, 100000\) g/);
  assert.match(seed, /INSERT INTO scm\.mfg_sales_order_items[\s\S]*generate_series\(1, 100000\) g/);
  assert.equal(seed.match(/generate_series\(1, 10000\) g/g)?.length, 2);
  assert.ok((seed.match(/generate_series\(1, 2\) company_id/g)?.length ?? 0) >= 5);
  assert.match(seed, /ANALYZE scm\.mfg_sales_orders/);
});

test("pins heavy route query shapes and wide SO list projection", () => {
  assert.ok(SO_LIST_COLUMNS.split(", ").length > 75);
  assert.match(PG_QUERY_SHAPES.so_list_page, /scm\.mfg_sales_orders_with_payment_totals/);
  assert.match(PG_QUERY_SHAPES.so_list_page, /company_id = \$1[\s\S]*ORDER BY so_date DESC, doc_no DESC[\s\S]*LIMIT \$2 OFFSET \$3/);
  assert.match(PG_QUERY_SHAPES.so_search_page, /debtor_name ILIKE \$2[\s\S]*phone ILIKE \$2/);
  assert.match(PG_QUERY_SHAPES.so_detail_lines, /scm\.mfg_sales_order_items/);
  assert.match(PG_QUERY_SHAPES.products_page, /scm\.mfg_products[\s\S]*product_models[\s\S]*LIMIT 1000 OFFSET \$2/);
  assert.match(PG_QUERY_SHAPES.users_typeahead, /FROM public\.users u/);
  assert.match(PG_QUERY_SHAPES.users_typeahead, /string_agg[\s\S]*array_agg[\s\S]*LIMIT 50/);
  assert.match(PG_QUERY_SHAPES.users_typeahead, /company_ids_arr/);
  assert.doesNotMatch(PG_QUERY_SHAPES.users_full_list, /LIMIT|WHERE EXISTS/);
  assert.match(PG_QUERY_SHAPES.users_full_list, /LEFT JOIN public\.users m[\s\S]*LEFT JOIN public\.users ib/);
});

test("pagination correctness uses the real SO doc_no key when the list has no id", async () => {
  const harness = await readFile(new URL("../scripts/scale-harness.mjs", import.meta.url), "utf8");
  assert.match(harness, /row\.id \?\? row\.doc_no/);
  assert.match(harness, /pagination row has no id or doc_no identity/);
});

test("PR CI executes and retains the full 100k PostgreSQL evidence run", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /scale-postgres-contract:[\s\S]*if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /--orders=100000 --lines=100000 --skus=10000 --users=10000 --runs=20/);
  assert.match(workflow, /--json=artifacts\/scale-pg-100k\.json/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4[\s\S]*if-no-files-found: error/);
});

// The backend suite is sharded across four runners with
// `npm test -- --shard=i/n` (see ci.yml). npm appends run arguments to the LAST
// command in the script, so any `&&` chain inside `test` sends `--shard` to the
// wrong binary and leaves vitest unsharded — four runners each executing the
// whole 112-file suite, green, at roughly 2.5x the wall time sharding was
// introduced to remove. This runs as `pretest` for exactly that reason.
test("backend test script stays a single command so CI sharding still reaches vitest", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.scripts.test, "vitest run");
  assert.equal(pkg.scripts.pretest, "npm run test:scale-contract");
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(
    workflow,
    /npm test -- --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/,
  );
});
