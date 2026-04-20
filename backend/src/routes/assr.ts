import { Hono } from "hono";
import type { Env } from "../types";
import {
  createAssrCase,
  getAssrDetail,
  transitionStage,
  patchAssrCase,
  listAssrCases,
  exportAssrCases,
  issueSurveyToken,
  lookupSOItems,
  addItems,
  removeItem,
  assrAttachmentKey,
  saveAttachment,
  createLogistics,
  patchLogistics,
  logActivity,
  nextServicePONumber,
} from "../services/assr";
import { runSlaEscalation } from "../services/assrEscalation";
import { issueStaffToken } from "../services/caseTracking";
import { sendEmail, publicUrl } from "../services/email";
import { AutoCountClient } from "../services/autocount";

const app = new Hono<{ Bindings: Env }>();

// ── Module-level settings (default assignee) ──────────────────
//
// Stored in `system_settings` under key `assr_default_assignee_id`.
// Read on each create_case call so changes take effect immediately
// without a deploy.

app.get("/settings", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT s.value AS value, u.id AS user_id, u.name AS user_name, u.email AS user_email
       FROM system_settings s
       LEFT JOIN users u ON CAST(s.value AS INTEGER) = u.id
      WHERE s.key = 'assr_default_assignee_id'`
  ).first<{
    value: string | null;
    user_id: number | null;
    user_name: string | null;
    user_email: string | null;
  }>();
  return c.json({
    default_assignee_id: row?.user_id ?? null,
    default_assignee_name: row?.user_name ?? null,
    default_assignee_email: row?.user_email ?? null,
  });
});

app.put("/settings", async (c) => {
  const body = await c.req.json<{ default_assignee_id?: number | null }>();
  const id = body.default_assignee_id;
  if (id === null || id === undefined) {
    await c.env.DB.prepare(
      `DELETE FROM system_settings WHERE key = 'assr_default_assignee_id'`
    ).run();
  } else {
    if (typeof id !== "number" || isNaN(id)) {
      return c.json({ error: "default_assignee_id must be a number or null" }, 400);
    }
    // INSERT OR REPLACE so we don't care whether the row exists yet.
    await c.env.DB.prepare(
      `INSERT INTO system_settings (key, value) VALUES ('assr_default_assignee_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
      .bind(String(id))
      .run();
  }
  return c.json({ ok: true });
});

// ── Cost auto-fill suggestion ─────────────────────────────────
//
// Looks up the case's item_code in (a) the linked sales order's lines,
// and (b) the linked purchase order's lines. Returns the unit-price ×
// qty for each side so the frontend can offer to populate
// customer_amount and po_amount in one click. The user can still edit
// after — this is a suggestion, not a write.

