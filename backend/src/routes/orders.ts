import { Hono } from "hono";
import type { Env } from "../types";
import { pushSalesOrder } from "../services/push";
import { DELIVERY_WHERE } from "../services/deliveryFilter";
import { AutoCountClient } from "../services/autocount";

const app = new Hono<{ Bindings: Env }>();

const ORDER_DETAIL_FIELDS = [
  "delivery_date", "time_range", "time_confirmed", "lorry_plate", "driver_name",
  "driver_contact", "days_left", "internal_purchasing", "property_type",
  "new_house_replacement", "item_details", "done_delivery", "consignment_no",
  "eta_port", "estimate_delivery", "m3", "vessel_voyage", "etd_port_klang",
  "eta_destination", "transporter_remarks", "seafreight", "local_charges",
  "inland", "agent_fee", "insurance", "total_cost", "shipout_date",
] as const;

// Allow-listed sortable columns. Keys map frontend Column.key → SQL.
// `od.*` columns require the LEFT JOIN below to stay in place.
const SORT_MAP: Record<string, string> = {
  doc_no: "so.doc_no",
  doc_date: "so.doc_date",
  ref: "so.ref",
  branding: "so.branding",
  debtor_name: "so.debtor_name",
  phone: "so.phone",
  sales_location: "so.sales_location",
  sales_agent: "so.sales_agent",
  region: "so.region",
  local_total: "so.local_total",
  balance: "so.balance",
  remark2: "so.remark2",
  remark3: "so.remark3",
  remark4: "so.remark4",
  processing_date: "so.processing_date",
  expiry_date: "so.expiry_date",
  po_doc_no: "so.po_doc_no",
  venue: "so.venue",
  attention: "so.attention",
  last_modified: "so.last_modified",
  updated_at: "so.updated_at",
  // Joined order_details columns:
  delivery_date: "od.delivery_date",
  time_range: "od.time_range",
  lorry_plate: "od.lorry_plate",
  driver_name: "od.driver_name",
  driver_contact: "od.driver_contact",
  property_type: "od.property_type",
  consignment_no: "od.consignment_no",
  eta_port: "od.eta_port",
  estimate_delivery: "od.estimate_delivery",
  shipout_date: "od.shipout_date",
  warehouse: "od.warehouse",
  state: "od.state",
  order_type: "od.order_type",
  proposed_delivery_date: "od.proposed_delivery_date",
};

