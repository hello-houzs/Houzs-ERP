import { Hono } from "hono";
import type { Env } from "../types";
import { runPOPull, runPODocsPull, pushPODates } from "../services/po";
import { AutoCountClient } from "../services/autocount";
import { getDb } from "../db/client";
import { purchase_orders, purchase_order_docs } from "../db/schema";
import { and, asc, desc, eq, like, lt, or, sql } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

app.get("/summary", async (c) => {
  const db = getDb(c.env);

  // Lines (purchase_orders) — outstanding only, from /getOutstanding.
  const totalsRow = await db.get<any>(sql`
    SELECT COUNT(*) as line_count,
           COUNT(DISTINCT doc_no) as po_count,
           COUNT(DISTINCT creditor_code) as supplier_count,
           COALESCE(SUM(remaining_qty), 0) as remaining_qty
      FROM ${purchase_orders}
  `);

  // Doc-level counts mirror the table's filter semantics. A PO is
  // "outstanding" only when:
  //   • cancelled = 0
  //   • doc_status != 'C'
  //   • AND it has at least one line in purchase_orders (which is
  //     populated from /getOutstanding — already filtered to lines
  //     with Qty - TransferedQty > 0 upstream)
  // Without the line-existence join, a doc whose header is still open
  // but whose lines have all been delivered would inflate the count.
  const docCounts = await db.get<{
    total: number;
    outstanding_count: number;
    delivered_count: number;
    cancelled_count: number;
  }>(sql`
    SELECT COUNT(*) AS total,
           COUNT(CASE
                   WHEN d.cancelled = 0
                    AND COALESCE(d.doc_status, '') != 'C'
                    AND EXISTS (SELECT 1 FROM ${purchase_orders} po WHERE po.doc_no = d.doc_no)
                 THEN 1
                 END) AS outstanding_count,
           COUNT(CASE
                   WHEN d.cancelled = 0
                    AND (d.doc_status = 'C'
                         OR NOT EXISTS (SELECT 1 FROM ${purchase_orders} po WHERE po.doc_no = d.doc_no))
                 THEN 1
                 END) AS delivered_count,
           COUNT(CASE WHEN d.cancelled = 1 THEN 1 END) AS cancelled_count
      FROM ${purchase_order_docs} d
  `);

  const today = new Date().toISOString().slice(0, 10);
  // Overdue = outstanding line past its planned delivery_date. The
  // purchase_orders table already only carries outstanding lines.
  const overdueRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(purchase_orders)
    .where(
      and(
        sql`${purchase_orders.delivery_date} IS NOT NULL`,
        lt(purchase_orders.delivery_date, today)
      )
    );

  const noSupplierDateRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(purchase_orders)
    .where(sql`
      (${purchase_orders.supplier_date1} IS NULL OR ${purchase_orders.supplier_date1} = '')
      AND (${purchase_orders.supplier_date2} IS NULL OR ${purchase_orders.supplier_date2} = '')
      AND (${purchase_orders.supplier_date3} IS NULL OR ${purchase_orders.supplier_date3} = '')
    `);

  const topSuppliers = await db
    .select({
      name: purchase_orders.creditor_name,
      count: sql<number>`COUNT(*)`,
    })
    .from(purchase_orders)
    .where(sql`${purchase_orders.creditor_name} IS NOT NULL`)
    .groupBy(purchase_orders.creditor_name)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(5);

  return c.json({
    totals: {
      ...totalsRow,
      outstanding_count: docCounts?.outstanding_count ?? 0,
      delivered_count: docCounts?.delivered_count ?? 0,
      cancelled_count: docCounts?.cancelled_count ?? 0,
      doc_count: docCounts?.total ?? 0,
    },
    overdue: overdueRow[0]?.count || 0,
    missing_supplier_date: noSupplierDateRow[0]?.count || 0,
    top_suppliers: topSuppliers,
  });
});