app.get("/:id/cost-suggestion", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const caseRow = await c.env.DB.prepare(
    `SELECT doc_no, po_no, item_code FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ doc_no: string | null; po_no: string | null; item_code: string | null }>();
  if (!caseRow) return c.json({ error: "Not found" }, 404);

  const itemCode = (caseRow.item_code || "").trim();
  if (!itemCode) {
    return c.json({
      customer_amount: null,
      po_amount: null,
      sources: { so: null, po: null },
      reason: "Case has no item_code — set one before auto-filling.",
    });
  }

  // ── Sales order lookup (revenue side) ──────────────────────────
  // SO line detail isn't cached in D1; fetch live from AutoCount.
  let customerAmount: number | null = null;
  let soSource: { doc_no: string; unit_price: number; qty: number } | null = null;
  if (caseRow.doc_no) {
    try {
      const client = new AutoCountClient(c.env);
      const lines = await client.getDetail(caseRow.doc_no);
      const match = matchLine(lines as any[], itemCode);
      if (match) {
        const qty = num((match as any).Qty) ?? 1;
        const price = num((match as any).UnitPrice) ?? 0;
        const amount = num((match as any).Amount) ?? qty * price;
        customerAmount = amount;
        soSource = { doc_no: caseRow.doc_no, unit_price: price, qty };
      }
    } catch (e: any) {
      console.warn(`[assr.cost-suggestion] SO lookup failed for ${caseRow.doc_no}:`, e?.message || e);
    }
  }

  // ── Purchase order lookup (supplier cost side) ─────────────────
  let poAmount: number | null = null;
  let poSource: { doc_no: string; unit_price: number; qty: number } | null = null;
  if (caseRow.po_no) {
    // PO line table is purchase_orders (one row per outstanding line),
    // keyed by (doc_no, item_code). Pull the matching line.
    const poRow = await c.env.DB.prepare(
      `SELECT remaining_qty AS qty,
              ordered_qty   AS ord_qty,
              unit_price    AS price
         FROM purchase_orders
        WHERE doc_no = ? AND item_code = ?
        LIMIT 1`
    )
      .bind(caseRow.po_no, itemCode)
      .first<{ qty: number | null; ord_qty: number | null; price: number | null }>();
    if (poRow && poRow.price != null) {
      const qty = poRow.ord_qty ?? poRow.qty ?? 1;
      poAmount = qty * poRow.price;
      poSource = { doc_no: caseRow.po_no, unit_price: poRow.price, qty };
    }
  }

  return c.json({
    customer_amount: customerAmount,
    po_amount: poAmount,
    sources: { so: soSource, po: poSource },
  });
});

// ── Summary ───────────────────────────────────────────────────

app.get("/summary", async (c) => {
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM assr_cases`
  ).first<{ total: number }>();

  const byStage = await c.env.DB.prepare(
    `SELECT stage, COUNT(*) as count FROM assr_cases GROUP BY stage`
  ).all();

  const byStatus = await c.env.DB.prepare(
    `SELECT status, COUNT(*) as count FROM assr_cases GROUP BY status`
  ).all();

  const byLocation = await c.env.DB.prepare(
    `SELECT location, COUNT(*) as count FROM assr_cases
     WHERE location IS NOT NULL
     GROUP BY location ORDER BY count DESC LIMIT 5`
  ).all();

  const byCategory = await c.env.DB.prepare(
    `SELECT service_category as name, COUNT(*) as count FROM assr_cases
     WHERE service_category IS NOT NULL
     GROUP BY service_category ORDER BY count DESC LIMIT 5`
  ).all();

  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM assr_cases
     WHERE complained_date IS NOT NULL
       AND complained_date >= date('now', '-30 days')`
  ).first<{ count: number }>();

  // Aging: cases still open that have been in their current stage >3 days
  const aging = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM assr_cases c
      WHERE c.stage != 'closed'
        AND julianday('now') - julianday(
              COALESCE(
                (SELECT MAX(a.created_at)
                   FROM assr_activity a
                  WHERE a.assr_id = c.id
                    AND a.action = 'stage_change'
                    AND a.to_value = c.stage),
                c.created_at
              )
            ) > 3`
  ).first<{ count: number }>();

  // SLA breach: open cases past their deadline.
  const breach = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM assr_cases
      WHERE stage != 'closed'
        AND deadline_at IS NOT NULL
        AND datetime('now') > deadline_at`
  ).first<{ count: number }>();

  return c.json({
    total: totals?.total || 0,
    by_stage: byStage.results,
    by_status: byStatus.results,
    by_location: byLocation.results,
    by_category: byCategory.results,
    recent_30d: recent?.count || 0,
    aging_count: aging?.count || 0,
    breach_count: breach?.count || 0,
  });
});

// ── List ──────────────────────────────────────────────────────

app.get("/", async (c) => {
  const assignedToParam = c.req.query("assigned_to");
  const result = await listAssrCases(c.env, {
    stage: c.req.query("stage"),
    status: c.req.query("status"),
    search: c.req.query("search"),
    assigned_to: assignedToParam ? parseInt(assignedToParam, 10) : undefined,
    creditor_code: c.req.query("creditor_code") || undefined,
    page: parseInt(c.req.query("page") || "1", 10),
    per_page: parseInt(c.req.query("per_page") || "50", 10),
    include_archived: c.req.query("include_archived") === "1",
    sort_by: c.req.query("sort_by") || undefined,
    sort_dir: (c.req.query("sort_dir") || "").toLowerCase() === "asc" ? "asc" : "desc",
  });
  return c.json(result);
});

// Manually re-run the item → creditor lookup for a single case.
// Useful for backfilling existing cases whose creditor_code is null
// (e.g. cases created before the auto-resolve hook shipped).
app.post("/:id/resolve-creditor", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT item_code FROM assr_cases WHERE id = ? AND archived_at IS NULL`
  )
    .bind(id)
    .first<{ item_code: string | null }>();
  if (!row) return c.json({ error: "Case not found" }, 404);
  if (!row.item_code)
    return c.json({ error: "Case has no item_code — set one first" }, 400);

  try {
    const { resolveCreditorForCase } = await import("../services/stockItems");
    const creditorCode = await resolveCreditorForCase(c.env, id, row.item_code);
    return c.json({
      ok: true,
      item_code: row.item_code,
      creditor_code: creditorCode,
      message: creditorCode
        ? `Resolved ${row.item_code} → ${creditorCode}`
        : `${row.item_code} has no MainSupplier in AutoCount`,
    });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 502);
  }
});

