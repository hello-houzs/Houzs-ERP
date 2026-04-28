import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

// ── Scoping helper ───────────────────────────────────────────
// Reps (role.scope_to_pic=1) without sales.manage only see entries
// they created. Anyone with sales.manage, or any unscoped role, sees
// everything.
// Returns a single WHERE-fragment (no leading/trailing AND) that the
// caller stitches into the final clause via " AND ". Returning a leading
// AND here used to double up with the join — `WHERE x AND AND y`.
function buildOwnershipWhere(user: any, canManage: boolean) {
  if (canManage) return { sql: "", binds: [] as any[] };
  if (user?.scope_to_pic) {
    return { sql: "s.created_by = ?", binds: [user.id] };
  }
  return { sql: "", binds: [] as any[] };
}

// ── List ─────────────────────────────────────────────────────
app.get("/entries", requirePermission("sales.read"), async (c) => {
  const user = c.get("user");
  const canManage = user?.permissions?.includes("*") || user?.permissions?.includes("sales.manage");
  const status = c.req.query("status") || "";
  const projectId = parseInt(c.req.query("project_id") || "", 10);
  const search = c.req.query("search") || "";
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const includeArchived = c.req.query("include_archived") === "1";
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (!includeArchived) where.push("s.archived_at IS NULL");
  if (status) {
    where.push("s.status = ?");
    binds.push(status);
  }
  if (!isNaN(projectId)) {
    where.push("s.project_id = ?");
    binds.push(projectId);
  }
  if (dateFrom) {
    where.push("date(s.occurred_at) >= date(?)");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("date(s.occurred_at) <= date(?)");
    binds.push(dateTo);
  }
  if (search) {
    where.push("(s.customer_name LIKE ? OR s.customer_code LIKE ? OR s.notes LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }

  const ownership = buildOwnershipWhere(user, canManage);
  if (ownership.sql) where.push(ownership.sql);
  const fullWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const fullBinds = [...binds, ...ownership.binds];

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM sales_entries s ${fullWhere}`
  )
    .bind(...fullBinds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT s.*,
            u.name as created_by_name,
            u.email as created_by_email,
            p.code as project_code,
            p.name as project_name
       FROM sales_entries s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN projects p ON p.id = s.project_id
       ${fullWhere}
       ORDER BY s.occurred_at DESC, s.id DESC
       LIMIT ? OFFSET ?`
  )
    .bind(...fullBinds, perPage, offset)
    .all();

  // Sum filtered totals for the header tiles.
  const totals = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(s.amount), 0) as total_amount,
            COUNT(*) as total_count,
            COUNT(CASE WHEN s.status = 'draft' THEN 1 END) as draft_count,
            COUNT(CASE WHEN s.status = 'submitted' THEN 1 END) as submitted_count,
            COUNT(CASE WHEN s.status = 'pushed' THEN 1 END) as pushed_count
       FROM sales_entries s
       ${fullWhere}`
  )
    .bind(...fullBinds)
    .first<any>();

  return c.json({
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
    totals: {
      amount: totals?.total_amount ?? 0,
      count: totals?.total_count ?? 0,
      by_status: {
        draft: totals?.draft_count ?? 0,
        submitted: totals?.submitted_count ?? 0,
        pushed: totals?.pushed_count ?? 0,
      },
    },
  });
});

// ── Detail ───────────────────────────────────────────────────
app.get("/entries/:id", requirePermission("sales.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const canManage = user?.permissions?.includes("*") || user?.permissions?.includes("sales.manage");

  const row = await c.env.DB.prepare(
    `SELECT s.*,
            u.name as created_by_name,
            p.code as project_code,
            p.name as project_name
       FROM sales_entries s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!row) return c.json({ error: "Not found" }, 404);

  // Scoped rep can only see own entries.
  if (!canManage && user?.scope_to_pic && row.created_by !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }

  // Fetch UDF values. The UDF layer expects row_key as TEXT so cast id.
  const udf = await c.env.DB.prepare(
    `SELECT field_key, value FROM udf_values
      WHERE table_name = 'sales_entries' AND row_key = ?`
  )
    .bind(String(id))
    .all<{ field_key: string; value: string | null }>();

  const custom: Record<string, string | null> = {};
  for (const r of udf.results ?? []) custom[r.field_key] = r.value;

  return c.json({ entry: row, custom });
});

