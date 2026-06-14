/**
 * Sales Team module — retail rep org chart.
 *
 * Separate from the workspace `users` directory ([routes/users.ts]).
 * A workspace user may or may not be a sales rep, and a sales rep
 * may or may not have a workspace login. The optional 1:1 link
 * lives on `sales_reps.user_id`.
 *
 * Endpoints (all under /api/sales-team):
 *   GET    /reps                 — list w/ filters
 *   POST   /reps                 — register new rep
 *   GET    /reps/:id             — detail incl. brands + downline counts
 *   PATCH  /reps/:id             — partial update
 *   DELETE /reps/:id             — soft delete
 *   PUT    /reps/:id/admin       — toggle is_admin
 *   PUT    /reps/:id/brands      — replace brand set
 *   GET    /reps/:id/activity    — audit log
 *   GET / POST / PATCH / DELETE / PUT-reorder /positions[/:id][/reorder]
 *   GET / POST / PATCH / DELETE  /commission-tiers[/:id]
 *   POST   /reset-positions      — wipe + re-seed positions only
 *
 * Future work (not done here, see CLAUDE.md decisions):
 *  - Bulk CSV import. The expected column shape is:
 *      code, name, phone, email, position_slug, upline_code, brands(|-separated),
 *      status, commission_rate, joined_on, notes
 *  - Two-way AutoCount sync (currently pull-only, no push).
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import {
  nextSalesRepCode,
  wouldCreateUplineCycle,
  subtreeRepIds,
  logSalesTeamActivity,
  autoBackfillSalesReps,
} from "../services/salesTeam";

const app = new Hono<{ Bindings: Env }>();

// ── Helpers ───────────────────────────────────────────────────

async function fetchRepWithBrands(
  env: Env,
  id: number,
): Promise<RepWithBrands | null> {
  const rep = await env.DB.prepare(
    `SELECT r.*, p.slug AS position_slug, p.name AS position_name, p.level AS position_level,
            t.slug AS tier_slug, t.name AS tier_name, t.rate AS tier_rate,
            up.code AS upline_code, up.name AS upline_name,
            u.email AS user_email, u.name AS user_name
       FROM sales_reps r
       LEFT JOIN sales_positions p          ON p.id = r.position_id
       LEFT JOIN sales_commission_tiers t   ON t.id = r.commission_tier_id
       LEFT JOIN sales_reps up              ON up.id = r.upline_id
       LEFT JOIN users u                    ON u.id = r.user_id
      WHERE r.id = ?`,
  )
    .bind(id)
    .first<any>();
  if (!rep) return null;
  const brandRows = await env.DB.prepare(
    `SELECT brand FROM sales_rep_brands WHERE rep_id = ?`,
  )
    .bind(id)
    .all<{ brand: string }>();
  return { ...rep, brands: (brandRows.results ?? []).map((b) => b.brand) };
}

interface RepWithBrands {
  id: number;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  position_id: number | null;
  upline_id: number | null;
  user_id: number | null;
  status: string;
  is_admin: number;
  commission_rate: number | null;
  commission_tier_id: number | null;
  joined_on: string | null;
  notes: string | null;
  archived_at: string | null;
  brands: string[];
  position_slug?: string | null;
  position_name?: string | null;
  position_level?: number | null;
  tier_slug?: string | null;
  tier_name?: string | null;
  tier_rate?: number | null;
  upline_code?: string | null;
  upline_name?: string | null;
  user_email?: string | null;
  user_name?: string | null;
}

async function setBrands(
  env: Env,
  repId: number,
  brands: string[] | undefined,
): Promise<void> {
  if (brands === undefined) return;
  await env.DB.prepare(`DELETE FROM sales_rep_brands WHERE rep_id = ?`)
    .bind(repId)
    .run();
  for (const b of brands) {
    const trimmed = (b ?? "").trim();
    if (!trimmed) continue;
    await env.DB.prepare(
      `INSERT INTO sales_rep_brands (rep_id, brand) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(repId, trimmed)
      .run();
  }
}

// ── Reps ─────────────────────────────────────────────────────

app.get("/reps", requirePermission("sales_team.read"), async (c) => {
  // Self-heal: ensure every user currently in the Sales department has
  // a linked sales_reps row. Cheap when there's no drift (one indexed
  // query); only does write work the first time after a user lands in
  // Sales without going through the PATCH hook in users.ts.
  await autoBackfillSalesReps(c.env);

  const status = c.req.query("status") || "";
  const positionSlug = c.req.query("position") || "";
  const brand = c.req.query("brand") || "";
  const q = c.req.query("q") || "";
  const includeArchived = c.req.query("include_archived") === "1";

  const where: string[] = [];
  const binds: any[] = [];
  if (!includeArchived) where.push("r.archived_at IS NULL");
  if (status === "active" || status === "inactive") {
    where.push("r.status = ?");
    binds.push(status);
  }
  if (positionSlug) {
    where.push("p.slug = ?");
    binds.push(positionSlug);
  }
  if (brand) {
    where.push(
      `r.id IN (SELECT rep_id FROM sales_rep_brands WHERE brand = ?)`,
    );
    binds.push(brand);
  }
  if (q) {
    where.push(
      "(r.name LIKE ? OR r.code LIKE ? OR r.phone LIKE ? OR r.email LIKE ?)",
    );
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Team-size = count of direct + indirect reports. Computed via a
  // recursive CTE so the count reflects the entire subtree.
  const sql = `
    WITH RECURSIVE downline(root_id, descendant_id) AS (
      SELECT id, id FROM sales_reps WHERE archived_at IS NULL
      UNION ALL
      SELECT d.root_id, r.id
        FROM downline d
        JOIN sales_reps r ON r.upline_id = d.descendant_id
       WHERE r.archived_at IS NULL
    )
    SELECT r.*,
           p.slug  AS position_slug,
           p.name  AS position_name,
           p.level AS position_level,
           up.code AS upline_code,
           up.name AS upline_name,
           u.email AS user_email,
           u.name  AS user_name,
           (SELECT COUNT(*) - 1 FROM downline d WHERE d.root_id = r.id) AS team_size,
           (SELECT string_agg(brand, ',') FROM sales_rep_brands WHERE rep_id = r.id) AS brands_csv
      FROM sales_reps r
      LEFT JOIN sales_positions p ON p.id = r.position_id
      LEFT JOIN sales_reps up      ON up.id = r.upline_id
      LEFT JOIN users u            ON u.id = r.user_id
      ${whereSql}
      ORDER BY p.level ASC NULLS LAST, r.code ASC
  `;
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<any>();
  const data = (rows.results ?? []).map((r: any) => ({
    ...r,
    brands: r.brands_csv ? String(r.brands_csv).split(",") : [],
    brands_csv: undefined,
  }));
  return c.json({ data });
});

app.post("/reps", requirePermission("sales_team.manage"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    code?: string;
    name?: string;
    phone?: string | null;
    email?: string | null;
    position_id?: number | null;
    upline_id?: number | null;
    user_id?: number | null;
    status?: "active" | "inactive";
    commission_rate?: number | null;
    commission_tier_id?: number | null;
    joined_on?: string | null;
    notes?: string | null;
    brands?: string[];
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const code = (body.code || "").trim() || (await nextSalesRepCode(c.env));

  const r = await c.env.DB.prepare(
    `INSERT INTO sales_reps
       (code, name, phone, email, position_id, upline_id, user_id, status,
        commission_rate, commission_tier_id, joined_on, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      code,
      name,
      body.phone ?? null,
      body.email ?? null,
      body.position_id ?? null,
      body.upline_id ?? null,
      body.user_id ?? null,
      body.status === "inactive" ? "inactive" : "active",
      body.commission_rate ?? null,
      body.commission_tier_id ?? null,
      body.joined_on ?? null,
      body.notes ?? null,
    )
    .run();
  const id = r.meta.last_row_id as number;
  await setBrands(c.env, id, body.brands);
  await logSalesTeamActivity(c.env, id, "created", null, code, null, user?.id ?? null);
  return c.json({ id, code }, 201);
});

app.get("/reps/:id", requirePermission("sales_team.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const rep = await fetchRepWithBrands(c.env, id);
  if (!rep) return c.json({ error: "Not found" }, 404);
  // Direct + indirect downline counts.
  const subtree = await subtreeRepIds(c.env, id);
  const directCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sales_reps WHERE upline_id = ? AND archived_at IS NULL`,
  )
    .bind(id)
    .first<{ n: number }>();
  return c.json({
    rep,
    direct_count: directCount?.n ?? 0,
    subtree_count: subtree.size - 1, // exclude self
  });
});

const PATCH_FIELDS = [
  "name",
  "phone",
  "email",
  "nric",
  "position_id",
  "upline_id",
  "upline_secondary_id",
  "user_id",
  "status",
  "commission_rate",
  "commission_min_rate",
  "commission_tier_id",
  "joined_on",
  "notes",
] as const;

app.patch("/reps/:id", requirePermission("sales_team.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();

  // Fetch the current row for diffing into the audit log.
  const before = await c.env.DB.prepare(
    `SELECT id, code, position_id, upline_id, status FROM sales_reps WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: number; code: string; position_id: number | null; upline_id: number | null; status: string }>();
  if (!before) return c.json({ error: "Not found" }, 404);

  // Cycle check on upline change.
  if ("upline_id" in body && body.upline_id != null) {
    const cycle = await wouldCreateUplineCycle(c.env, id, Number(body.upline_id));
    if (cycle) {
      return c.json(
        { error: "Cannot set upline to self or to a downstream rep — that would create a cycle." },
        400,
      );
    }
  }

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    binds.push(id);
    await c.env.DB.prepare(
      `UPDATE sales_reps SET ${sets.join(", ")} WHERE id = ?`,
    )
      .bind(...binds)
      .run();
  }

  // Brands (replace if provided).
  if ("brands" in body) {
    await setBrands(c.env, id, body.brands as string[] | undefined);
    await logSalesTeamActivity(c.env, id, "brand_change", null, null, null, user?.id ?? null);
  }

  // Audit per-field for the interesting changes.
  if ("position_id" in body && body.position_id !== before.position_id) {
    await logSalesTeamActivity(
      c.env, id, "position_change",
      before.position_id != null ? String(before.position_id) : null,
      body.position_id != null ? String(body.position_id) : null,
      null, user?.id ?? null,
    );
  }
  if ("upline_id" in body && body.upline_id !== before.upline_id) {
    await logSalesTeamActivity(
      c.env, id, "upline_change",
      before.upline_id != null ? String(before.upline_id) : null,
      body.upline_id != null ? String(body.upline_id) : null,
      null, user?.id ?? null,
    );
  }
  if ("status" in body && body.status !== before.status) {
    await logSalesTeamActivity(
      c.env, id, "status_change",
      before.status, String(body.status), null, user?.id ?? null,
    );
  }

  return c.json({ ok: true });
});

app.delete("/reps/:id", requirePermission("sales_team.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  // Soft delete only — orders keep their `sales_rep_id` reference
  // even after delete.
  await c.env.DB.prepare(
    `UPDATE sales_reps SET archived_at = datetime('now'), archived_by = ?, status = 'inactive', updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(user?.id ?? null, id)
    .run();
  await logSalesTeamActivity(c.env, id, "deleted", null, null, null, user?.id ?? null);
  return c.json({ ok: true });
});

app.put("/reps/:id/admin", requirePermission("sales_team.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{ is_admin: boolean }>();
  const next = body.is_admin ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE sales_reps SET is_admin = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(next, id)
    .run();
  await logSalesTeamActivity(
    c.env, id, "admin_toggle",
    next ? "0" : "1", next ? "1" : "0", null, user?.id ?? null,
  );
  return c.json({ ok: true });
});

app.put("/reps/:id/brands", requirePermission("sales_team.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{ brands: string[] }>();
  await setBrands(c.env, id, body.brands ?? []);
  await logSalesTeamActivity(c.env, id, "brand_change", null, null, null, user?.id ?? null);
  return c.json({ ok: true });
});

// Per-rep commission tiers (mig 068). The maintenance-page tier list
// is the global default; this lets each rep override with custom
// thresholds. PUT replaces the whole set in one call.

app.get("/reps/:id/commission-tiers", requirePermission("sales_team.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT id, threshold, rate, sort_order
       FROM sales_rep_commission_tiers
      WHERE rep_id = ?
      ORDER BY sort_order ASC, threshold ASC, id ASC`,
  )
    .bind(id)
    .all();
  return c.json({ data: rows.results ?? [] });
});

app.put("/reps/:id/commission-tiers", requirePermission("sales_team.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    tiers: { threshold: number; rate: number }[];
  }>();
  const tiers = Array.isArray(body.tiers) ? body.tiers : [];
  // Wipe + re-insert. Tier rows are short-lived per rep; no audit
  // trail for the individual tier rows (the rep-level audit log
  // gets one "tier_change" entry summarising the edit).
  await c.env.DB.prepare(
    `DELETE FROM sales_rep_commission_tiers WHERE rep_id = ?`,
  )
    .bind(id)
    .run();
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const threshold = Number(t.threshold);
    const rate = Number(t.rate);
    if (!Number.isFinite(threshold) || !Number.isFinite(rate)) continue;
    if (threshold < 0 || rate < 0) continue;
    await c.env.DB.prepare(
      `INSERT INTO sales_rep_commission_tiers (rep_id, threshold, rate, sort_order)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(id, threshold, rate, i * 10)
      .run();
  }
  await logSalesTeamActivity(
    c.env, id, "tier_change", null, String(tiers.length), null, user?.id ?? null,
  );
  return c.json({ ok: true, count: tiers.length });
});

app.get("/reps/:id/activity", requirePermission("sales_team.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT a.*, u.name AS user_name
       FROM sales_team_activity a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.rep_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 200`,
  )
    .bind(id)
    .all();
  return c.json({ data: rows.results ?? [] });
});

// ── Lookup CRUD (positions + commission tiers) ──────────────
// Mirrors the assr lookup pattern at routes/assr.ts:75. Two `kinds`
// supported: 'positions' (extra `level` column) and
// 'commission-tiers' (extra `rate` column).

const LOOKUP_TABLES = {
  positions: "sales_positions",
  "commission-tiers": "sales_commission_tiers",
} as const;
type LookupKind = keyof typeof LOOKUP_TABLES;
function lookupTable(kind: string): string | null {
  return (LOOKUP_TABLES as Record<string, string>)[kind] ?? null;
}

app.get("/lookups/:kind", requirePermission("sales_team.read"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const includeInactive = c.req.query("include_inactive") === "1";
  const extraCol =
    kind === "positions" ? ", level" : kind === "commission-tiers" ? ", rate" : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, slug, name, sort_order, active${extraCol}
       FROM ${table}
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY sort_order ASC, name ASC`,
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.post("/lookups/:kind", requirePermission("sales_team.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const body = await c.req.json<{
    name: string;
    slug?: string;
    sort_order?: number;
    level?: number;
    rate?: number;
  }>();
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const slug =
    body.slug?.trim() ||
    name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const sortOrder = Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0;
  if (kind === "positions") {
    const level = Number.isFinite(body.level) ? Number(body.level) : 20;
    await c.env.DB.prepare(
      `INSERT INTO sales_positions (slug, name, level, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(slug, name, level, sortOrder)
      .run();
  } else {
    const rate = Number.isFinite(body.rate) ? Number(body.rate) : 0;
    await c.env.DB.prepare(
      `INSERT INTO sales_commission_tiers (slug, name, rate, active) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING`,
    )
      .bind(slug, name, rate)
      .run();
  }
  return c.json({ ok: true, slug });
});

app.patch("/lookups/:kind/:id", requirePermission("sales_team.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<Record<string, any>>();
  const allowed = ["name", "sort_order", "active"];
  if (kind === "positions") allowed.push("level");
  if (kind === "commission-tiers") allowed.push("rate");
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return c.json({ error: "no fields to update" }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

app.delete("/lookups/:kind/:id", requirePermission("sales_team.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Soft-delete only — historical reps may still reference this row.
  await c.env.DB.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`)
    .bind(id)
    .run();
  return c.json({ ok: true });
});

app.put("/lookups/:kind/reorder", requirePermission("sales_team.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const body = await c.req.json<{ ids: number[] }>();
  const ids = Array.isArray(body.ids) ? body.ids : [];
  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`)
      .bind((i + 1) * 10, ids[i])
      .run();
  }
  return c.json({ ok: true });
});

// ── Reset positions ──────────────────────────────────────────
// Wipes + re-seeds the canonical 3 positions. Reps keep their
// position_id (set to NULL by FK ON DELETE) until reassigned via
// the maintenance UI.

app.post("/reset-positions", requirePermission("sales_team.manage"), async (c) => {
  // sales_reps.position_id was ON DELETE SET NULL, but the D1->PG load dropped
  // it to NO ACTION — so wiping sales_positions throws if any rep still points
  // at one. Null them first.
  await c.env.DB.prepare(`UPDATE sales_reps SET position_id = NULL WHERE position_id IS NOT NULL`).run();
  await c.env.DB.prepare(`DELETE FROM sales_positions`).run();
  await c.env.DB.prepare(
    `INSERT INTO sales_positions (slug, name, level, sort_order) VALUES
       ('director',     'Sales Director',  10, 10),
       ('executive',    'Sales Executive', 20, 20),
       ('sub_executive','Sub-Executive',   30, 30)`,
  ).run();
  return c.json({ ok: true });
});

export default app;
