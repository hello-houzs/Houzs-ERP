import { Hono } from "hono";
import type { Env } from "../types";
import { pushSalesOrder } from "../services/push";
import { audit } from "../services/audit";
import { DELIVERY_WHERE } from "../services/deliveryFilter";
import { AutoCountClient } from "../services/autocount";
import { getDb } from "../db/client";
import { sales_orders, order_details } from "../db/schema";
import { eq, sql } from "drizzle-orm";

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
//
// Drizzle conversion note: this handler keeps the broad SELECT so.* +
// od.* shape via Drizzle's `sql` template, since spelling out 30+
// columns in a `db.select({...})` would balloon the file. Filters,
// counts, and patches use the typed query builder so column refs stay
// compiler-checked.
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

  const db = getDb(c.env);

  // FROM aliases the tables as `so` and `od`, so SQLite rejects bare
  // "sales_orders".col / "order_details".col references that Drizzle's
  // column helpers would emit. Build the WHERE with raw sql templates
  // that reference the aliases directly.
  const conds: any[] = [];
  if (view === "do") conds.push(sql`(${sql.raw(DELIVERY_WHERE)})`);
  if (region) conds.push(sql`so.region = ${region}`);
  if (warehouseQ) conds.push(sql`od.warehouse = ${warehouseQ}`);
  if (unscheduled) {
    // Exclude orders that are already on a non-cancelled trip OR on a
    // draft proposal — these are "in flight" or "being planned" and
    // shouldn't appear in the dispatcher's planning queue.
    conds.push(sql`NOT EXISTS (
      SELECT 1 FROM trip_stops ts
        JOIN trips t ON t.id = ts.trip_id
       WHERE ts.doc_no = so.doc_no
         AND t.status IN ('assigned','started','in_progress','completed')
    )`);
    conds.push(sql`NOT EXISTS (
      SELECT 1 FROM trip_proposal_trips ptt
        JOIN trip_proposals tp ON tp.id = ptt.proposal_id
       WHERE tp.status = 'draft'
         AND json_extract(ptt.payload_json, '$.stops') LIKE '%"' || so.doc_no || '"%'
    )`);
  }
  if (status) conds.push(sql`so.sync_status = ${status}`);
  if (search) {
    const likeStr = `%${search}%`;
    conds.push(sql`(so.doc_no LIKE ${likeStr} OR so.debtor_name LIKE ${likeStr} OR so.phone LIKE ${likeStr})`);
  }
  const whereClause = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;

  // The COUNT(*) needs the same JOIN whenever filters or sort touch
  // od.* columns (warehouse filter already does). Keeping the join in
  // both queries is harmless and one-line simpler than conditional.
  const totalRow = await db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
      FROM ${sales_orders} so
      LEFT JOIN ${order_details} od ON od.doc_no = so.doc_no
      ${whereClause}
  `);

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = SORT_MAP[sortBy];
  const orderByClause = sortExpr
    ? sql`ORDER BY ${sql.raw(`${sortExpr} ${sortDir}`)}, so.doc_no DESC`
    : sql`ORDER BY so.updated_at DESC, so.doc_no DESC`;

  const rows = await db.execute<any>(sql`
    SELECT so.*, od.delivery_date, od.time_range, od.lorry_plate, od.driver_name,
           od.driver_contact, od.property_type, od.consignment_no, od.eta_port,
           od.estimate_delivery, od.shipout_date,
           od.warehouse, od.state, od.lat, od.lng, od.order_type,
           od.proposed_delivery_date
      FROM ${sales_orders} so
      LEFT JOIN ${order_details} od ON od.doc_no = so.doc_no
      ${whereClause}
      ${orderByClause}
      LIMIT ${perPage} OFFSET ${offset}
  `);

  return c.json({
    data: rows,
    page,
    per_page: perPage,
    total: totalRow?.count || 0,
  });
});

// Legacy stats endpoint (kept so older clients don't break).
app.get("/stats", async (c) => {
  const db = getDb(c.env);
  const byRegion = await db
    .select({ region: sales_orders.region, count: sql<number>`COUNT(*)` })
    .from(sales_orders)
    .groupBy(sales_orders.region);
  const byStatus = await db
    .select({
      sync_status: sales_orders.sync_status,
      count: sql<number>`COUNT(*)`,
    })
    .from(sales_orders)
    .groupBy(sales_orders.sync_status);
  const totals = await db
    .select({
      total_orders: sql<number>`COUNT(*)`,
      total_balance: sql<number>`COALESCE(SUM(${sales_orders.balance}), 0)`,
    })
    .from(sales_orders);
  return c.json({
    by_region: byRegion,
    by_status: byStatus,
    totals: totals[0],
  });
});

/**
 * Aggregate over D1 sales_orders. Returns two buckets:
 *   - all      → every row in the table
 *   - delivery → only rows passing DELIVERY_WHERE
 * Used by Overview, Sales Orders, and Delivery Orders dashboards.
 */
app.get("/summary", async (c) => {
  const db = getDb(c.env);
  // Date bounds computed in JS and passed as params: this query runs through
  // Drizzle/postgres.js directly (not the env.DB shim), so a SQLite-style
  // date('now', '+7 days') would reach Postgres raw and 500. expiry_date is
  // TEXT, so we compare against 'YYYY-MM-DD' strings.
  const today = new Date().toISOString().slice(0, 10);
  const in7 = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  async function bucket(extraWhere: string) {
    const whereClause = extraWhere ? sql`WHERE ${sql.raw(extraWhere)}` : sql``;

    const totalsRow = await db.get<any>(sql`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(so.balance), 0) as total_balance,
        SUM(CASE WHEN so.balance > 0 THEN 1 ELSE 0 END) as outstanding_count,
        SUM(CASE WHEN so.expiry_date IS NULL OR so.expiry_date = '' THEN 1 ELSE 0 END) as no_expiry,
        SUM(CASE WHEN so.expiry_date IS NOT NULL AND so.expiry_date <> '' AND so.expiry_date < ${today} THEN 1 ELSE 0 END) as expired,
        SUM(CASE WHEN so.expiry_date IS NOT NULL AND so.expiry_date <> '' AND so.expiry_date >= ${today} AND so.expiry_date <= ${in7} THEN 1 ELSE 0 END) as expiring_7d
      FROM ${sales_orders} so
      ${whereClause}
    `);

    const byRegion = await db.execute<{ region: string; count: number }>(sql`
      SELECT region, COUNT(*) as count
        FROM ${sales_orders} so
        ${whereClause}
       GROUP BY region
    `);

    const byStatus = await db.execute<{ status: string; count: number }>(sql`
      SELECT COALESCE(NULLIF(TRIM(so.remark4), ''), '(none)') as status, COUNT(*) as count
        FROM ${sales_orders} so
        ${whereClause}
       GROUP BY status
       ORDER BY count DESC
    `);

    const region_map: Record<string, number> = { WEST: 0, EAST: 0, SG: 0, OTHER: 0 };
    for (const r of byRegion) region_map[r.region || "OTHER"] = r.count;
    const status_map: Record<string, number> = {};
    for (const r of byStatus) status_map[r.status] = r.count;

    return {
      total: totalsRow?.total || 0,
      by_region: region_map,
      by_status: status_map,
      total_balance: totalsRow?.total_balance || 0,
      outstanding_count: totalsRow?.outstanding_count || 0,
      expired: totalsRow?.expired || 0,
      expiring_7d: totalsRow?.expiring_7d || 0,
      no_expiry: totalsRow?.no_expiry || 0,
    };
  }

  const all = await bucket("");
  const delivery = await bucket(DELIVERY_WHERE);

  const latest = await db
    .select({ latest: sql<string | null>`MAX(${sales_orders.last_modified})` })
    .from(sales_orders);

  return c.json({
    all,
    delivery,
    latest_modified: latest[0]?.latest || null,
    fetched_at: new Date().toISOString(),
  });
});

// Flattened per-item list — mirrors GET / but emits one row per line
// item by fanning out to AutoCount's getDetail() per SO on the page.
// Pagination remains by SO (so `total` matches /api/orders); item rows
// expand under each SO. Item-level filtering/sorting is out of scope
// because lines are fetched after the D1 page boundary.
app.get("/items", async (c) => {
  const view = c.req.query("view");
  const region = c.req.query("region");
  const status = c.req.query("status");
  const search = c.req.query("search");
  const unscheduled = c.req.query("unscheduled") === "true";
  const warehouseQ = c.req.query("warehouse");
  const page = parseInt(c.req.query("page") || "1", 10);
  // Cap lower than /api/orders (200) since each row triggers a getDetail call.
  const perPage = Math.min(parseInt(c.req.query("per_page") || "25", 10), 100);
  const offset = (page - 1) * perPage;

  const db = getDb(c.env);

  const conds: any[] = [];
  if (view === "do") conds.push(sql`(${sql.raw(DELIVERY_WHERE)})`);
  if (region) conds.push(sql`so.region = ${region}`);
  if (warehouseQ) conds.push(sql`od.warehouse = ${warehouseQ}`);
  if (unscheduled) {
    conds.push(sql`NOT EXISTS (
      SELECT 1 FROM trip_stops ts
        JOIN trips t ON t.id = ts.trip_id
       WHERE ts.doc_no = so.doc_no
         AND t.status IN ('assigned','started','in_progress','completed')
    )`);
    conds.push(sql`NOT EXISTS (
      SELECT 1 FROM trip_proposal_trips ptt
        JOIN trip_proposals tp ON tp.id = ptt.proposal_id
       WHERE tp.status = 'draft'
         AND json_extract(ptt.payload_json, '$.stops') LIKE '%"' || so.doc_no || '"%'
    )`);
  }
  if (status) conds.push(sql`so.sync_status = ${status}`);
  if (search) {
    const likeStr = `%${search}%`;
    conds.push(sql`(so.doc_no LIKE ${likeStr} OR so.debtor_name LIKE ${likeStr} OR so.phone LIKE ${likeStr})`);
  }
  const whereClause = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;

  const totalRow = await db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
      FROM ${sales_orders} so
      LEFT JOIN ${order_details} od ON od.doc_no = so.doc_no
      ${whereClause}
  `);

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = SORT_MAP[sortBy];
  const orderByClause = sortExpr
    ? sql`ORDER BY ${sql.raw(`${sortExpr} ${sortDir}`)}, so.doc_no DESC`
    : sql`ORDER BY so.updated_at DESC, so.doc_no DESC`;

  const orders = await db.execute<any>(sql`
    SELECT so.*, od.delivery_date, od.time_range, od.lorry_plate, od.driver_name,
           od.driver_contact, od.property_type, od.consignment_no, od.eta_port,
           od.estimate_delivery, od.shipout_date,
           od.warehouse, od.state, od.lat, od.lng, od.order_type,
           od.proposed_delivery_date
      FROM ${sales_orders} so
      LEFT JOIN ${order_details} od ON od.doc_no = so.doc_no
      ${whereClause}
      ${orderByClause}
      LIMIT ${perPage} OFFSET ${offset}
  `);

  const client = new AutoCountClient(c.env);
  const fetch_errors: Array<{ doc_no: string; error: string }> = [];

  const linesByDoc = await Promise.all(
    orders.map(async (o: any) => {
      try {
        const lines = await client.getDetail(o.doc_no);
        return { doc_no: o.doc_no, lines };
      } catch (e: any) {
        fetch_errors.push({ doc_no: o.doc_no, error: e?.message || "fetch failed" });
        return { doc_no: o.doc_no, lines: [] as any[] };
      }
    })
  );
  const lineMap = new Map(linesByDoc.map((x) => [x.doc_no, x.lines]));

  const data: any[] = [];
  let total_items = 0;
  for (const o of orders) {
    const lines = lineMap.get(o.doc_no) || [];
    if (!lines.length) {
      data.push({
        ...o,
        item_line_no: null,
        item_code: null,
        item_description: null,
        item_uom: null,
        item_qty: null,
        item_unit_price: null,
        item_amount: null,
      });
      continue;
    }
    lines.forEach((ln: any, idx: number) => {
      data.push({
        ...o,
        item_line_no: idx + 1,
        item_code: ln.ItemCode ?? null,
        item_description: ln.Description ?? ln.ItemDescription ?? null,
        item_uom: ln.UOM ?? null,
        item_qty: ln.Qty ?? null,
        item_unit_price: ln.UnitPrice ?? null,
        item_amount: ln.Amount ?? null,
      });
      total_items += 1;
    });
  }

  return c.json({
    data,
    page,
    per_page: perPage,
    total: totalRow?.count || 0,
    total_items,
    fetch_errors,
  });
});