// ── Cases grouped by creditor ────────────────────────────────
// Feeds the "By Creditor" tab. One row per creditor_code with open /
// closed / breached counts, joined to the creditors mirror for the
// display name. Null creditor_code (unresolved) rolls up into a
// separate `unassigned` bucket so the caller can surface it.
app.get("/by-creditor", async (c) => {
  const search = (c.req.query("search") || "").trim();
  const like = search ? `%${search}%` : null;

  const rowsQ = c.env.DB.prepare(
    `SELECT c.creditor_code,
            cr.company_name AS creditor_name,
            cr.email        AS email,
            cr.phone1       AS phone,
            COUNT(*) AS total,
            SUM(CASE WHEN c.stage != 'closed' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN c.stage  = 'closed' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN c.stage != 'closed'
                      AND c.deadline_at IS NOT NULL
                      AND datetime('now') > c.deadline_at THEN 1 ELSE 0 END) AS breached,
            MAX(c.updated_at) AS last_activity_at
       FROM assr_cases c
       LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
      WHERE c.archived_at IS NULL
        AND c.creditor_code IS NOT NULL
        ${like ? "AND (cr.company_name LIKE ? OR c.creditor_code LIKE ?)" : ""}
      GROUP BY c.creditor_code
      ORDER BY total DESC, creditor_name ASC`
  );
  const rows = like
    ? await rowsQ.bind(like, like).all()
    : await rowsQ.all();

  const unassigned = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN stage != 'closed' THEN 1 ELSE 0 END) AS open
       FROM assr_cases
      WHERE archived_at IS NULL AND (creditor_code IS NULL OR creditor_code = '')`
  ).first<{ total: number; open: number }>();

  return c.json({
    rows: rows.results ?? [],
    unassigned: {
      total: unassigned?.total ?? 0,
      open: unassigned?.open ?? 0,
    },
  });
});

// ── Bulk actions ──────────────────────────────────────────────
// Operate on a list of case IDs in one request. Each item is best-effort:
// failures are collected per-id rather than aborting the batch, so a stale
// row in the selection (e.g. someone else just archived it) doesn't kill
// the rest. Returns counts + per-id errors so the UI can show a useful
// summary toast.

async function bulkRun(
  ids: number[],
  fn: (id: number) => Promise<void>
): Promise<{ ok: number; failed: { id: number; error: string }[] }> {
  let ok = 0;
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    try {
      await fn(id);
      ok++;
    } catch (e: any) {
      failed.push({ id, error: e?.message || String(e) });
    }
  }
  return { ok, failed };
}

app.post("/bulk/archive", async (c) => {
  const userId = (c as any).get?.("userId") ?? null;
  const body = await c.req.json<{ ids?: number[] }>();
  const ids = (body.ids || []).filter((n) => Number.isInteger(n));
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const result = await bulkRun(ids, async (id) => {
    await c.env.DB.prepare(
      `UPDATE assr_cases
          SET archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL`
    )
      .bind(userId, id)
      .run();
  });
  return c.json(result);
});

app.post("/bulk/unarchive", async (c) => {
  const body = await c.req.json<{ ids?: number[] }>();
  const ids = (body.ids || []).filter((n) => Number.isInteger(n));
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const result = await bulkRun(ids, async (id) => {
    await c.env.DB.prepare(
      `UPDATE assr_cases
          SET archived_at = NULL, archived_by = NULL, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NOT NULL`
    )
      .bind(id)
      .run();
  });
  return c.json(result);
});

app.post("/bulk/assign", async (c) => {
  const userId = (c as any).get?.("userId") ?? null;
  const body = await c.req.json<{ ids?: number[]; assigned_to?: number | null }>();
  const ids = (body.ids || []).filter((n) => Number.isInteger(n));
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const assigneeId = body.assigned_to ?? null;
  const result = await bulkRun(ids, async (id) => {
    await c.env.DB.prepare(
      `UPDATE assr_cases SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(assigneeId, id)
      .run();
    await c.env.DB.prepare(
      `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
       VALUES (?, 'assignment', NULL, ?, 'bulk', ?)`
    )
      .bind(id, String(assigneeId ?? ""), userId)
      .run();
  });
  return c.json(result);
});

