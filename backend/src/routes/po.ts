import { Hono } from "hono";
import type { Env } from "../types";
import { runPOPull, runPODocsPull, pushPODates } from "../services/po";
import { AutoCountClient } from "../services/autocount";

const app = new Hono<{ Bindings: Env }>();

app.get("/summary", async (c) => {
  // Lines (purchase_orders) — outstanding only, from /getOutstanding.
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) as line_count,
            COUNT(DISTINCT doc_no) as po_count,
            COUNT(DISTINCT creditor_code) as supplier_count,
            COALESCE(SUM(remaining_qty), 0) as remaining_qty
     FROM purchase_orders`
  ).first();

  // Doc-level counts mirror the table's filter semantics. A PO is
  // "outstanding" only when:
  //   • cancelled = 0
  //   • doc_status != 'C'
  //   • AND it has at least one line in purchase_orders (which is
  //     populated from /getOutstanding — already filtered to lines
  //     with Qty - TransferedQty > 0 upstream)
  // Without the line-existence join, a doc whose header is still open
  // but whose lines have all been delivered would inflate the count.
  const docCounts = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COUNT(CASE
                    WHEN d.cancelled = 0
                     AND COALESCE(d.doc_status, '') != 'C'
                     AND EXISTS (SELECT 1 FROM purchase_orders po WHERE po.doc_no = d.doc_no)
                  THEN 1
                  END) AS outstanding_count,
            COUNT(CASE
                    WHEN d.cancelled = 0
                     AND (d.doc_status = 'C'
                          OR NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.doc_no = d.doc_no))
                  THEN 1
                  END) AS delivered_count,
            COUNT(CASE WHEN d.cancelled = 1 THEN 1 END) AS cancelled_count
       FROM purchase_order_docs d`
  ).first<{
    total: number;
    outstanding_count: number;
    delivered_count: number;
    cancelled_count: number;
  }>();

  const today = new Date().toISOString().slice(0, 10);
  // Overdue = outstanding line past its planned delivery_date. The
  // purchase_orders table already only carries outstanding lines.
  const overdue = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM purchase_orders
     WHERE delivery_date IS NOT NULL AND delivery_date < ?`
  )
    .bind(today)
    .first<{ count: number }>();

  const noSupplierDate = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM purchase_orders
     WHERE (supplier_date1 IS NULL OR supplier_date1 = '')
       AND (supplier_date2 IS NULL OR supplier_date2 = '')
       AND (supplier_date3 IS NULL OR supplier_date3 = '')`
  ).first<{ count: number }>();

  const topSuppliers = await c.env.DB.prepare(
    `SELECT creditor_name as name, COUNT(*) as count
     FROM purchase_orders
     WHERE creditor_name IS NOT NULL
     GROUP BY creditor_name
     ORDER BY count DESC
     LIMIT 5`
  ).all();

  return c.json({
    totals: {
      ...totals,
      outstanding_count: docCounts?.outstanding_count ?? 0,
      delivered_count: docCounts?.delivered_count ?? 0,
      cancelled_count: docCounts?.cancelled_count ?? 0,
      doc_count: docCounts?.total ?? 0,
    },
    overdue: overdue?.count || 0,
    missing_supplier_date: noSupplierDate?.count || 0,
    top_suppliers: topSuppliers.results,
  });
});