// ── Create ───────────────────────────────────────────────────
app.post("/entries", requirePermission("sales.write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    project_id?: number | null;
    customer_name?: string;
    customer_code?: string | null;
    amount?: number;
    currency?: string;
    occurred_at?: string;
    notes?: string | null;
    custom?: Record<string, any>;
  }>();

  const customerName = (body.customer_name || "").trim();
  if (!customerName) return c.json({ error: "customer_name is required" }, 400);
  const amount = Number(body.amount);
  if (!isFinite(amount)) return c.json({ error: "amount must be a number" }, 400);
  const occurredAt = (body.occurred_at || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(occurredAt)) {
    return c.json({ error: "occurred_at must be a yyyy-mm-dd date" }, 400);
  }

  const r = await c.env.DB.prepare(
    `INSERT INTO sales_entries
       (project_id, customer_name, customer_code, amount, currency,
        occurred_at, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.project_id ?? null,
      customerName,
      body.customer_code?.trim() || null,
      amount,
      body.currency?.trim() || "MYR",
      occurredAt,
      body.notes?.trim() || null,
      user?.id ?? 0
    )
    .run();

  const id = r.meta.last_row_id as number;

  // Persist custom field values via the existing UDF store. Silent-drop
  // anything with an unknown key so a renamed field doesn't 500 the
  // create — the matching GET will just omit it.
  if (body.custom) {
    await writeCustomFields(c.env, id, body.custom);
  }

  return c.json({ id }, 201);
});

// ── Patch ────────────────────────────────────────────────────
app.patch("/entries/:id", requirePermission("sales.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const canManage = user?.permissions?.includes("*") || user?.permissions?.includes("sales.manage");

  const current = await c.env.DB.prepare(
    `SELECT id, created_by, status FROM sales_entries WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; created_by: number; status: string }>();
  if (!current) return c.json({ error: "Not found" }, 404);

  // Writers can only edit their own drafts. Managers can edit anything.
  if (!canManage) {
    if (current.created_by !== user?.id) {
      return c.json({ error: "You can only edit your own entries" }, 403);
    }
    if (current.status !== "draft") {
      return c.json({ error: "Only draft entries are editable" }, 400);
    }
  }

  const body = await c.req.json<Record<string, any>>();
  const sets: string[] = [];
  const binds: any[] = [];
  const FIELDS = [
    "project_id",
    "customer_name",
    "customer_code",
    "amount",
    "currency",
    "occurred_at",
    "notes",
  ] as const;
  for (const k of FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }

  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    binds.push(id);
    await c.env.DB.prepare(
      `UPDATE sales_entries SET ${sets.join(", ")} WHERE id = ?`
    )
      .bind(...binds)
      .run();
  }

  if (body.custom) {
    await writeCustomFields(c.env, id, body.custom);
  }

  return c.json({ ok: true });
});

// ── Submit (lock as ready for push) ─────────────────────────
app.post("/entries/:id/submit", requirePermission("sales.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const canManage = user?.permissions?.includes("*") || user?.permissions?.includes("sales.manage");

  const current = await c.env.DB.prepare(
    `SELECT id, created_by, status FROM sales_entries WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; created_by: number; status: string }>();
  if (!current) return c.json({ error: "Not found" }, 404);
  if (!canManage && current.created_by !== user?.id) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (current.status !== "draft") {
    return c.json({ error: `Can't submit a ${current.status} entry` }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'submitted', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Unsubmit (back to draft; managers only) ──────────────────
app.post("/entries/:id/unsubmit", requirePermission("sales.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'draft', updated_at = datetime('now')
      WHERE id = ? AND status = 'submitted'`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Void ─────────────────────────────────────────────────────
app.post("/entries/:id/void", requirePermission("sales.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'void', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Delete (soft) ────────────────────────────────────────────
app.delete("/entries/:id", requirePermission("sales.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const canManage = user?.permissions?.includes("*") || user?.permissions?.includes("sales.manage");

  const row = await c.env.DB.prepare(
    `SELECT created_by, status FROM sales_entries WHERE id = ?`
  )
    .bind(id)
    .first<{ created_by: number; status: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!canManage) {
    if (row.created_by !== user?.id) return c.json({ error: "Forbidden" }, 403);
    if (row.status !== "draft")
      return c.json({ error: "Only drafts can be deleted" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE sales_entries SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Push to AutoCount ────────────────────────────────────────
// Placeholder — the actual push handler lives behind AutoCount's write
// surface which is currently disabled (backend/src/services/autocount.ts
// AUTOCOUNT_WRITES_DISABLED). Flipping this to a real push is a separate
// change; for now the endpoint exists so the frontend can wire the
// "Push" button without a 404.
app.post("/entries/:id/push", requirePermission("sales.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  return c.json(
    {
      error:
        "AutoCount push is not yet enabled. Entries will be pushed once the write surface is unlocked.",
    },
    501
  );
});

// ── Helper: write custom field values ────────────────────────
async function writeCustomFields(
  env: Env,
  entryId: number,
  custom: Record<string, any>
) {
  // Fetch the defined fields once, filter incoming keys against them.
  const defs = await env.DB.prepare(
    `SELECT field_key FROM udf_fields WHERE table_name = 'sales_entries'`
  ).all<{ field_key: string }>();
  const allowed = new Set((defs.results ?? []).map((d) => d.field_key));

  for (const [key, rawValue] of Object.entries(custom)) {
    if (!allowed.has(key)) continue;
    const value =
      rawValue === null || rawValue === undefined ? null : String(rawValue);
    await env.DB.prepare(
      `INSERT INTO udf_values (table_name, row_key, field_key, value, updated_at)
       VALUES ('sales_entries', ?, ?, ?, datetime('now'))
       ON CONFLICT(table_name, row_key, field_key)
       DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
      .bind(String(entryId), key, value)
      .run();
  }
}

export default app;
