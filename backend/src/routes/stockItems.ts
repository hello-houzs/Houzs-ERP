import { Hono } from "hono";
import type { Env } from "../types";
import { runStockItemsRefresh } from "../services/stockItems";

/**
 * Retained headless after the strip-to-core cutover ONLY for the ASSR
 * By-Creditor "Refresh from AutoCount" button, which calls
 * POST /api/stockitems/refresh. The item_code -> main_supplier (creditor)
 * resolution itself runs server-side inside the ASSR service
 * (stockItems.resolveCreditorForCase), not over HTTP.
 */
const app = new Hono<{ Bindings: Env }>();

app.post("/refresh", async (c) => {
  let body: { item_codes?: string[] } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine — refresh everything
  }
  const result = await runStockItemsRefresh(c.env, { itemCodes: body.item_codes });
  return c.json(result);
});

export default app;