// ── CSV export ────────────────────────────────────────────────
// Returns the full filtered case list (capped at 10k rows) as CSV.
// Honors the same filters as the list endpoint so "what you see is
// what you export" matches the table.

app.get("/export.csv", async (c) => {
  const rows = await exportAssrCases(c.env, {
    stage: c.req.query("stage"),
    status: c.req.query("status"),
    search: c.req.query("search"),
    include_archived: c.req.query("include_archived") === "1",
  });
  const headers = [
    "ASSR No", "SO No", "Stage", "Status", "Priority",
    "Customer", "Phone", "Location",
    "Category", "NCR Category", "Resolution",
    "Item", "Issue",
    "Complained Date", "Created", "Deadline",
    "PO Amount", "PO No",
    "Assigned To", "Created By", "Creditor",
    "SLA Breached",
  ];
  const fields = [
    "assr_no", "doc_no", "stage", "status", "priority",
    "customer_name", "customer_phone", "location",
    "service_category", "ncr_category", "resolution_method",
    "item_code", "complaint_issue",
    "complained_date", "created_at", "deadline_at",
    "po_amount", "po_no",
    "assigned_to_name", "created_by_name", "creditor_name",
    "is_breached",
  ];
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows as any[]) {
    lines.push(fields.map((f) => esc(r[f])).join(","));
  }
  const csv = "\uFEFF" + lines.join("\r\n");
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="service-cases-${date}.csv"`,
    },
  });
});

// ── SO item lookup ────────────────────────────────────────────

app.get("/lookup-items/:docNo", async (c) => {
  const docNo = c.req.param("docNo");
  const items = await lookupSOItems(c.env, docNo);
  return c.json({ items });
});

// ── Detail ────────────────────────────────────────────────────

app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const detail = await getAssrDetail(c.env, id);
  if (!detail) return c.json({ error: "Not found" }, 404);
  return c.json(detail);
});

// ── Supplier rating ──────────────────────────────────────────
// Posted from the Close-Case prompt when the case had a supplier
// assigned. Stored on the case row (one rating per case) and
// stamped with the rater + timestamp for audit. Re-posting the
// same case overwrites — staff can correct a misclick.

// ── Customer history ──────────────────────────────────────────
// Returns prior cases for the same customer (matched on phone if
// present, otherwise on exact name) so staff can spot repeat
// complaints. Excludes the current case and archived rows.

app.get("/:id/customer-history", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const cur = await c.env.DB.prepare(
    `SELECT customer_name, customer_phone FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ customer_name: string | null; customer_phone: string | null }>();
  if (!cur) return c.json({ error: "Not found" }, 404);

  const phone = (cur.customer_phone || "").trim();
  const name = (cur.customer_name || "").trim();
  if (!phone && !name) return c.json({ cases: [] });

  const where: string[] = ["c.id != ?", "c.archived_at IS NULL"];
  const binds: any[] = [id];
  if (phone) {
    where.push("c.customer_phone = ?");
    binds.push(phone);
  } else {
    where.push("c.customer_name = ?");
    binds.push(name);
  }
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.assr_no, c.doc_no, c.stage, c.status, c.priority,
            c.complaint_issue, c.complained_date, c.created_at, c.item_code,
            c.resolution_method
       FROM assr_cases c
      WHERE ${where.join(" AND ")}
      ORDER BY c.id DESC
      LIMIT 25`
  )
    .bind(...binds)
    .all();
  return c.json({ cases: rows.results ?? [] });
});

// ── Create ────────────────────────────────────────────────────

app.post("/", async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    doc_no: string;
    items?: { item_code: string; item_description?: string; qty?: number }[];
    item_code?: string;
    complaint_issue: string;
  }>();

  if (!body.doc_no || !body.complaint_issue) {
    return c.json({ error: "doc_no and complaint_issue are required" }, 400);
  }

  // Support both old format (item_code string) and new (items array)
  const items = body.items?.length
    ? body.items
    : body.item_code
    ? [{ item_code: body.item_code }]
    : [];

  if (!items.length) {
    return c.json({ error: "At least one item is required" }, 400);
  }

  const result = await createAssrCase(c.env, {
    doc_no: body.doc_no,
    items,
    complaint_issue: body.complaint_issue,
    created_by: userId,
  });
  return c.json(result, 201);
});

// ── Patch ─────────────────────────────────────────────────────

app.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchAssrCase(c.env, id, body, userId);
  if (!ok) return c.json({ error: "Not found or no changes" }, 404);
  return c.json({ ok: true });
});

// ── Generate a staff-sourced portal tracking link ─────────────
// Dispatcher clicks "Copy portal link" — returns a token that the
// frontend turns into a full URL, then copied into WhatsApp. 30-day
// TTL so the customer can reopen it over the life of the case.
app.post("/:id/track-link", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  const token = await issueStaffToken(c.env, id);
  return c.json({ token, path: `/portal/case/${token}` }, 201);
});

// ── Generate satisfaction survey token ────────────────────────

app.post("/:id/survey-token", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const token = await issueSurveyToken(c.env, id);
  return c.json({ token });
});

// ── Soft-delete (archive) endpoints ───────────────────────────
// No rows are ever physically deleted. Archive stamps archived_at +
// archived_by; restore clears them. Default queries skip archived
// rows so the UI is clean without losing data or audit trail.

async function setArchived(
  env: Env,
  table: string,
  where: string,
  binds: any[],
  userId: number | null,
  archive: boolean
): Promise<boolean> {
  const r = await env.DB.prepare(
    archive
      ? `UPDATE ${table}
            SET archived_at = datetime('now'),
                archived_by = ?
          WHERE ${where} AND archived_at IS NULL`
      : `UPDATE ${table}
            SET archived_at = NULL,
                archived_by = NULL
          WHERE ${where} AND archived_at IS NOT NULL`
  )
    .bind(...(archive ? [userId, ...binds] : binds))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// Case — archive/unarchive. Manager-level (service_cases.manage).
app.post("/:id/archive", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(c.env, "assr_cases", "id = ?", [id], userId || null, true);
  if (!ok) return c.json({ error: "Not found or already archived" }, 404);
  await logActivity(c.env, id, "archived", null, null, null, userId || null);
  return c.json({ ok: true });
});

app.post("/:id/unarchive", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(c.env, "assr_cases", "id = ?", [id], userId || null, false);
  if (!ok) return c.json({ error: "Not found or not archived" }, 404);
  await logActivity(c.env, id, "unarchived", null, null, null, userId || null);
  return c.json({ ok: true });
});

// Logistics entry archive.
app.post("/:id/logistics/:logId/archive", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const logId = parseInt(c.req.param("logId"), 10);
  if (isNaN(id) || isNaN(logId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(
    c.env,
    "assr_logistics",
    "id = ? AND assr_id = ?",
    [logId, id],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Attachment archive — hard replacement for the old "delete" wish.
app.post("/attachments/:attId/archive", async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(
    c.env,
    "assr_attachments",
    "id = ?",
    [attId],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Activity archive — only non-system actions (notes, customer
// comments). Stage transitions, created, approval, po_generated,
// escalated, survey_submitted are all part of the audit trail and
// must not be archive-able.
const ARCHIVABLE_ACTIONS = new Set(["note", "customer_comment"]);

app.post("/activity/:actId/archive", async (c) => {
  const actId = parseInt(c.req.param("actId"), 10);
  if (isNaN(actId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const row = await c.env.DB.prepare(
    `SELECT action FROM assr_activity WHERE id = ?`
  )
    .bind(actId)
    .first<{ action: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!ARCHIVABLE_ACTIONS.has(row.action)) {
    return c.json({ error: "This activity entry is part of the audit trail and cannot be archived" }, 403);
  }

  const ok = await setArchived(
    c.env,
    "assr_activity",
    "id = ?",
    [actId],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Toggle an attachment's visibility to the portal customer ──
// Lets staff hide an internal photo so it doesn't show up on the
// customer's portal view of the case.
app.patch("/attachments/:attId/visibility", async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req
    .json<{ visible_to_customer?: boolean }>()
    .catch(() => ({} as { visible_to_customer?: boolean }));
  if (typeof body.visible_to_customer !== "boolean") {
    return c.json({ error: "visible_to_customer is required" }, 400);
  }
  const r = await c.env.DB.prepare(
    `UPDATE assr_attachments SET visible_to_customer = ? WHERE id = ?`
  )
    .bind(body.visible_to_customer ? 1 : 0, attId)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Manual SLA escalation sweep ───────────────────────────────

app.post("/run-escalation", async (c) => {
  const result = await runSlaEscalation(c.env);
  return c.json(result);
});

// ── Quality metrics (for manager dashboard) ───────────────────

app.get("/metrics", async (c) => {
  const sinceDays = parseInt(c.req.query("since_days") || "90", 10);
  const sinceClause = `AND complained_date >= date('now', '-${sinceDays} days')`;

  // Headline numbers
  const headline = await c.env.DB.prepare(
    `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN stage = 'closed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN stage != 'closed' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN stage != 'closed' AND deadline_at IS NOT NULL
                  AND datetime('now') > deadline_at THEN 1 ELSE 0 END) as breached,
        SUM(CASE WHEN quality_review_passed = 1 THEN 1 ELSE 0 END) as qa_passed,
        AVG(CASE WHEN stage = 'closed' AND closed_at IS NOT NULL
                  THEN (julianday(closed_at) - julianday(created_at)) * 24
                  END) as avg_resolution_hours,
        AVG(CASE WHEN satisfaction_rating IS NOT NULL THEN satisfaction_rating END) as avg_satisfaction
      FROM assr_cases
     WHERE 1=1 ${sinceClause}`
  ).first();

  // NCR category breakdown
  const ncr = await c.env.DB.prepare(
    `SELECT COALESCE(ncr_category, 'unclassified') as category, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}
      GROUP BY ncr_category
      ORDER BY count DESC`
  ).all();

  // Resolution method mix
  const resolutions = await c.env.DB.prepare(
    `SELECT COALESCE(resolution_method, 'unset') as method, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}
      GROUP BY resolution_method
      ORDER BY count DESC`
  ).all();

  // Repeat offenders — items with >= 2 cases in window
  const repeatItems = await c.env.DB.prepare(
    `SELECT i.item_code,
            COUNT(DISTINCT i.assr_id) as cases,
            MAX(c.complained_date) as latest
       FROM assr_items i
       JOIN assr_cases c ON c.id = i.assr_id
      WHERE 1=1 ${sinceClause.replace("complained_date", "c.complained_date")}
      GROUP BY i.item_code
      HAVING cases >= 2
      ORDER BY cases DESC, latest DESC
      LIMIT 20`
  ).all();

  // Repeat customers — customers with >= 2 cases in window
  const repeatCustomers = await c.env.DB.prepare(
    `SELECT customer_name, phone,
            COUNT(*) as cases,
            MAX(complained_date) as latest
       FROM assr_cases
      WHERE customer_name IS NOT NULL
        ${sinceClause}
      GROUP BY customer_name, phone
      HAVING cases >= 2
      ORDER BY cases DESC, latest DESC
      LIMIT 20`
  ).all();

  // Creditor performance (within window). Joined against the
  // creditors mirror via a.creditor_code rather than the old
  // suppliers table — creditor is now the source of truth.
  const creditorPerf = await c.env.DB.prepare(
    `SELECT a.creditor_code as creditor_code,
            cr.company_name as name,
            COUNT(DISTINCT a.id) as total_cases,
            SUM(CASE WHEN a.stage = 'closed' THEN 1 ELSE 0 END) as closed_cases,
            SUM(CASE WHEN a.stage != 'closed' AND a.deadline_at IS NOT NULL
                      AND datetime('now') > a.deadline_at THEN 1 ELSE 0 END) as breached,
            AVG(CASE WHEN a.satisfaction_rating IS NOT NULL
                      THEN a.satisfaction_rating END) as avg_rating,
            AVG(CASE WHEN a.stage = 'closed' AND a.closed_at IS NOT NULL
                      THEN (julianday(a.closed_at) - julianday(a.created_at)) * 24
                      END) as avg_resolution_hours
       FROM assr_cases a
       LEFT JOIN creditors cr ON cr.creditor_code = a.creditor_code
      WHERE a.creditor_code IS NOT NULL
        ${sinceClause.replace("complained_date", "a.complained_date")}
      GROUP BY a.creditor_code
      ORDER BY total_cases DESC
      LIMIT 15`
  ).all();

  // Monthly trend (last 12 months of case opens)
  const trend = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', complained_date) as month,
            COUNT(*) as opened,
            SUM(CASE WHEN stage = 'closed' THEN 1 ELSE 0 END) as closed
       FROM assr_cases
      WHERE complained_date >= date('now', '-12 months')
      GROUP BY month
      ORDER BY month`
  ).all();

  return c.json({
    since_days: sinceDays,
    headline,
    ncr: ncr.results ?? [],
    resolutions: resolutions.results ?? [],
    repeat_items: repeatItems.results ?? [],
    repeat_customers: repeatCustomers.results ?? [],
    creditor_performance: creditorPerf.results ?? [],
    monthly_trend: trend.results ?? [],
  });
});