// Single order
app.get("/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  const db = getDb(c.env);
  // SELECT * needs to expose every column to the frontend; spread via
  // sql template to avoid manually listing every field of the
  // AutoCount-mirrored row.
  const order = await db.get<any>(
    sql`SELECT * FROM ${sales_orders} WHERE doc_no = ${docNo}`
  );
  if (!order) return c.json({ error: "Not found" }, 404);

  const details = await db.get<any>(
    sql`SELECT * FROM ${order_details} WHERE doc_no = ${docNo}`
  );

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

  const set: Record<string, any> = {};
  if ("remark4" in body) set.remark4 = body.remark4 ?? null;
  if ("expiry_date" in body) set.expiry_date = body.expiry_date ?? null;
  if (Object.keys(set).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }
  set.updated_at = sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')`;

  const db = getDb(c.env);
  const result = await db
    .update(sales_orders)
    .set(set)
    .where(eq(sales_orders.doc_no, docNo));

  if (!result.count) return c.json({ error: "Order not found" }, 404);

  await audit(c, {
    action: "order.update",
    entityType: "order",
    entityId: docNo,
    summary: `Edited order ${docNo}`,
    meta: { changed: Object.keys(set).filter((k) => k !== "updated_at") },
  });

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
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No valid fields" }, 400);
  }

  const db = getDb(c.env);

  // Verify the order exists
  const exists = await db
    .select({ doc_no: sales_orders.doc_no })
    .from(sales_orders)
    .where(eq(sales_orders.doc_no, docNo))
    .limit(1);
  if (exists.length === 0) return c.json({ error: "Order not found" }, 404);

  // Upsert via INSERT … ON CONFLICT DO UPDATE. Drizzle's
  // .onConflictDoUpdate accepts a `set` map and a target column.
  await db
    .insert(order_details)
    .values({ doc_no: docNo, ...updates, updated_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string })
    .onConflictDoUpdate({
      target: order_details.doc_no,
      set: { ...updates, updated_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string },
    });

  return c.json({ ok: true });
});

export default app;