// List orders — reads from D1 sales_orders, kept fresh by the */5 cron via
// filtered getSince. The manual "Sync All" button (mode=all) is the only
// thing that calls AutoCount /SalesOrder/getAll directly.
app.get("/", async (c) => {
  const view = c.req.query("view"); // "do" → delivery order filter
  const region = c.req.query("region");
  const status = c.req.query("status");
  const search = c.req.query("search");
  const unscheduled = c.req.query("unscheduled") === "true";
  const warehouseQ = c.req.query("warehouse");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (view === "do") where.push(`(${DELIVERY_WHERE})`);
  if (region) {
    where.push("so.region = ?");
    binds.push(region);
  }
  if (warehouseQ) {
    where.push("od.warehouse = ?");
    binds.push(warehouseQ);
  }
  if (unscheduled) {
    // Exclude orders that are already on a non-cancelled trip OR on a
    // draft proposal — these are "in flight" or "being planned" and
    // shouldn't appear in the dispatcher's planning queue.
    where.push(`NOT EXISTS (
      SELECT 1 FROM trip_stops ts
        JOIN trips t ON t.id = ts.trip_id
       WHERE ts.doc_no = so.doc_no
         AND t.status IN ('assigned','started','in_progress','completed')
    )`);
    where.push(`NOT EXISTS (
      SELECT 1 FROM trip_proposal_trips ptt
        JOIN trip_proposals tp ON tp.id = ptt.proposal_id
       WHERE tp.status = 'draft'
         AND json_extract(ptt.payload_json, '$.stops') LIKE '%"' || so.doc_no || '"%'
    )`);
  }
  if (status) {
    where.push("so.sync_status = ?");
    binds.push(status);
  }
  if (search) {
    where.push("(so.doc_no LIKE ? OR so.debtor_name LIKE ? OR so.phone LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // The COUNT(*) needs the same JOIN whenever filters or sort touch
  // od.* columns (warehouse filter already does). Keeping the join in
  // both queries is harmless and one-line simpler than conditional.
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM sales_orders so
       LEFT JOIN order_details od ON od.doc_no = so.doc_no
       ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = SORT_MAP[sortBy];
  const orderBy = sortExpr
    ? `ORDER BY ${sortExpr} ${sortDir}, so.doc_no DESC`
    : `ORDER BY so.updated_at DESC, so.doc_no DESC`;

  const rows = await c.env.DB.prepare(
    `SELECT so.*, od.delivery_date, od.time_range, od.lorry_plate, od.driver_name,
            od.driver_contact, od.property_type, od.consignment_no, od.eta_port,
            od.estimate_delivery, od.shipout_date,
            od.warehouse, od.state, od.lat, od.lng, od.order_type,
            od.proposed_delivery_date
     FROM sales_orders so
     LEFT JOIN order_details od ON od.doc_no = so.doc_no
     ${whereSql}
     ${orderBy}
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, perPage, offset)
    .all();

  return c.json({
    data: rows.results,
    page,
    per_page: perPage,
    total: total?.count || 0,
  });
});

// Legacy stats endpoint (kept so older clients don't break).
app.get("/stats", async (c) => {
  const byRegion = await c.env.DB.prepare(
    `SELECT region, COUNT(*) as count FROM sales_orders so GROUP BY region`
  ).all();
  const byStatus = await c.env.DB.prepare(
    `SELECT sync_status, COUNT(*) as count FROM sales_orders so GROUP BY sync_status`
  ).all();
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) as total_orders, COALESCE(SUM(balance), 0) as total_balance FROM sales_orders so`
  ).first();
  return c.json({
    by_region: byRegion.results,
    by_status: byStatus.results,
    totals,
  });
});

/**
 * Aggregate over D1 sales_orders. Returns two buckets:
 *   - all      → every row in the table
 *   - delivery → only rows passing DELIVERY_WHERE
 * Used by Overview, Sales Orders, and Delivery Orders dashboards.
 */
app.get("/summary", async (c) => {
  async function bucket(extraWhere: string) {
    const whereSql = extraWhere ? `WHERE ${extraWhere}` : "";

    const totals = await c.env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         COALESCE(SUM(so.balance), 0) as total_balance,
         SUM(CASE WHEN so.balance > 0 THEN 1 ELSE 0 END) as outstanding_count,
         SUM(CASE WHEN so.expiry_date IS NULL OR so.expiry_date = '' THEN 1 ELSE 0 END) as no_expiry,
         SUM(CASE WHEN so.expiry_date IS NOT NULL AND so.expiry_date <> '' AND so.expiry_date < date('now') THEN 1 ELSE 0 END) as expired,
         SUM(CASE WHEN so.expiry_date IS NOT NULL AND so.expiry_date <> '' AND so.expiry_date >= date('now') AND so.expiry_date <= date('now', '+7 days') THEN 1 ELSE 0 END) as expiring_7d
       FROM sales_orders so
       ${whereSql}`
    ).first<any>();

    const byRegion = await c.env.DB.prepare(
      `SELECT region, COUNT(*) as count
       FROM sales_orders so
       ${whereSql}
       GROUP BY region`
    ).all<{ region: string; count: number }>();

    const byStatus = await c.env.DB.prepare(
      `SELECT COALESCE(NULLIF(TRIM(so.remark4), ''), '(none)') as status, COUNT(*) as count
       FROM sales_orders so
       ${whereSql}
       GROUP BY status
       ORDER BY count DESC`
    ).all<{ status: string; count: number }>();

    const region_map: Record<string, number> = { WEST: 0, EAST: 0, SG: 0, OTHER: 0 };
    for (const r of byRegion.results ?? []) {
      region_map[r.region || "OTHER"] = r.count;
    }
    const status_map: Record<string, number> = {};
    for (const r of byStatus.results ?? []) {
      status_map[r.status] = r.count;
    }

    return {
      total: totals?.total || 0,
      by_region: region_map,
      by_status: status_map,
      total_balance: totals?.total_balance || 0,
      outstanding_count: totals?.outstanding_count || 0,
      expired: totals?.expired || 0,
      expiring_7d: totals?.expiring_7d || 0,
      no_expiry: totals?.no_expiry || 0,
    };
  }

  const all = await bucket("");
  const delivery = await bucket(DELIVERY_WHERE);

  const latest = await c.env.DB.prepare(
    `SELECT MAX(last_modified) as latest FROM sales_orders`
  ).first<{ latest: string | null }>();

  return c.json({
    all,
    delivery,
    latest_modified: latest?.latest || null,
    fetched_at: new Date().toISOString(),
  });
});

// Single order
app.get("/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  const order = await c.env.DB.prepare(
    `SELECT * FROM sales_orders WHERE doc_no = ?`
  )
    .bind(docNo)
    .first();
  if (!order) return c.json({ error: "Not found" }, 404);

  const details = await c.env.DB.prepare(
    `SELECT * FROM order_details WHERE doc_no = ?`
  )
    .bind(docNo)
    .first();

  return c.json({ order, details });
});

// Line items for a sales order — pulled live from AutoCount's
// /SalesOrder/getDetail/{docNo}. Returns the raw array of detail rows
// so the frontend can display line-item tables.
app.get("/:docNo/lines", async (c) => {
  const docNo = c.req.param("docNo");
  try {
    const client = new AutoCountClient(c.env);
    const lines = await client.getDetail(docNo);
    return c.json({ lines });
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to fetch line items" }, 502);
  }
});

// Patch sync fields (remark4, expiry_date) → push immediately
app.patch("/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  const body = await c.req.json<{ remark4?: string | null; expiry_date?: string | null }>();

  const sets: string[] = [];
  const binds: any[] = [];
  if ("remark4" in body) {
    sets.push("remark4 = ?");
    binds.push(body.remark4 ?? null);
  }
  if ("expiry_date" in body) {
    sets.push("expiry_date = ?");
    binds.push(body.expiry_date ?? null);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);

  sets.push("updated_at = datetime('now')");
  binds.push(docNo);

  const result = await c.env.DB.prepare(
    `UPDATE sales_orders SET ${sets.join(", ")} WHERE doc_no = ?`
  )
    .bind(...binds)
    .run();

  if (!result.meta.changes) return c.json({ error: "Order not found" }, 404);

  // Real-time push
  const pushResult = await pushSalesOrder(c.env, docNo);
  return c.json({ doc_no: docNo, sync_status: pushResult.status, sync_error: pushResult.error });
});

// Patch order_details (manual + transporter fields)
app.patch("/:docNo/details", async (c) => {
  const docNo = c.req.param("docNo");
  const body = await c.req.json<Record<string, any>>();

  // Validate against allowlist
  const updates: Record<string, any> = {};
  for (const k of ORDER_DETAIL_FIELDS) {
    if (k in body) updates[k] = body[k];
  }
  if (!Object.keys(updates).length) return c.json({ error: "No valid fields" }, 400);

  // Verify the order exists
  const exists = await c.env.DB.prepare(
    `SELECT 1 as ok FROM sales_orders WHERE doc_no = ?`
  )
    .bind(docNo)
    .first();
  if (!exists) return c.json({ error: "Order not found" }, 404);

  // Upsert: insert with all keys, on conflict update only changed
  const cols = Object.keys(updates);
  const placeholders = cols.map(() => "?").join(", ");
  const updateSet = cols.map((c) => `${c} = excluded.${c}`).join(", ");
  const sql = `INSERT INTO order_details (doc_no, ${cols.join(", ")}, updated_at)
               VALUES (?, ${placeholders}, datetime('now'))
               ON CONFLICT(doc_no) DO UPDATE SET ${updateSet}, updated_at = datetime('now')`;
  const binds = [docNo, ...cols.map((k) => updates[k])];

  await c.env.DB.prepare(sql).bind(...binds).run();

  return c.json({ ok: true });
});

export default app;