// ── Auto-generate service PO number ───────────────────────────

app.post("/:id/generate-po", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const existing = await c.env.DB.prepare(
    `SELECT po_no, supplier FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ po_no: string | null; supplier: string | null }>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (existing.po_no) {
    return c.json({ error: `PO already exists: ${existing.po_no}`, po_no: existing.po_no }, 409);
  }

  const poNo = await nextServicePONumber(c.env);
  await c.env.DB.prepare(
    `UPDATE assr_cases SET po_no = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(poNo, id)
    .run();

  await logActivity(
    c.env,
    id,
    "po_generated",
    null,
    poNo,
    existing.supplier ? `Supplier: ${existing.supplier}` : null,
    userId
  );

  return c.json({ po_no: poNo }, 201);
});

// ── Manager approval / quality sign-off ───────────────────────

app.post("/:id/approve", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    quality_review_passed?: boolean;
    ncr_category?: string | null;
    note?: string;
  }>();

  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE assr_cases
        SET approved_by = ?, approved_at = ?,
            quality_review_passed = ?,
            ncr_category = COALESCE(?, ncr_category),
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(
      userId || null,
      now,
      body.quality_review_passed == null ? null : body.quality_review_passed ? 1 : 0,
      body.ncr_category ?? null,
      id
    )
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);

  // Log to activity trail so the timeline captures the sign-off.
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
     VALUES (?, 'approval', NULL, ?, ?, ?)`
  )
    .bind(
      id,
      body.quality_review_passed ? "passed" : "review",
      body.note ?? null,
      userId || null
    )
    .run();

  return c.json({ ok: true, approved_at: now });
});

// ── Stage transition ──────────────────────────────────────────

app.post("/:id/transition", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ stage: string; note?: string }>();
  if (!body.stage) return c.json({ error: "stage is required" }, 400);

  try {
    const ok = await transitionStage(c.env, id, body.stage as any, userId, body.note);
    if (!ok) return c.json({ error: "Not found" }, 404);

    // Auto-dispatch satisfaction survey when case is closed.  Fire-and-
    // -forget: if email is disabled or the customer has no email, the
    // email service silently skips (and still logs the attempt).
    if (body.stage === "closed") {
      const row = await c.env.DB.prepare(
        `SELECT assr_no, customer_name, customer_email FROM assr_cases WHERE id = ?`
      )
        .bind(id)
        .first<{ assr_no: string; customer_name: string | null; customer_email: string | null }>();
      if (row?.customer_email) {
        const token = await issueSurveyToken(c.env, id);
        const link = publicUrl(c.env, `/survey/${token}`);
        const name = (row.customer_name || "").split(" ")[0] || "there";
        await sendEmail(c.env, {
          to: row.customer_email,
          subject: `How was your experience with case ${row.assr_no}?`,
          html: surveyEmailHtml(name, row.assr_no, link),
          purpose: "assr_survey",
          refType: "assr",
          refId: id,
        });
      }
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

function surveyEmailHtml(name: string, assrNo: string, link: string): string {
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 12px">Thanks for your patience, ${name}.</h2>
      <p>We've wrapped up your service case <strong>${assrNo}</strong>. Your feedback helps us improve.</p>
      <p style="margin:24px 0">
        <a href="${link}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Rate your experience
        </a>
      </p>
      <p style="color:#777;font-size:13px">Takes about 30 seconds — one rating + an optional note.</p>
      <p style="color:#aaa;font-size:12px;border-top:1px solid #eee;padding-top:14px;margin-top:28px">
        Houzs Century Sdn. Bhd.
      </p>
    </div>`;
}

