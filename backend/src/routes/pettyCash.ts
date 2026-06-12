import { Hono } from "hono";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Env } from "../types";
import { hasPermission } from "../services/permissions";
import { getDb } from "../db/client";
import { petty_cash_entries, users } from "../db/schema";

/**
 * Petty cash ledger (mig 060).
 *
 * Single global float. Each entry is either a cash-in (top-up,
 * refund) or cash-out (spend). amount_cents is always positive; the
 * sign comes from `direction`. Running balance =
 * SUM(in) - SUM(out) over non-archived rows.
 *
 * Permissions:
 *   petty_cash.read   — view ledger + balance
 *   petty_cash.post   — add entries (the user's own posts)
 *   petty_cash.manage — edit / archive any entry
 *   "*" — implicit superuser
 *
 * Receipt photos live in R2 under petty-cash/{id}/{ts}-{name}. They're
 * optional and uploaded as a follow-up PUT after the entry is created
 * so the entry id can be part of the key.
 */

const app = new Hono<{ Bindings: Env }>();

const RECEIPT_EXT = new Set(["pdf", "png", "jpg", "jpeg", "webp", "heic"]);
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

function canRead(user: any): boolean {
  return hasPermission(user?.permissions ?? [], "petty_cash.read");
}
function canPost(user: any): boolean {
  return hasPermission(user?.permissions ?? [], "petty_cash.post");
}
function canManage(user: any): boolean {
  return hasPermission(user?.permissions ?? [], "petty_cash.manage");
}

function safeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

// ── GET /api/petty-cash ─────────────────────────────────────────
// Query: from=YYYY-MM-DD, to=YYYY-MM-DD, direction=in|out, category=…
// Returns rows + summary { balance, total_in, total_out, count }.
app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!canRead(user)) return c.json({ error: "Forbidden" }, 403);

  const from = c.req.query("from");
  const to = c.req.query("to");
  const direction = c.req.query("direction");
  const category = c.req.query("category");

  const conds: any[] = [isNull(petty_cash_entries.archived_at)];
  if (from) conds.push(gte(petty_cash_entries.occurred_on, from));
  if (to) conds.push(lte(petty_cash_entries.occurred_on, to));
  if (direction === "in" || direction === "out") {
    conds.push(eq(petty_cash_entries.direction, direction));
  }
  if (category) conds.push(eq(petty_cash_entries.category, category));

  const db = getDb(c.env);
  const rows = await db
    .select({
      id: petty_cash_entries.id,
      direction: petty_cash_entries.direction,
      amount_cents: petty_cash_entries.amount_cents,
      category: petty_cash_entries.category,
      counterparty: petty_cash_entries.counterparty,
      note: petty_cash_entries.note,
      receipt_r2_key: petty_cash_entries.receipt_r2_key,
      occurred_on: petty_cash_entries.occurred_on,
      posted_by: petty_cash_entries.posted_by,
      posted_by_name: users.name,
      created_at: petty_cash_entries.created_at,
    })
    .from(petty_cash_entries)
    .leftJoin(users, eq(users.id, petty_cash_entries.posted_by))
    .where(and(...conds))
    .orderBy(desc(petty_cash_entries.occurred_on), desc(petty_cash_entries.id));

  // Balance always reflects the entire (non-archived) ledger, not
  // just the filtered window — that's the actual cash on hand.
  const balanceRow = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN direction='in' THEN amount_cents ELSE 0 END), 0) AS total_in,
       COALESCE(SUM(CASE WHEN direction='out' THEN amount_cents ELSE 0 END), 0) AS total_out
       FROM petty_cash_entries
      WHERE archived_at IS NULL`,
  ).first<{ total_in: number; total_out: number }>();

  const total_in = balanceRow?.total_in ?? 0;
  const total_out = balanceRow?.total_out ?? 0;

  // Summary across the FILTERED window — useful for "this month spent"
  let filteredIn = 0;
  let filteredOut = 0;
  for (const r of rows) {
    if (r.direction === "in") filteredIn += r.amount_cents;
    else filteredOut += r.amount_cents;
  }

  return c.json({
    rows,
    summary: {
      balance_cents: total_in - total_out,
      total_in_cents: total_in,
      total_out_cents: total_out,
      filtered_in_cents: filteredIn,
      filtered_out_cents: filteredOut,
      count: rows.length,
    },
  });
});

// ── POST /api/petty-cash ───────────────────────────────────────
app.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!canPost(user)) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json().catch(() => ({}));

  const direction = body.direction === "in" || body.direction === "out" ? body.direction : null;
  if (!direction) return c.json({ error: "direction must be 'in' or 'out'" }, 400);

  const amount = parseInt(String(body.amount_cents ?? ""), 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: "amount_cents must be a positive integer" }, 400);
  }

  const occurred_on =
    typeof body.occurred_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on)
      ? body.occurred_on
      : new Date().toISOString().slice(0, 10);

  const db = getDb(c.env);
  const inserted = await db
    .insert(petty_cash_entries)
    .values({
      direction,
      amount_cents: amount,
      category: typeof body.category === "string" ? body.category.trim() || null : null,
      counterparty: typeof body.counterparty === "string" ? body.counterparty.trim() || null : null,
      note: typeof body.note === "string" ? body.note.trim() || null : null,
      occurred_on,
      posted_by: user.id,
    })
    .returning()
    .then((r) => r[0]);
  return c.json({ row: inserted });
});

// ── PATCH /api/petty-cash/:id ──────────────────────────────────
app.patch("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json().catch(() => ({}));

  const db = getDb(c.env);
  const existing = await db
    .select({
      posted_by: petty_cash_entries.posted_by,
      created_at: petty_cash_entries.created_at,
    })
    .from(petty_cash_entries)
    .where(eq(petty_cash_entries.id, id))
    .then((r) => r[0]);
  if (!existing) return c.json({ error: "Not found" }, 404);

  // Posters can fix typos on their own entries within 24 h; otherwise
  // only managers can edit.
  const ownPost = existing.posted_by === user.id;
  const fresh =
    !!existing.created_at &&
    new Date().getTime() - new Date(existing.created_at).getTime() < 24 * 3600 * 1000;
  if (!canManage(user) && !(ownPost && fresh)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const patch: Record<string, any> = { updated_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` };
  if (body.direction === "in" || body.direction === "out") patch.direction = body.direction;
  if (typeof body.amount_cents === "number" && body.amount_cents > 0) {
    patch.amount_cents = body.amount_cents;
  }
  if ("category" in body) patch.category = body.category ? String(body.category).trim() : null;
  if ("counterparty" in body) {
    patch.counterparty = body.counterparty ? String(body.counterparty).trim() : null;
  }
  if ("note" in body) patch.note = body.note ? String(body.note).trim() : null;
  if (typeof body.occurred_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on)) {
    patch.occurred_on = body.occurred_on;
  }

  const updated = await db
    .update(petty_cash_entries)
    .set(patch)
    .where(eq(petty_cash_entries.id, id))
    .returning()
    .then((r) => r[0]);
  return c.json({ row: updated });
});

