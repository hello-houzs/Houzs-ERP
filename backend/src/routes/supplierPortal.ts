/**
 * Supplier Portal API — proposal §6.3.
 *
 * All routes are gated by the supplierTrack middleware (see
 * src/index.ts), which resolves the bearer token to one case +
 * supplier scope. Every query is already scoped — no cross-case
 * access is possible from a single token.
 *
 * Every response field is hand-picked. The supplier sees the action
 * block (item, issue, agreed lead time, pickup/delivery windows) but
 * NOT customer phone/address detail (only address line 1 + postcode
 * for delivery routing) or internal cost.
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { transitionStage, assrAttachmentKey, saveAttachment } from "../services/assr";

const app = new Hono<{ Bindings: Env }>();

// Mirrors the customer-portal upload route — same allow-list and limits
// so the supplier can't slip in a bigger file than the customer can.
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ATTACHMENTS_PER_CASE = 20;

// The PictureBlock slots map to existing category values so the
// assr_attachments CHECK constraint accepts them without a migration.
//   "Service Issue"        → evidence    (proof of the problem)
//   "Operation QC Checked" → completion  (proof of finished work)
const SUPPLIER_CATEGORY = new Set(["evidence", "completion"]);

// ── GET /case ───────────────────────────────────────────────────────
//
// One-shot bundle for the supplier portal page. Returns the slim case
// view + items + supplier-visible attachments + stage history (for the
// Workflow Progress Tracker).

app.get("/case", async (c) => {
  const { assr_id } = c.get("supplierScope");

  const cs = await c.env.DB.prepare(
    `SELECT id, assr_no, stage, complained_date, complaint_issue,
            issue_category, resolution_method, service_category,
            po_no, ref_no,
            -- only address line 1 + postcode — protect customer privacy
            addr1, addr4, location,
            customer_name,
            supplier_pickup_at, items_ready_at,
            do_date, delivery_order,
            creditor_code,
            stage_entered_at, stage_target_days,
            -- Mig 106 — supplier's own service record + the goods-
            -- returned slip we sent with the item (read-only for the
            -- supplier; helps them cross-reference what came in).
            supplier_service_note, goods_returned_note
       FROM assr_cases WHERE id = ?`
  )
    .bind(assr_id)
    .first<any>();
  if (!cs) return c.json({ error: "Not found" }, 404);

  const items = await c.env.DB.prepare(
    `SELECT id, item_code, item_description, qty FROM assr_items
      WHERE assr_id = ? ORDER BY id`
  )
    .bind(assr_id)
    .all();

  const attachments = await c.env.DB.prepare(
    `SELECT id, category, file_name, content_type, created_at
       FROM assr_attachments
      WHERE assr_id = ? AND archived_at IS NULL
      ORDER BY created_at DESC`
  )
    .bind(assr_id)
    .all();

  const history = await c.env.DB.prepare(
    `SELECT id, stage, entered_at, exited_at, target_days,
            status, skipped, skip_reason
       FROM assr_stage_history
      WHERE assr_id = ?
      ORDER BY entered_at ASC, id ASC`
  )
    .bind(assr_id)
    .all();

  // Supplier name from the creditors mirror
  const supplierName = cs.creditor_code
    ? (
        await c.env.DB.prepare(
          `SELECT company_name FROM creditors WHERE creditor_code = ?`
        )
          .bind(cs.creditor_code)
          .first<{ company_name: string | null }>()
      )?.company_name ?? null
    : null;

  return c.json({
    case: cs,
    supplier_name: supplierName,
    items: items.results ?? [],
    attachments: attachments.results ?? [],
    stage_history: history.results ?? [],
  });
});

// ── POST /stage ─────────────────────────────────────────────────────
//
// Supplier-visible stage transitions: Picked Up → In Repair → Ready
// → Delivered. Mapped to the canonical 9-stage workflow:
//   "supplier_picked_up"  → pending_item_ready  (they have the item)
//   "supplier_ready"      → pending_item_ready  (still — repair done, awaiting return)
//   "supplier_returned"   → pending_delivery_service
// We narrow the allowed set so a supplier can't jump arbitrary stages.

const ALLOWED_SUPPLIER_TRANSITIONS = new Set([
  "pending_supplier_pickup",   // mark "I've collected" — moves backward if needed
  "pending_item_ready",        // mark "repair complete"
  "pending_delivery_service",  // mark "returned to Houzs warehouse"
]);

app.post("/stage", async (c) => {
  const { assr_id } = c.get("supplierScope");
  const body = await c.req.json<{ stage?: string; note?: string }>();
  if (!body.stage) return c.json({ error: "stage is required" }, 400);
  if (!ALLOWED_SUPPLIER_TRANSITIONS.has(body.stage)) {
    return c.json({ error: "stage not permitted from supplier portal" }, 403);
  }
  await transitionStage(
    c.env,
    assr_id,
    body.stage as any,
    0,
    body.note,
    "supplier_portal"
  );
  return c.json({ ok: true });
});

// ── POST /remarks ───────────────────────────────────────────────────
//
// Free-text supplier remark — logged to the activity stream with
// source_channel='supplier_portal' so the timeline distinguishes it
// from staff notes.

app.post("/remarks", async (c) => {
  const { assr_id } = c.get("supplierScope");
  const body = await c.req.json<{ note?: string }>();
  const note = (body.note || "").trim();
  if (!note) return c.json({ error: "note is required" }, 400);
  const clipped = note.slice(0, 2000);
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel)
     VALUES (?, 'note', ?, 'purchasing', 'supplier_portal')`
  )
    .bind(assr_id, clipped)
    .run();
  // Mig 106 — main case page's "Supplier status update" (action_remark)
  // mirrors the latest supplier-portal note so ops don't have to hunt
  // through the activity log to see the current status. Ops can still
  // hand-edit action_remark on the main page; the next supplier note
  // overwrites it. Full history stays in assr_activity.
  await c.env.DB.prepare(
    `UPDATE assr_cases SET action_remark = ? WHERE id = ?`
  )
    .bind(clipped, assr_id)
    .run();
  return c.json({ ok: true });
});

// ── PUT /service-note ───────────────────────────────────────────────
//
// Mig 106 — persistent service record the supplier writes when
// they've serviced the item. Unlike /remarks (which fires one-off
// notes into the activity log), this field is the current-state
// blob the supplier owns and can rewrite. Ops sees the same value
// on the main case page's QC Inspection card.

app.put("/service-note", async (c) => {
  const { assr_id } = c.get("supplierScope");
  const body = await c.req.json<{ note?: string | null }>();
  const raw = typeof body.note === "string" ? body.note.trim() : "";
  const clipped = raw ? raw.slice(0, 2000) : null;
  await c.env.DB.prepare(
    `UPDATE assr_cases SET supplier_service_note = ? WHERE id = ?`
  )
    .bind(clipped, assr_id)
    .run();
  return c.json({ ok: true });
});

// ── PUT /attachments ────────────────────────────────────────────────
//
// Photo upload from the supplier — used by the PictureBlock slots on
// the supplier-portal page. Mirrors POD's customer-portal route (mig 016
// + routes/portal.ts) but writes the attachment with source_channel
// stamped in the activity log so audit can tell supplier uploads apart
// from staff and customer ones.

app.put("/attachments", async (c) => {
  const { assr_id } = c.get("supplierScope");

  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const fileName = c.req.query("name") || null;
  const category = (c.req.query("category") || "evidence").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return c.json({ error: `Extension '${ext}' not allowed` }, 415);
  }
  if (!SUPPLIER_CATEGORY.has(category)) {
    return c.json({ error: "category must be 'evidence' or 'completion'" }, 400);
  }

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM assr_attachments WHERE assr_id = ? AND archived_at IS NULL`
  )
    .bind(assr_id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ATTACHMENTS_PER_CASE) {
    return c.json({ error: "Attachment limit reached for this case" }, 413);
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_SIZE) {
    return c.json({ error: "File exceeds 10MB limit" }, 413);
  }

  const contentType =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
      ? "image/png"
      : "image/webp";

  const key = assrAttachmentKey(assr_id, category, ext);
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });
  const attId = await saveAttachment(c.env, assr_id, key, fileName, contentType, category, null);

  // Audit entry — `source_channel` differentiates this from staff /
  // customer uploads in the timeline.
  await c.env.DB.prepare(
    `INSERT INTO assr_activity
       (assr_id, action, from_value, to_value, note, category, source_channel)
     VALUES (?, 'supplier_upload', NULL, ?, ?, ?, 'supplier_portal')`
  )
    .bind(assr_id, String(attId), fileName, category)
    .run();

  return c.json({ id: attId, category }, 201);
});

// ── GET /attachments/:attId ─────────────────────────────────────────
//
// Stream an attachment binary back. Re-checks scope on every request
// so a stolen attachment URL with a stale token is rejected.

app.get("/attachments/:attId", async (c) => {
  const { assr_id } = c.get("supplierScope");
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Not found" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT r2_key, content_type
       FROM assr_attachments
      WHERE id = ?
        AND assr_id = ?
        AND archived_at IS NULL`
  )
    .bind(attId, assr_id)
    .first<{ r2_key: string; content_type: string | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.POD_BUCKET.get(row.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// ── POST /attachments/:attId/archive ────────────────────────────────
//
// Suppliers can retract a photo they uploaded by mistake, as long as
// it was theirs (matched by the latest supplier_upload activity row).
// Anything authored by staff or customer is off-limits.

app.post("/attachments/:attId/archive", async (c) => {
  const { assr_id } = c.get("supplierScope");
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Not found" }, 404);

  const wasSupplier = await c.env.DB.prepare(
    `SELECT 1 FROM assr_activity
      WHERE assr_id = ?
        AND action = 'supplier_upload'
        AND to_value = ?
        AND source_channel = 'supplier_portal'
      LIMIT 1`
  )
    .bind(assr_id, String(attId))
    .first();
  if (!wasSupplier) return c.json({ error: "Not found" }, 404);

  const r = await c.env.DB.prepare(
    `UPDATE assr_attachments
        SET archived_at = datetime('now')
      WHERE id = ?
        AND assr_id = ?
        AND archived_at IS NULL`
  )
    .bind(attId, assr_id)
    .run();
  if (!(r.meta.changes ?? 0)) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

export default app;