// ── Notes ─────────────────────────────────────────────────────

app.post("/:id/notes", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ note: string }>();
  if (!body.note?.trim()) return c.json({ error: "note is required" }, 400);
  await logActivity(c.env, id, "note", null, null, body.note, userId);
  return c.json({ ok: true });
});

// ── Items ─────────────────────────────────────────────────────

app.post("/:id/items", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    items: { item_code: string; item_description?: string; qty?: number }[];
  }>();
  if (!body.items?.length) return c.json({ error: "items required" }, 400);
  await addItems(c.env, id, body.items);
  return c.json({ ok: true });
});

app.delete("/:id/items/:itemId", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const itemId = parseInt(c.req.param("itemId"), 10);
  await removeItem(c.env, id, itemId);
  return c.json({ ok: true });
});

// ── Attachments ───────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "pdf"]);
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

app.put("/:id/attachments", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const category = c.req.query("category") || "complaint";
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const fileName = c.req.query("name") || null;

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json({ error: `Extension '${ext}' not allowed` }, 400);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_SIZE) {
    return c.json({ error: "File too large (max 25MB)" }, 400);
  }

  const contentType =
    ext === "mp4" ? "video/mp4" :
    ext === "pdf" ? "application/pdf" :
    `image/${ext === "jpg" ? "jpeg" : ext}`;

  const key = assrAttachmentKey(id, category, ext);
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  const attachId = await saveAttachment(c.env, id, key, fileName, contentType, category, userId);

  return c.json({ id: attachId, key }, 201);
});

app.get("/attachments/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);

  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ── Logistics ─────────────────────────────────────────────────

app.post("/:id/logistics", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    type: string;
    scheduled_date?: string;
    scheduled_time_range?: string;
    assigned_to?: number;
    notes?: string;
  }>();
  if (!body.type) return c.json({ error: "type is required" }, 400);
  const logId = await createLogistics(c.env, id, body);
  return c.json({ id: logId }, 201);
});

app.patch("/:id/logistics/:logId", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const logId = parseInt(c.req.param("logId"), 10);
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchLogistics(c.env, id, logId, body);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Cost-suggestion helpers ───────────────────────────────────

/** Parse the AutoCount line set: case-insensitive ItemCode match. */
function matchLine(
  lines: Array<Record<string, any>> | null | undefined,
  itemCode: string
): Record<string, any> | null {
  if (!lines || !Array.isArray(lines)) return null;
  const target = itemCode.toLowerCase();
  for (const ln of lines) {
    const code = String(ln.ItemCode ?? ln.itemCode ?? ln.item_code ?? "").toLowerCase();
    if (code === target) return ln;
  }
  return null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}

export default app;