// ── DELETE /api/petty-cash/:id  (soft archive) ─────────────────
app.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!canManage(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const db = getDb(c.env);
  await db
    .update(petty_cash_entries)
    .set({ archived_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` })
    .where(eq(petty_cash_entries.id, id));
  return c.json({ ok: true });
});

// ── PUT /api/petty-cash/:id/receipt?name=… ─────────────────────
// Upload (or replace) the receipt image. Body is the raw bytes.
app.put("/:id/receipt", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!canPost(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const filename = safeFilename(c.req.query("name") || `receipt-${Date.now()}`);
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext && !RECEIPT_EXT.has(ext)) {
    return c.json({ error: `File type .${ext} not allowed for receipts` }, 400);
  }
  const contentType = c.req.header("content-type") || "application/octet-stream";
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > RECEIPT_MAX_BYTES) {
    return c.json({ error: "Receipt too large (max 10 MB)" }, 413);
  }

  const key = `petty-cash/${id}/${Date.now()}-${filename}`;
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });

  const db = getDb(c.env);
  const updated = await db
    .update(petty_cash_entries)
    .set({ receipt_r2_key: key, updated_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` })
    .where(eq(petty_cash_entries.id, id))
    .returning()
    .then((r) => r[0]);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ row: updated });
});

// ── GET /api/petty-cash/:id/receipt ────────────────────────────
// Stream the bytes.
app.get("/:id/receipt", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!canRead(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const db = getDb(c.env);
  const row = await db
    .select({ key: petty_cash_entries.receipt_r2_key })
    .from(petty_cash_entries)
    .where(eq(petty_cash_entries.id, id))
    .then((r) => r[0]);
  if (!row?.key) return c.json({ error: "No receipt" }, 404);
  const obj = await c.env.POD_BUCKET.get(row.key);
  if (!obj) return c.json({ error: "Object missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=300",
    },
  });
});

// ── GET /api/petty-cash/categories ─────────────────────────────
// Distinct list of categories used so far — drives the picker on
// the frontend.
app.get("/categories", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!canRead(user)) return c.json({ error: "Forbidden" }, 403);
  const list = await c.env.DB.prepare(
    `SELECT category, COUNT(*) AS uses
       FROM petty_cash_entries
      WHERE category IS NOT NULL AND category <> '' AND archived_at IS NULL
      GROUP BY category
      ORDER BY uses DESC, category ASC
      LIMIT 50`,
  ).all<{ category: string; uses: number }>();
  return c.json({ rows: list.results ?? [] });
});

export default app;