// Line-level outstanding view (legacy default).
app.get("/", async (c) => {
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const db = getDb(c.env);

  const conds: any[] = [];
  if (search) {
    const likeStr = `%${search}%`;
    conds.push(
      or(
        like(purchase_orders.doc_no, likeStr),
        like(purchase_orders.creditor_name, likeStr),
        like(purchase_orders.item_code, likeStr)
      )!
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const totalRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(purchase_orders)
    .where(where);

  // SELECT * — pass through every column to the frontend; the AutoCount
  // shape is wide and adding columns to schema.ts every time AutoCount
  // changes its export isn't worth it.
  const rows = await db.execute<any>(sql`
    SELECT * FROM ${purchase_orders}
    ${where ? sql`WHERE ${where}` : sql``}
    ORDER BY doc_no ASC
    LIMIT ${perPage} OFFSET ${offset}
  `);

  return c.json({
    data: rows,
    page,
    per_page: perPage,
    total: totalRow[0]?.count || 0,
  });
});

// Unified PO view. One row per PO header (purchase_order_docs) joined
// with line-level outstanding info from purchase_orders. The outstanding
// filter mirrors the original AutoCount SQL:
//
//   WHERE Cancelled='F' AND DocStatus!='C' AND (Qty-TransferedQty)>0
//
// We can't compute (Qty-TransferedQty)>0 against purchase_order_docs
// alone (header-only), so we use existence in purchase_orders — that
// table is populated from /getOutstanding which already enforces the
// > 0 condition upstream.
app.get("/docs", async (c) => {
  const search = c.req.query("search");
  const status = (c.req.query("status") || "all").toLowerCase();
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const db = getDb(c.env);

  // Build the WHERE conditions referring to the joined `po` aggregate
  // directly via `COALESCE(po.line_count, 0)` instead of the SELECT
  // alias `outstanding_line_count`. Same FROM + JOIN drives both the
  // COUNT and the data query, so we don't need to wrap in a subquery
  // (which previously broke when string-rewriting Drizzle SQL objects).
  const whereParts: any[] = [];
  if (search) {
    const likeStr = `%${search}%`;
    whereParts.push(
      sql`(d.doc_no LIKE ${likeStr} OR d.creditor_name LIKE ${likeStr} OR d.ref LIKE ${likeStr})`
    );
  }
  if (status === "outstanding") {
    whereParts.push(
      sql`d.cancelled = 0 AND COALESCE(d.doc_status,'') != 'C' AND COALESCE(po.line_count, 0) > 0`
    );
  } else if (status === "delivered") {
    whereParts.push(
      sql`d.cancelled = 0 AND (d.doc_status = 'C' OR COALESCE(po.line_count, 0) = 0)`
    );
  } else if (status === "cancelled") {
    whereParts.push(sql`d.cancelled = 1`);
  }
  const whereClause = whereParts.length
    ? sql`WHERE ${sql.join(whereParts, sql` AND `)}`
    : sql``;

  // Shared FROM + JOIN — both COUNT and the data query use this.
  const fromJoin = sql`
    FROM ${purchase_order_docs} d
    LEFT JOIN (
      SELECT doc_no,
             COUNT(*) AS line_count,
             MIN(delivery_date) AS next_delivery,
             SUM(remaining_qty) AS total_remaining_qty
        FROM ${purchase_orders}
       GROUP BY doc_no
    ) po ON po.doc_no = d.doc_no
  `;

  // Allow-list of sortable columns → SQL expression. Keeps `sort_by`
  // safe from injection. References to alias columns
  // (outstanding_line_count, next_delivery) work in ORDER BY because
  // SQLite resolves SELECT aliases there.
  const sortMap: Record<string, string> = {
    doc_no: "d.doc_no",
    doc_date: "d.doc_date",
    ref: "d.ref",
    creditor: "d.creditor_name",
    status: `CASE
               WHEN d.cancelled = 1 THEN 2
               WHEN d.cancelled = 0 AND d.doc_status = 'C' THEN 1
               ELSE 0
             END`,
    local_ex_tax: "d.local_ex_tax",
    final_total: "d.final_total",
    currency_code: "d.currency_code",
    outstanding_lines: "outstanding_line_count",
    next_delivery: "next_delivery",
  };
  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = sortMap[sortBy] || null;
  const orderByClause = sortExpr
    ? sql`ORDER BY ${sql.raw(`${sortExpr} ${sortDir}`)}, d.doc_no DESC`
    : sql`ORDER BY d.doc_date DESC, d.doc_no DESC`;

  const totalRow = await db.get<{ count: number }>(
    sql`SELECT COUNT(*) AS count ${fromJoin} ${whereClause}`
  );

  const rows = await db.execute<any>(sql`
    SELECT d.*,
           COALESCE(po.line_count, 0) AS outstanding_line_count,
           po.next_delivery,
           po.total_remaining_qty
    ${fromJoin}
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

// Single PO doc by number — feeds the dedicated /po/:docNo detail page.
// Same shape as one row from /docs (header + outstanding_line_count +
// next_delivery + total_remaining_qty) so the page can drop straight in.
app.get("/docs/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  const db = getDb(c.env);
  const row = await db.get<any>(sql`
    SELECT d.*,
           COALESCE(po.line_count, 0) AS outstanding_line_count,
           po.next_delivery,
           po.total_remaining_qty
      FROM ${purchase_order_docs} d
      LEFT JOIN (
        SELECT doc_no,
               COUNT(*) AS line_count,
               MIN(delivery_date) AS next_delivery,
               SUM(remaining_qty) AS total_remaining_qty
          FROM ${purchase_orders}
         GROUP BY doc_no
      ) po ON po.doc_no = d.doc_no
     WHERE d.doc_no = ${docNo}
  `);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ data: row });
});

app.get("/lines/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  const db = getDb(c.env);
  const rows = await db.execute<any>(sql`
    SELECT * FROM ${purchase_orders}
     WHERE doc_no = ${docNo}
     ORDER BY item_code ASC
  `);
  return c.json({ data: rows });
});

// Full line-item details for a single PO from AutoCount
// /PurchaseOrder/getDetail. Read-through (no caching) so it always
// reflects the upstream truth — PO line data isn't worth caching.
app.get("/details/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  try {
    const client = new AutoCountClient(c.env);
    const lines = await client.getPODetail(docNo);
    return c.json({ data: lines });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 502);
  }
});

app.post("/pull", async (c) => {
  // Pull both line-level (outstanding) and doc-level (all) in one shot.
  // The two endpoints feed different tables and aren't redundant.
  const [lines, docs] = await Promise.all([
    runPOPull(c.env, "MANUAL").catch((e) => ({ error: e?.message || String(e) })),
    runPODocsPull(c.env, "MANUAL").catch((e) => ({ error: e?.message || String(e) })),
  ]);
  return c.json({ lines, docs });
});

app.patch("/:docNo/:itemCode", async (c) => {
  const docNo = c.req.param("docNo");
  const itemCode = c.req.param("itemCode");
  const me = (c as any).get?.("user");
  const body = await c.req.json<{
    overdue_days?: string | null;
    supplier_date1?: string | null;
    supplier_date2?: string | null;
    supplier_date3?: string | null;
    amount?: number | null;
    unit_price?: number | null;
  }>();

  const allowed = [
    "overdue_days",
    "supplier_date1",
    "supplier_date2",
    "supplier_date3",
  ] as const;
  const set: Record<string, any> = {};
  for (const k of allowed) {
    if (k in body) set[k] = (body as any)[k] ?? null;
  }

  // Money fields are treated as a manual override so the next sync
  // doesn't clobber them. amount_source gets stamped "manual".
  if ("amount" in body || "unit_price" in body) {
    if ("amount" in body) {
      set.amount = body.amount != null ? Number(body.amount) : null;
    }
    if ("unit_price" in body) {
      set.unit_price = body.unit_price != null ? Number(body.unit_price) : null;
    }
    set.amount_source = "manual";
    set.amount_updated_at = new Date().toISOString();
    set.amount_updated_by = me?.id || null;
  }

  if (Object.keys(set).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const db = getDb(c.env);
  const result = await db
    .update(purchase_orders)
    .set(set)
    .where(
      and(
        eq(purchase_orders.doc_no, docNo),
        eq(purchase_orders.item_code, itemCode)
      )
    );

  if (!result.count) return c.json({ error: "PO line not found" }, 404);
  return c.json({ ok: true });
});

app.post("/:docNo/sync-dates", async (c) => {
  const docNo = c.req.param("docNo");
  const result = await pushPODates(c.env, docNo);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
  return c.json({ ok: true });
});

export default app;
