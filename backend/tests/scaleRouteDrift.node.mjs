import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRoute = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("scale contract remains attached to current production route surfaces", async () => {
  const [soRoute, productRoute, usersRoute] = await Promise.all([
    readRoute("../src/scm/routes/mfg-sales-orders.ts"),
    readRoute("../src/scm/routes/mfg-products.ts"),
    readRoute("../src/routes/users.ts"),
  ]);

  assert.match(soRoute, /mfg_sales_orders_with_payment_totals/);
  assert.match(soRoute, /\.order\(sortCol, \{ ascending: sortAsc \}\)/);
  assert.match(soRoute, /q = q\.range\(page \* pageSize, page \* pageSize \+ pageSize - 1\)/);
  assert.match(soRoute, /\.from\('mfg_sales_order_items'\)/);
  assert.match(productRoute, /\.from\('mfg_products'\)/);
  assert.match(productRoute, /model:product_models\(allowed_options\)/);
  assert.match(productRoute, /return q\.range\(from, to\)/);
  assert.match(usersRoute, /search \? built\.limit\(50\) : built/);
  assert.match(usersRoute, /SELECT string_agg\(ub\.brand, chr\(31\)\)/);
});