// Line-level outstanding view (legacy default).
app.get("/", async (c) => {
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (search) {
    where.push("(doc_no LIKE ? OR creditor_name LIKE ? OR item_code LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM purchase_orders ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM purchase_orders ${whereSql}
     ORDER BY doc_no ASC
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

  const where: string[] = [];
  const binds: any[] = [];
  if (search) {
    where.push("(d.doc_no LIKE ? OR d.creditor_name LIKE ? OR d.ref LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }
  if (status === "outstanding") {
    where.push(
      "d.cancelled = 0 AND COALESCE(d.doc_status,'') != 'C' AND outstanding_line_count > 0"
    );
  } else if (status === "delivered") {
    // Header marked closed OR no remaining lines, and not cancelled.
    where.push(
      "d.cancelled = 0 AND (d.doc_status = 'C' OR outstanding_line_count = 0)"
    );
  } else if (status === "cancelled") {
    where.push("d.cancelled = 1");
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const baseSelect = `
    SELECT d.*,
           COALESCE(po.line_count, 0) AS outstanding_line_count,
           po.next_delivery,
           po.total_remaining_qty
      FROM purchase_order_docs d
      LEFT JOIN (
        SELECT doc_no,
               COUNT(*) AS line_count,
               MIN(delivery_date) AS next_delivery,
               SUM(remaining_qty) AS total_remaining_qty
          FROM purchase_orders
         GROUP BY doc_no
      ) po ON po.doc_no = d.doc_no
  `;

  // Allow-list of sortable columns → SQL expression. Keeps `sort_by`
  // safe from injection.
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
  const orderBy = sortExpr
    ? `ORDER BY ${sortExpr} ${sortDir}, d.doc_no DESC`
    : `ORDER BY d.doc_date DESC, d.doc_no DESC`;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM (${baseSelect}) sub ${whereSql.replace(/\bd\./g, "sub.")}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM (${baseSelect}) d ${whereSql}
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

// Lines for a single PO doc — used by the side-panel expand on the
// unified PO view to show item codes, supplier dates, etc.
// Single PO doc by number — feeds the dedicated /po/:docNo detail page.
// Same shape as one row from /docs (header + outstanding_line_count +
// next_delivery + total_remaining_qty) so the page can drop straight in.
app.get("/docs/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  const row = await c.env.DB.prepare(
    `SELECT d.*,
            COALESCE(po.line_count, 0) AS outstanding_line_count,
            po.next_delivery,
            po.total_remaining_qty
       FROM purchase_order_docs d
       LEFT JOIN (
         SELECT doc_no,
                COUNT(*) AS line_count,
                MIN(delivery_date) AS next_delivery,
                SUM(remaining_qty) AS total_remaining_qty
           FROM purchase_orders
          GROUP BY doc_no
       ) po ON po.doc_no = d.doc_no
      WHERE d.doc_no = ?`
  )
    .bind(docNo)
    .first();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ data: row });
});

app.get("/lines/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  const rows = await c.env.DB.prepare(
    `SELECT * FROM purchase_orders WHERE doc_no = ? ORDER BY item_code ASC`
  )
    .bind(docNo)
    .all();
  return c.json({ data: rows.results });
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

  const allowed = ["overdue_days", "supplier_date1", "supplier_date2", "supplier_date3"] as const;
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push((body as any)[k] ?? null);
    }
  }

  // Money fields are treated as a manual override so the next sync
  // doesn't clobber them. amount_source gets stamped "manual".
  if ("amount" in body || "unit_price" in body) {
    if ("amount" in body) {
      sets.push("amount = ?");
      binds.push(body.amount != null ? Number(body.amount) : null);
    }
    if ("unit_price" in body) {
      sets.push("unit_price = ?");
      binds.push(body.unit_price != null ? Number(body.unit_price) : null);
    }
    sets.push("amount_source = ?");
    binds.push("manual");
    sets.push("amount_updated_at = ?");
    binds.push(new Date().toISOString());
    sets.push("amount_updated_by = ?");
    binds.push(me?.id || null);
  }

  if (!sets.length) return c.json({ error: "No fields to update" }, 400);

  binds.push(docNo, itemCode);
  const res = await c.env.DB.prepare(
    `UPDATE purchase_orders SET ${sets.join(", ")} WHERE doc_no = ? AND item_code = ?`
  )
    .bind(...binds)
    .run();

  if (!res.meta.changes) return c.json({ error: "PO line not found" }, 404);
  return c.json({ ok: true });
});

app.post("/:docNo/sync-dates", async (c) => {
  const docNo = c.req.param("docNo");
  const result = await pushPODates(c.env, docNo);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
  return c.json({ ok: true });
});

export default app;
