import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import {
  createProject,
  patchProject,
  getProjectDetail,
  listProjects,
  patchFinance,
  createChecklistItem,
  patchChecklistItem,
  setChecklistStatus,
  deleteChecklistItem,
  logProjectActivity,
  addChecklistComment,
  submitChecklistForReview,
  rejectChecklistItem,
  amendChecklistItem,
  approveChecklistItem,
  createDefect,
  patchDefect,
  archiveDefect,
  createSalesReport,
  archiveSalesReport,
  syncSalesTotalFromReports,
  createLedgerLine,
  patchLedgerLine,
  archiveLedgerLine,
  syncFinanceRollup,
  LEDGER_COST_CATEGORIES,
  LEDGER_INCOME_CATEGORIES,
  MALAYSIA_STATES,
  PAYMENT_STATUSES,
  setPaymentStatus,
  createStockTransfer,
  confirmStockTransfer,
  unconfirmStockTransfer,
  archiveStockTransfer,
} from "../services/projects";
import {
  getProjectPicScope,
  projectAccessLevel,
  canSeeProject,
} from "../services/projectAcl";

const app = new Hono<{ Bindings: Env }>();

// ── Event types + brand constants ─────────────────────────────
// Shipped as part of the projects API so the frontend doesn't need
// to hard-code the list (brands excepted — they're a DB CHECK).

app.get("/event-types", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, slug, name, default_template_id, sort_order
       FROM project_event_types
      WHERE active = 1
      ORDER BY sort_order, name`
  ).all();
  return c.json({ data: rows.results ?? [] });
});

// Brands are fixed by the DB CHECK constraint — return them here so
// the frontend picker stays in sync without duplicating the list.
app.get("/brands", (c) => {
  return c.json({
    data: [
      "AKEMI",
      "ZANOTTI",
      "DUNLOPILLO",
      "ERGOTEX",
      "MY SOFA FACTORY",
      "AKEMI C&C",
    ],
  });
});

// ── Summary (dashboard tiles) ─────────────────────────────────

app.get("/summary", requirePermission("projects.read"), async (c) => {
  const byStage = await c.env.DB.prepare(
    `SELECT stage, COUNT(*) as count
       FROM projects WHERE archived_at IS NULL
      GROUP BY stage`
  ).all();

  const upcoming = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM projects
      WHERE archived_at IS NULL
        AND stage NOT IN ('closed','cancelled')
        AND start_date IS NOT NULL
        AND date(start_date) >= date('now')
        AND date(start_date) <= date('now', '+30 days')`
  ).first<{ count: number }>();

  const live = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM projects
      WHERE archived_at IS NULL AND stage = 'live'`
  ).first<{ count: number }>();

  // Overdue checklist items across all open projects
  const overdueTasks = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
      WHERE p.archived_at IS NULL
        AND c.status = 'pending'
        AND c.due_date IS NOT NULL
        AND date(c.due_date) < date('now')`
  ).first<{ count: number }>();

  return c.json({
    by_stage: byStage.results ?? [],
    upcoming_30d: upcoming?.count ?? 0,
    live_count: live?.count ?? 0,
    overdue_tasks: overdueTasks?.count ?? 0,
  });
});

// ── List ──────────────────────────────────────────────────────

app.get("/", requirePermission("projects.read"), async (c) => {
  const eventTypeParam = c.req.query("event_type_id");
  const yearParam = c.req.query("year");
  const monthParam = c.req.query("month");
  const user = c.get("user");
  const picScope = getProjectPicScope(user) ?? undefined;
  const result = await listProjects(c.env, {
    stage: c.req.query("stage"),
    brand: c.req.query("brand"),
    state: c.req.query("state") || undefined,
    event_type_id: eventTypeParam ? parseInt(eventTypeParam, 10) : undefined,
    search: c.req.query("search"),
    year: yearParam ? parseInt(yearParam, 10) : undefined,
    month: monthParam ? parseInt(monthParam, 10) : undefined,
    page: parseInt(c.req.query("page") || "1", 10),
    per_page: parseInt(c.req.query("per_page") || "50", 10),
    include_archived: c.req.query("include_archived") === "1",
    sort_by: c.req.query("sort_by") || undefined,
    sort_dir: (c.req.query("sort_dir") || "").toLowerCase() === "asc" ? "asc" : "desc",
    pic_scope: picScope,
  });
  return c.json(result);
});

// Expose the canonical states + payment-status lists to the frontend
// so pickers stay in sync with the backend without duplicating.
app.get("/states", (c) => c.json({ data: MALAYSIA_STATES }));
app.get("/payment-statuses", (c) => c.json({ data: PAYMENT_STATUSES }));

// ── Organizers (lookup) ──────────────────────────────────────
// Free-form names but de-duplicated centrally so the picker stays clean.
// The actual projects.organizer column remains free text — this table
// is a convenience source for the dropdown.

app.get("/organizers", requirePermission("projects.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, notes, active FROM project_organizers
      WHERE active = 1 ORDER BY name`
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.post("/organizers", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string; notes?: string }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  // Idempotent on (name) — return the existing row if it already exists.
  const existing = await c.env.DB.prepare(
    `SELECT id, name FROM project_organizers WHERE name = ? COLLATE NOCASE`
  )
    .bind(name)
    .first<{ id: number; name: string }>();
  if (existing) {
    // Reactivate if previously archived.
    await c.env.DB.prepare(
      `UPDATE project_organizers SET active = 1 WHERE id = ?`
    )
      .bind(existing.id)
      .run();
    return c.json({ id: existing.id, name: existing.name }, 200);
  }
  const r = await c.env.DB.prepare(
    `INSERT INTO project_organizers (name, notes, created_by)
     VALUES (?, ?, ?)`
  )
    .bind(name, body.notes ?? null, user?.id ?? null)
    .run();
  return c.json({ id: r.meta.last_row_id, name }, 201);
});

app.delete("/organizers/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await c.env.DB.prepare(
    `UPDATE project_organizers SET active = 0 WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Venues ────────────────────────────────────────────────────
// Same shape as organizers — picker-backed lookup, free-text column on
// `projects.venue` stays valid so legacy data still renders.

app.get("/venues", requirePermission("projects.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, state, notes, active FROM project_venues
      WHERE active = 1 ORDER BY name`
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.post("/venues", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    name?: string;
    state?: string | null;
    notes?: string | null;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const existing = await c.env.DB.prepare(
    `SELECT id, name, state FROM project_venues WHERE name = ? COLLATE NOCASE`
  )
    .bind(name)
    .first<{ id: number; name: string; state: string | null }>();
  if (existing) {
    // Reactivate + update state/notes if user supplied them.
    await c.env.DB.prepare(
      `UPDATE project_venues
          SET active = 1,
              state  = COALESCE(?, state),
              notes  = COALESCE(?, notes)
        WHERE id = ?`
    )
      .bind(body.state ?? null, body.notes ?? null, existing.id)
      .run();
    return c.json({ id: existing.id, name: existing.name, state: existing.state }, 200);
  }
  const r = await c.env.DB.prepare(
    `INSERT INTO project_venues (name, state, notes, created_by)
     VALUES (?, ?, ?, ?)`
  )
    .bind(name, body.state ?? null, body.notes ?? null, user?.id ?? null)
    .run();
  return c.json({ id: r.meta.last_row_id, name, state: body.state ?? null }, 201);
});

app.patch("/venues/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    name?: string;
    state?: string | null;
    notes?: string | null;
  }>();
  const sets: string[] = [];
  const binds: any[] = [];
  if ("name" in body) {
    const next = (body.name || "").trim();
    if (!next) return c.json({ error: "name cannot be empty" }, 400);
    sets.push("name = ?");
    binds.push(next);
  }
  if ("state" in body) {
    sets.push("state = ?");
    binds.push(body.state ?? null);
  }
  if ("notes" in body) {
    sets.push("notes = ?");
    binds.push(body.notes ?? null);
  }
  if (sets.length === 0) return c.json({ ok: true });
  await c.env.DB.prepare(
    `UPDATE project_venues SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds, id)
    .run();
  return c.json({ ok: true });
});

app.delete("/venues/:id", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await c.env.DB.prepare(`UPDATE project_venues SET active = 0 WHERE id = ?`)
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Default checklist templates ───────────────────────────────
// Each project_event_type has a default_template_id pointing at a
// project_checklist_templates row. Items live in
// project_checklist_template_items. These routes let admins manage
// the template body that gets cloned into every new project.

app.get("/checklist-templates", requirePermission("projects.read"), async (c) => {
  const templates = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description,
            (SELECT COUNT(*) FROM project_checklist_template_items WHERE template_id = t.id) AS item_count,
            (SELECT GROUP_CONCAT(et.name, ', ')
               FROM project_event_types et
              WHERE et.default_template_id = t.id) AS used_by
       FROM project_checklist_templates t
      ORDER BY t.name`
  ).all();
  return c.json({ data: templates.results ?? [] });
});

app.get(
  "/checklist-templates/:id/items",
  requirePermission("projects.read"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const rows = await c.env.DB.prepare(
      `SELECT id, seq, title, description, required_perm, due_offset_days
         FROM project_checklist_template_items
        WHERE template_id = ?
        ORDER BY seq, id`
    )
      .bind(id)
      .all();
    return c.json({ data: rows.results ?? [] });
  }
);

app.post(
  "/checklist-templates/:id/items",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{
      title?: string;
      description?: string | null;
      required_perm?: string | null;
      due_offset_days?: number | null;
      seq?: number;
    }>();
    const title = (body.title || "").trim();
    if (!title) return c.json({ error: "title required" }, 400);
    // If no seq given, append at end.
    let seq = body.seq;
    if (seq == null) {
      const maxRow = await c.env.DB.prepare(
        `SELECT MAX(seq) AS s FROM project_checklist_template_items WHERE template_id = ?`
      )
        .bind(id)
        .first<{ s: number | null }>();
      seq = (maxRow?.s ?? 0) + 10;
    }
    const r = await c.env.DB.prepare(
      `INSERT INTO project_checklist_template_items
         (template_id, seq, title, description, required_perm, due_offset_days)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        seq,
        title,
        body.description ?? null,
        body.required_perm ?? null,
        body.due_offset_days ?? null
      )
      .run();
    return c.json({ id: r.meta.last_row_id, seq }, 201);
  }
);

app.patch(
  "/checklist-templates/items/:itemId",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("itemId"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{
      title?: string;
      description?: string | null;
      required_perm?: string | null;
      due_offset_days?: number | null;
      seq?: number;
    }>();
    const sets: string[] = [];
    const binds: any[] = [];
    if ("title" in body) {
      const t = (body.title || "").trim();
      if (!t) return c.json({ error: "title cannot be empty" }, 400);
      sets.push("title = ?");
      binds.push(t);
    }
    for (const k of ["description", "required_perm", "due_offset_days", "seq"] as const) {
      if (k in body) {
        sets.push(`${k} = ?`);
        binds.push((body as any)[k] ?? null);
      }
    }
    if (sets.length === 0) return c.json({ ok: true });
    await c.env.DB.prepare(
      `UPDATE project_checklist_template_items SET ${sets.join(", ")} WHERE id = ?`
    )
      .bind(...binds, id)
      .run();
    return c.json({ ok: true });
  }
);

app.delete(
  "/checklist-templates/items/:itemId",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("itemId"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    await c.env.DB.prepare(
      `DELETE FROM project_checklist_template_items WHERE id = ?`
    )
      .bind(id)
      .run();
    return c.json({ ok: true });
  }
);

app.put(
  "/event-types/:id/default-template",
  requirePermission("projects.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{ template_id: number | null }>();
    await c.env.DB.prepare(
      `UPDATE project_event_types SET default_template_id = ? WHERE id = ?`
    )
      .bind(body.template_id ?? null, id)
      .run();
    return c.json({ ok: true });
  }
);

// ── Analytics / profitability ────────────────────────────────
// Aggregates the finance ledger across non-archived projects. All
// slices (by brand / state / event type / month) share a common
// project list defined by the filter set, so drilling into any
// dimension reflects the same scope.

app.get("/analytics/profitability", requirePermission("projects.read"), async (c) => {
  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");
  const brand = c.req.query("brand");
  const eventTypeParam = c.req.query("event_type_id");
  const organizer = c.req.query("organizer");

  const where: string[] = ["p.archived_at IS NULL"];
  const binds: any[] = [];
  // Date filter applies to start_date — overlapping window is harder
  // to reason about across by-month grouping, so keep it strict.
  if (dateFrom) {
    where.push("date(p.start_date) >= date(?)");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("date(p.start_date) <= date(?)");
    binds.push(dateTo);
  }
  if (brand) {
    where.push("p.brand = ?");
    binds.push(brand);
  }
  if (eventTypeParam) {
    where.push("p.event_type_id = ?");
    binds.push(parseInt(eventTypeParam, 10));
  }
  if (organizer) {
    where.push("p.organizer = ?");
    binds.push(organizer);
  }
  const whereSql = where.join(" AND ");

  // Sum income and cost per project via a single query. Keep
  // project_finance as the rollup source — it's already kept in
  // sync by the ledger write path, and it's 1:1 with projects so
  // this joins clean.
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.organizer, p.venue,
            p.start_date, p.end_date, p.size_sqm,
            et.name as event_type_name,
            COALESCE(pf.total_sales, 0) as income,
            COALESCE(pf.rental, 0) + COALESCE(pf.contractor_cost, 0)
              + COALESCE(pf.license_fee, 0) + COALESCE(pf.misc_cost, 0)
              - COALESCE(pf.deposit_refund, 0) as cost,
            CASE WHEN p.end_date IS NOT NULL AND p.start_date IS NOT NULL
                 THEN CAST(julianday(p.end_date) - julianday(p.start_date) + 1 AS INTEGER)
                 ELSE NULL
            END as duration_days
       FROM projects p
       LEFT JOIN project_finance pf ON pf.project_id = p.id
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
      WHERE ${whereSql}`
  )
    .bind(...binds)
    .all<{
      id: number;
      code: string;
      name: string;
      brand: string | null;
      organizer: string | null;
      venue: string | null;
      start_date: string | null;
      end_date: string | null;
      size_sqm: number | null;
      event_type_name: string | null;
      income: number;
      cost: number;
      duration_days: number | null;
    }>();

  const projects = rows.results ?? [];

  // Headline totals
  const total_projects = projects.length;
  const total_income = projects.reduce((s, r) => s + (r.income || 0), 0);
  const total_cost = projects.reduce((s, r) => s + (r.cost || 0), 0);
  const total_profit = total_income - total_cost;
  const overall_margin = total_income > 0 ? (total_profit / total_income) * 100 : null;

  // Group helper
  function groupBy<K extends string>(
    keyFn: (r: (typeof projects)[number]) => K | null
  ): { key: K; count: number; income: number; cost: number; profit: number; margin: number | null }[] {
    const map = new Map<K, { count: number; income: number; cost: number }>();
    for (const r of projects) {
      const k = keyFn(r);
      if (!k) continue;
      const cur = map.get(k) ?? { count: 0, income: 0, cost: 0 };
      cur.count += 1;
      cur.income += r.income || 0;
      cur.cost += r.cost || 0;
      map.set(k, cur);
    }
    return [...map.entries()]
      .map(([key, v]) => ({
        key,
        count: v.count,
        income: v.income,
        cost: v.cost,
        profit: v.income - v.cost,
        margin: v.income > 0 ? ((v.income - v.cost) / v.income) * 100 : null,
      }))
      .sort((a, b) => b.profit - a.profit);
  }

  const by_brand = groupBy((r) => r.brand);
  const by_organizer = groupBy((r) => r.organizer);
  const by_venue = groupBy((r) => r.venue);
  const by_event_type = groupBy((r) => r.event_type_name);
  // YYYY-MM bucket from start_date
  const by_month = groupBy((r) =>
    r.start_date ? r.start_date.slice(0, 7) : null
  ).sort((a, b) => a.key.localeCompare(b.key));

  // Top / bottom events by profit
  const ranked = [...projects]
    .filter((r) => (r.income || 0) > 0 || (r.cost || 0) > 0)
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      brand: r.brand,
      venue: r.venue,
      start_date: r.start_date,
      income: r.income,
      cost: r.cost,
      profit: r.income - r.cost,
      margin: r.income > 0 ? ((r.income - r.cost) / r.income) * 100 : null,
    }))
    .sort((a, b) => b.profit - a.profit);
  const top = ranked.slice(0, 5);
  const bottom = ranked.slice(-5).reverse();

  return c.json({
    filters: {
      date_from: dateFrom ?? null,
      date_to: dateTo ?? null,
      brand: brand ?? null,
      event_type_id: eventTypeParam ?? null,
      organizer: organizer ?? null,
    },
    totals: {
      projects: total_projects,
      income: total_income,
      cost: total_cost,
      profit: total_profit,
      margin_pct: overall_margin,
    },
    by_brand,
    by_organizer,
    by_event_type,
    by_venue,
    by_month,
    top,
    bottom,
  });
});

// ── Detail ────────────────────────────────────────────────────

app.get("/:id", requirePermission("projects.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const detail = await getProjectDetail(c.env, id);
  if (!detail) return c.json({ error: "Not found" }, 404);
  if (!canSeeProject(user, detail.project)) {
    return c.json({ error: "Not found" }, 404);
  }
  // Tell the frontend which panels to hide for this user/project.
  const access = {
    level: projectAccessLevel(user, detail.project),
    is_pic: detail.project.pic_id === user.id,
    scoped: !!user.scope_to_pic,
  };
  return c.json({ ...detail, _access: access });
});

// ── Create ────────────────────────────────────────────────────

app.post("/", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    name?: string;
    event_type_id?: number;
    brand?: string;
    start_date?: string;
    end_date?: string;
    venue?: string;
    state?: string;
    organizer?: string;
    notion_url?: string;
    pic_id?: number | null;
  }>();
  if (!body.name || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  // Scoped users (sales reps) can only create projects where they or
  // their manager is the PIC. Ignore any other pic_id they submit.
  let picId = body.pic_id ?? null;
  if (user?.scope_to_pic) {
    const allowed = [user.id, user.manager_id].filter(Boolean);
    if (picId == null || !allowed.includes(picId)) {
      picId = user.id;
    }
  }
  const result = await createProject(c.env, {
    name: body.name.trim(),
    event_type_id: body.event_type_id ?? null,
    brand: body.brand ?? null,
    start_date: body.start_date ?? null,
    end_date: body.end_date ?? null,
    venue: body.venue ?? null,
    state: body.state ?? null,
    organizer: body.organizer ?? null,
    notion_url: body.notion_url ?? null,
    pic_id: picId,
    created_by: user?.id ?? 0,
  });
  return c.json(result, 201);
});

// ── Patch ─────────────────────────────────────────────────────

app.patch("/:id", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();

  // Gate: scoped users can only patch projects they can see. And
  // they cannot reassign pic_id away from themselves/their manager.
  if (user?.scope_to_pic) {
    const row = await c.env.DB.prepare(
      `SELECT pic_id FROM projects WHERE id = ?`
    )
      .bind(id)
      .first<{ pic_id: number | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (!canSeeProject(user, row)) return c.json({ error: "Not found" }, 404);
    if ("pic_id" in body) {
      const allowed = [user.id, user.manager_id].filter(Boolean);
      if (body.pic_id != null && !allowed.includes(body.pic_id)) {
        delete body.pic_id;
      }
    }
  }

  const ok = await patchProject(c.env, id, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "No changes" }, 400);
  return c.json({ ok: true });
});

// ── Chat / notes ──────────────────────────────────────────────
// Free-text messages from team members. Posted into the same
// project_activity table as system entries (stage_change, finance_edit,
// …) so the timeline interleaves human chat and system events in one
// view. Mirrors POST /api/assr/:id/notes.

app.post("/:id/notes", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{ note: string }>();
  if (!body.note?.trim()) return c.json({ error: "note is required" }, 400);
  await logProjectActivity(c.env, id, "note", null, null, body.note.trim(), user?.id);
  return c.json({ ok: true });
});

// ── Archive / restore (soft delete) ───────────────────────────

app.post("/:id/archive", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  await c.env.DB.prepare(
    `UPDATE projects
        SET archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now')
      WHERE id = ? AND archived_at IS NULL`
  )
    .bind(user?.id ?? null, id)
    .run();
  await logProjectActivity(c.env, id, "archived", null, null, null, user?.id);
  return c.json({ ok: true });
});

app.post("/:id/unarchive", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  await c.env.DB.prepare(
    `UPDATE projects
        SET archived_at = NULL, archived_by = NULL, updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(id)
    .run();
  await logProjectActivity(c.env, id, "restored", null, null, null, user?.id);
  return c.json({ ok: true });
});

// ── Finance ───────────────────────────────────────────────────

app.patch("/:id/finance", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  // Only the PIC (or an unscoped role) can write finance for a project.
  if (user?.scope_to_pic) {
    const row = await c.env.DB.prepare(
      `SELECT pic_id FROM projects WHERE id = ?`
    )
      .bind(id)
      .first<{ pic_id: number | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.pic_id !== user.id) {
      return c.json({ error: "Forbidden — finance is PIC-only" }, 403);
    }
  }
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchFinance(c.env, id, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "No changes" }, 400);
  return c.json({ ok: true });
});

// ── Finance ledger ───────────────────────────────────────────
// Line-item finance. Each write triggers a rollup into project_finance
// so list queries and dashboard tiles stay correct without a migration.

app.get("/finance/categories", (c) => {
  return c.json({
    cost: LEDGER_COST_CATEGORIES,
    income: LEDGER_INCOME_CATEGORIES,
  });
});

// Per-project finance summary — feeds the Finances → List tab. One row
// per project; SUMs income / cost / net out of project_finance_lines
// and joins back to projects for display fields (code, name, brand,
// stage, dates). Filters: date range constrains which lines are summed
// (a project shows up as long as it has any matching activity within
// the range, OR has its start/end inside the range); brand + search
// filter the project itself.
app.get("/finance/by-project", requirePermission("projects.read"), async (c) => {
  const user = c.get("user");
  // Finance tab is PIC-only. Scoped reps (who aren't themselves a PIC
  // on any project) get zero rows — finance is in the "limited view"
  // restricted panel list.
  const picScope = user?.scope_to_pic ? [user.id].filter(Boolean) : null;
  if (picScope && picScope.length === 0) {
    return c.json({ data: [], total: 0, totals: { total_income: 0, total_cost: 0 } });
  }
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const brand = c.req.query("brand") || "";
  const stage = c.req.query("stage") || "";
  const search = c.req.query("search") || "";
  const includeArchived = c.req.query("include_archived") === "1";
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(
    parseInt(c.req.query("per_page") || "50", 10),
    200
  );
  const offset = (page - 1) * perPage;

  // Date filter applied INSIDE the SUM aggregations so a project with
  // older lines still surfaces (it just shows zero for the window).
  const dateClauseParts: string[] = [];
  const dateBinds: any[] = [];
  if (dateFrom) {
    dateClauseParts.push("COALESCE(l.occurred_at, l.created_at) >= ?");
    dateBinds.push(dateFrom);
  }
  if (dateTo) {
    dateClauseParts.push("COALESCE(l.occurred_at, l.created_at) <= ?");
    dateBinds.push(`${dateTo}T23:59:59`);
  }
  const dateClause = dateClauseParts.length
    ? `AND ${dateClauseParts.join(" AND ")}`
    : "";

  // Project-level WHERE.
  const where: string[] = [];
  const projectBinds: any[] = [];
  if (!includeArchived) where.push("p.archived_at IS NULL");
  if (brand) {
    where.push("p.brand = ?");
    projectBinds.push(brand);
  }
  if (stage) {
    where.push("p.stage = ?");
    projectBinds.push(stage);
  }
  if (search) {
    where.push(
      "(p.code LIKE ? OR p.name LIKE ? OR p.venue LIKE ? OR p.organizer LIKE ?)"
    );
    const like = `%${search}%`;
    projectBinds.push(like, like, like, like);
  }
  if (picScope) {
    where.push(`p.pic_id IN (${picScope.map(() => "?").join(",")})`);
    projectBinds.push(...picScope);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sortBy = c.req.query("sort_by") || "net";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  // Sort runs on the OUTER wrapped subquery, so all columns are
  // unaliased (the `p.` prefix only exists inside `baseSelect`).
  const sortMap: Record<string, string> = {
    project: "code",
    brand: "brand",
    stage: "stage",
    start: "start_date",
    income: "income",
    cost: "cost",
    net: "net",
    margin_pct: "margin_pct",
    lines: "line_count",
  };
  const orderBy = `ORDER BY ${sortMap[sortBy] ?? sortMap.net} ${sortDir}, id DESC`;

  // The aggregate row per project. Date filter only applies inside
  // each SUM; the project row itself is selected by the project-level
  // WHERE (so projects with zero matching lines still show with 0s).
  const baseSelect = `
    SELECT p.id,
           p.code,
           p.name,
           p.brand,
           p.stage,
           p.start_date,
           p.end_date,
           p.venue,
           p.organizer,
           COALESCE(SUM(CASE WHEN l.kind = 'income' AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN l.kind = 'cost'   AND l.archived_at IS NULL ${dateClause} THEN l.amount ELSE 0 END), 0) AS cost,
           COUNT(CASE WHEN l.archived_at IS NULL ${dateClause} THEN l.id END) AS line_count
      FROM projects p
      LEFT JOIN project_finance_lines l ON l.project_id = p.id
      ${whereSql}
      GROUP BY p.id
  `;

  // Build derived columns net + margin_pct on top of the aggregate so
  // we can sort by them.
  const wrapped = `
    SELECT *,
           (income - cost) AS net,
           CASE WHEN income > 0
                THEN ((income - cost) * 100.0 / income)
                ELSE NULL
           END AS margin_pct
      FROM (${baseSelect}) sub
  `;

  // Each occurrence of `dateClause` adds the same dateBinds to the
  // bind sequence. Two occurrences in baseSelect (income / cost), then
  // a third inside the COUNT(CASE …). Plus projectBinds for whereSql.
  const aggregateBinds = [
    ...dateBinds,
    ...dateBinds,
    ...dateBinds,
    ...projectBinds,
  ];

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM (${wrapped}) outerSub`
  )
    .bind(...aggregateBinds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `${wrapped} ${orderBy} LIMIT ? OFFSET ?`
  )
    .bind(...aggregateBinds, perPage, offset)
    .all();

  // Filtered grand totals so the header cards recompute server-side.
  const totals = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(income), 0) AS total_income,
       COALESCE(SUM(cost),   0) AS total_cost
     FROM (${wrapped}) tot`
  )
    .bind(...aggregateBinds)
    .first<{ total_income: number; total_cost: number }>();

  return c.json({
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
    totals: {
      income: totals?.total_income ?? 0,
      cost: totals?.total_cost ?? 0,
      net: (totals?.total_income ?? 0) - (totals?.total_cost ?? 0),
    },
  });
});

// Cross-project finance lines list — kept as a secondary endpoint for
// callers that want the raw ledger (audit, exports). Same filter shape
// as /finance/by-project plus kind + category.
app.get("/finance/lines", requirePermission("projects.read"), async (c) => {
  const user = c.get("user");
  // PIC-only panel — scoped reps see no finance lines.
  const finPicScope = user?.scope_to_pic ? [user.id].filter(Boolean) : null;
  if (finPicScope && finPicScope.length === 0) {
    return c.json({ data: [], total: 0, page: 1, per_page: 50 });
  }
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const kind = (c.req.query("kind") || "all").toLowerCase();
  const brand = c.req.query("brand") || "";
  const category = c.req.query("category") || "";
  const projectId = parseInt(c.req.query("project_id") || "", 10);
  const search = c.req.query("search") || "";
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(
    parseInt(c.req.query("per_page") || "50", 10),
    200
  );
  const offset = (page - 1) * perPage;

  const where: string[] = ["l.archived_at IS NULL"];
  const binds: any[] = [];

  if (dateFrom) {
    where.push("COALESCE(l.occurred_at, l.created_at) >= ?");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("COALESCE(l.occurred_at, l.created_at) <= ?");
    binds.push(`${dateTo}T23:59:59`);
  }
  if (kind === "income" || kind === "cost") {
    where.push("l.kind = ?");
    binds.push(kind);
  }
  if (brand) {
    where.push("p.brand = ?");
    binds.push(brand);
  }
  if (category) {
    where.push("l.category = ?");
    binds.push(category);
  }
  if (!isNaN(projectId)) {
    where.push("l.project_id = ?");
    binds.push(projectId);
  }
  if (search) {
    where.push(
      "(l.description LIKE ? OR l.notes LIKE ? OR p.code LIKE ? OR p.name LIKE ?)"
    );
    const like = `%${search}%`;
    binds.push(like, like, like, like);
  }
  if (finPicScope) {
    where.push(`p.pic_id IN (${finPicScope.map(() => "?").join(",")})`);
    binds.push(...finPicScope);
  }

  const sortBy = c.req.query("sort_by") || "occurred_at";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortMap: Record<string, string> = {
    occurred_at: "COALESCE(l.occurred_at, l.created_at)",
    amount: "l.amount",
    project: "p.code",
    category: "l.category",
    kind: "l.kind",
  };
  const orderBy = `ORDER BY ${sortMap[sortBy] ?? sortMap.occurred_at} ${sortDir}, l.id DESC`;

  const baseFrom = `
    FROM project_finance_lines l
    JOIN projects p ON p.id = l.project_id
    WHERE ${where.join(" AND ")}
  `;

  const total = await c.env.DB.prepare(`SELECT COUNT(*) as count ${baseFrom}`)
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT l.id,
            l.project_id,
            l.kind,
            l.category,
            l.description,
            l.amount,
            l.occurred_at,
            l.notes,
            l.created_at,
            l.r2_key,
            l.file_name,
            p.code   AS project_code,
            p.name   AS project_name,
            p.brand  AS project_brand
     ${baseFrom}
     ${orderBy}
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, perPage, offset)
    .all();

  // Lightweight totals across the filtered set so the page can show
  // "income X, cost Y, net Z" without a second round trip.
  const totals = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN l.kind = 'income' THEN l.amount ELSE 0 END), 0) AS total_income,
       COALESCE(SUM(CASE WHEN l.kind = 'cost'   THEN l.amount ELSE 0 END), 0) AS total_cost
     ${baseFrom}`
  )
    .bind(...binds)
    .first<{ total_income: number; total_cost: number }>();

  return c.json({
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
    totals: {
      income: totals?.total_income ?? 0,
      cost: totals?.total_cost ?? 0,
      net: (totals?.total_income ?? 0) - (totals?.total_cost ?? 0),
    },
  });
});

app.post("/:id/finance/lines", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    kind?: string;
    category?: string;
    description?: string;
    amount?: number;
    occurred_at?: string;
    r2_key?: string;
    file_name?: string;
    mime_type?: string;
    notes?: string;
  }>();
  const kind = body.kind as "income" | "cost";
  if (!["income", "cost"].includes(kind)) {
    return c.json({ error: "kind must be 'income' or 'cost'" }, 400);
  }
  if (!body.category || !body.category.trim()) {
    return c.json({ error: "category required" }, 400);
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return c.json({ error: "amount must be a non-negative number" }, 400);
  }
  try {
    const result = await createLedgerLine(
      c.env,
      {
        project_id: id,
        kind,
        category: body.category,
        description: body.description ?? null,
        amount,
        occurred_at: body.occurred_at ?? null,
        r2_key: body.r2_key ?? null,
        file_name: body.file_name ?? null,
        mime_type: body.mime_type ?? null,
        notes: body.notes ?? null,
      },
      user?.id ?? 0
    );
    return c.json(result, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed" }, 400);
  }
});

app.patch("/finance/lines/:lineId", requirePermission("projects.write"), async (c) => {
  const lineId = parseInt(c.req.param("lineId"), 10);
  if (isNaN(lineId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchLedgerLine(c.env, lineId, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found or no changes" }, 400);
  return c.json({ ok: true });
});

app.delete("/finance/lines/:lineId", requirePermission("projects.write"), async (c) => {
  const lineId = parseInt(c.req.param("lineId"), 10);
  if (isNaN(lineId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const ok = await archiveLedgerLine(c.env, lineId, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Upload evidence (invoice, receipt, sales sheet) for a ledger line.
// Returns an r2_key the create/patch call then attaches to the line.
app.put("/:id/finance/upload", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp", "pdf", "xlsx"]);
  if (!allowed.has(ext)) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const mime =
    ext === "pdf"
      ? "application/pdf"
      : ext === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/ledger-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ key, mime_type: mime });
});

// Manual resync endpoint — rebuilds project_finance from the lines.
app.post("/:id/finance/resync", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await syncFinanceRollup(c.env, id);
  return c.json({ ok: true });
});

// ── Payment workflow ─────────────────────────────────────────

app.post("/:id/payment", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    status?: string;
    notes?: string;
    proof_r2_key?: string;
    proof_file_name?: string;
  }>();
  if (!body.status) return c.json({ error: "status required" }, 400);
  try {
    await setPaymentStatus(
      c.env,
      id,
      body.status,
      {
        notes: body.notes ?? undefined,
        proof_r2_key: body.proof_r2_key ?? undefined,
        proof_file_name: body.proof_file_name ?? undefined,
      },
      user?.id ?? 0
    );
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed" }, 400);
  }
});

// Rental-proof upload. Returns an r2_key that the /payment call
// then attaches to the project row.
app.put("/:id/payment/proof", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);
  if (!allowed.has(ext)) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const mime = ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/payment-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ key, mime_type: mime });
});

// ── Stock transfers ──────────────────────────────────────────

app.post("/:id/stock-transfers", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    direction?: string;
    transferred_at?: string;
    record_r2_key?: string;
    file_name?: string;
    mime_type?: string;
    notes?: string;
  }>();
  const dir = body.direction as "out" | "return";
  if (!["out", "return"].includes(dir)) {
    return c.json({ error: "direction must be 'out' or 'return'" }, 400);
  }
  const result = await createStockTransfer(
    c.env,
    {
      project_id: id,
      direction: dir,
      transferred_at: body.transferred_at ?? null,
      record_r2_key: body.record_r2_key ?? null,
      file_name: body.file_name ?? null,
      mime_type: body.mime_type ?? null,
      notes: body.notes ?? null,
    },
    user?.id ?? 0
  );
  return c.json(result, 201);
});

app.put("/:id/stock-transfers/upload", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp", "pdf", "xlsx"]);
  if (!allowed.has(ext)) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const mime =
    ext === "pdf"
      ? "application/pdf"
      : ext === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/stock-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ key, mime_type: mime });
});

app.post("/stock-transfers/:tid/confirm", requirePermission("projects.write"), async (c) => {
  const tid = parseInt(c.req.param("tid"), 10);
  if (isNaN(tid)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const ok = await confirmStockTransfer(c.env, tid, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.post("/stock-transfers/:tid/unconfirm", requirePermission("projects.write"), async (c) => {
  const tid = parseInt(c.req.param("tid"), 10);
  if (isNaN(tid)) return c.json({ error: "Invalid ID" }, 400);
  await unconfirmStockTransfer(c.env, tid);
  return c.json({ ok: true });
});

app.delete("/stock-transfers/:tid", requirePermission("projects.write"), async (c) => {
  const tid = parseInt(c.req.param("tid"), 10);
  if (isNaN(tid)) return c.json({ error: "Invalid ID" }, 400);
  await archiveStockTransfer(c.env, tid);
  return c.json({ ok: true });
});

// ── Checklist ─────────────────────────────────────────────────

app.post("/:id/checklist", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    title?: string;
    description?: string;
    required_perm?: string;
    due_date?: string;
    owner_user_id?: number;
    seq?: number;
  }>();
  if (!body.title || !body.title.trim()) {
    return c.json({ error: "title is required" }, 400);
  }
  const result = await createChecklistItem(
    c.env,
    {
      project_id: id,
      title: body.title.trim(),
      description: body.description ?? null,
      required_perm: body.required_perm ?? null,
      due_date: body.due_date ?? null,
      owner_user_id: body.owner_user_id ?? null,
      seq: body.seq ?? null,
    },
    user?.id ?? 0
  );
  return c.json(result, 201);
});

app.patch("/checklist/:itemId", requirePermission("projects.write"), async (c) => {
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchChecklistItem(c.env, itemId, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "No changes" }, 400);
  return c.json({ ok: true });
});

// Status transitions (pending/done/na/blocked). Enforces required_perm
// — if the item specifies one (e.g. 'projects.approve' for the
// 3D-final-approval step), only users with that permission can tick
// it.
app.post("/checklist/:itemId/status", requirePermission("projects.write"), async (c) => {
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{ status?: string }>();
  const status = body.status as "pending" | "done" | "na" | "blocked";
  if (!["pending", "done", "na", "blocked"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const item = await c.env.DB.prepare(
    `SELECT required_perm FROM project_checklist WHERE id = ?`
  )
    .bind(itemId)
    .first<{ required_perm: string | null }>();
  if (!item) return c.json({ error: "Not found" }, 404);
  if (item.required_perm) {
    const has =
      user.permissions.includes("*") || user.permissions.includes(item.required_perm);
    if (!has) {
      return c.json({ error: `Requires ${item.required_perm}` }, 403);
    }
  }
  const ok = await setChecklistStatus(c.env, itemId, status, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Checklist review loop ────────────────────────────────────

app.post("/checklist/:itemId/review", requirePermission("projects.write"), async (c) => {
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{ action?: string; reason?: string; note?: string }>();
  const action = body.action as "submit" | "reject" | "amend" | "approve" | "comment";
  const item = await c.env.DB.prepare(
    `SELECT required_perm FROM project_checklist WHERE id = ?`
  )
    .bind(itemId)
    .first<{ required_perm: string | null }>();
  if (!item) return c.json({ error: "Not found" }, 404);

  // Approval / rejection gates on required_perm (same rule as
  // direct status transitions). Submissions and comments are open to
  // any user with projects.write.
  if ((action === "approve" || action === "reject") && item.required_perm) {
    const has =
      user.permissions.includes("*") || user.permissions.includes(item.required_perm);
    if (!has) return c.json({ error: `Requires ${item.required_perm}` }, 403);
  }

  try {
    switch (action) {
      case "submit":
        await submitChecklistForReview(c.env, itemId, user?.id ?? 0);
        break;
      case "reject":
        if (!body.reason || !body.reason.trim()) {
          return c.json({ error: "reason required" }, 400);
        }
        await rejectChecklistItem(c.env, itemId, body.reason.trim(), user?.id ?? 0);
        break;
      case "amend":
        await amendChecklistItem(c.env, itemId, body.note ?? null, user?.id ?? 0);
        break;
      case "approve":
        await approveChecklistItem(c.env, itemId, user?.id ?? 0);
        break;
      case "comment":
        await addChecklistComment(c.env, itemId, "note", body.note ?? null, user?.id ?? 0);
        break;
      default:
        return c.json({ error: "invalid action" }, 400);
    }
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed" }, 500);
  }
  return c.json({ ok: true });
});

// ── Defects ──────────────────────────────────────────────────

app.post("/:id/defects", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    phase?: string;
    reported_by_role?: string;
    item_code?: string;
    item_description?: string;
    size?: string;
    quantity?: number;
    reason?: string;
    photo_r2_key?: string;
  }>();
  const phase = body.phase as "setup" | "dismantle";
  const role = body.reported_by_role as "sales" | "logistic";
  if (!["setup", "dismantle"].includes(phase)) return c.json({ error: "phase required" }, 400);
  if (!["sales", "logistic"].includes(role)) return c.json({ error: "reported_by_role required" }, 400);
  const result = await createDefect(
    c.env,
    {
      project_id: id,
      phase,
      reported_by_role: role,
      item_code: body.item_code ?? null,
      item_description: body.item_description ?? null,
      size: body.size ?? null,
      quantity: body.quantity ?? 1,
      reason: body.reason ?? null,
      photo_r2_key: body.photo_r2_key ?? null,
    },
    user?.id ?? 0
  );
  return c.json(result, 201);
});

app.patch("/defects/:defectId", requirePermission("projects.write"), async (c) => {
  const defectId = parseInt(c.req.param("defectId"), 10);
  if (isNaN(defectId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchDefect(c.env, defectId, body, user?.id ?? 0);
  if (!ok) return c.json({ error: "No changes" }, 400);
  return c.json({ ok: true });
});

app.delete("/defects/:defectId", requirePermission("projects.write"), async (c) => {
  const defectId = parseInt(c.req.param("defectId"), 10);
  if (isNaN(defectId)) return c.json({ error: "Invalid ID" }, 400);
  await archiveDefect(c.env, defectId);
  return c.json({ ok: true });
});

// Upload a photo for a defect — small wrapper around the same R2 pattern
// attachments use. Photo lands under projects/{id}/defect-*.ext and the
// returned key goes onto the defect row via PATCH.
app.put("/:id/defects/photo", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp"]);
  if (!allowed.has(ext)) return c.json({ error: "ext must be image" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const contentType = `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/defect-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  return c.json({ key });
});

// ── Sales reports ────────────────────────────────────────────

app.post("/:id/sales-reports", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{
    title?: string;
    sales_amount?: number;
    period_start?: string;
    period_end?: string;
    r2_key?: string;
    file_name?: string;
    mime_type?: string;
    sync_to_finance?: boolean;
  }>();
  const result = await createSalesReport(
    c.env,
    {
      project_id: id,
      title: body.title ?? null,
      sales_amount: typeof body.sales_amount === "number" ? body.sales_amount : null,
      period_start: body.period_start ?? null,
      period_end: body.period_end ?? null,
      r2_key: body.r2_key ?? null,
      file_name: body.file_name ?? null,
      mime_type: body.mime_type ?? null,
    },
    user?.id ?? 0,
    { syncToFinance: body.sync_to_finance !== false }
  );
  return c.json(result, 201);
});

app.delete("/sales-reports/:reportId", requirePermission("projects.write"), async (c) => {
  const reportId = parseInt(c.req.param("reportId"), 10);
  if (isNaN(reportId)) return c.json({ error: "Invalid ID" }, 400);
  await archiveSalesReport(c.env, reportId, true);
  return c.json({ ok: true });
});

// Upload the sales-report attachment (image / PDF). Returns the key
// + suggested mime_type that the create call will store.
app.put("/:id/sales-reports/upload", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const allowed = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);
  if (!allowed.has(ext)) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);
  const contentType =
    ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = `projects/${id}/sales-report-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  return c.json({ key, mime_type: contentType });
});

// Manual finance resync — callable if the UI ever drifts from the
// computed sum (shouldn't happen normally).
app.post("/:id/sales-reports/resync", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  await syncSalesTotalFromReports(c.env, id);
  return c.json({ ok: true });
});

app.delete("/checklist/:itemId", requirePermission("projects.write"), async (c) => {
  const itemId = parseInt(c.req.param("itemId"), 10);
  if (isNaN(itemId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const ok = await deleteChecklistItem(c.env, itemId, user?.id ?? 0);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Team ─────────────────────────────────────────────────────

app.post("/:id/team", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{ user_id?: number; role?: string }>();
  if (!body.user_id) return c.json({ error: "user_id required" }, 400);
  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO project_team (project_id, user_id, role) VALUES (?, ?, ?)`
    )
      .bind(id, body.user_id, body.role || null)
      .run();
    return c.json({ id: r.meta.last_row_id }, 201);
  } catch (e: any) {
    // Unique-constraint violation — user already has that role
    return c.json({ error: e?.message || "Duplicate" }, 409);
  }
});

app.delete("/team/:teamId", requirePermission("projects.write"), async (c) => {
  const teamId = parseInt(c.req.param("teamId"), 10);
  if (isNaN(teamId)) return c.json({ error: "Invalid ID" }, 400);
  await c.env.DB.prepare(`DELETE FROM project_team WHERE id = ?`).bind(teamId).run();
  return c.json({ ok: true });
});

// ── Trip linkage ─────────────────────────────────────────────
// The trip create flow expects SO stops (doc_no-based), which don't
// apply to booth setup/teardown. So for projects we just link existing
// trips via trips.project_id — the trip itself is still created
// through the normal trips module.

app.post("/:id/trips/link", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const body = await c.req.json<{ trip_id?: number }>();
  if (!body.trip_id) return c.json({ error: "trip_id required" }, 400);
  const r = await c.env.DB.prepare(
    `UPDATE trips SET project_id = ? WHERE id = ?`
  )
    .bind(id, body.trip_id)
    .run();
  if (!r.meta.changes) return c.json({ error: "Trip not found" }, 404);
  await logProjectActivity(c.env, id, "trip_link", null, String(body.trip_id), null, user?.id);
  return c.json({ ok: true });
});

app.post("/trips/:tripId/unlink", requirePermission("projects.write"), async (c) => {
  const tripId = parseInt(c.req.param("tripId"), 10);
  if (isNaN(tripId)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const before = await c.env.DB.prepare(
    `SELECT project_id FROM trips WHERE id = ?`
  )
    .bind(tripId)
    .first<{ project_id: number | null }>();
  await c.env.DB.prepare(
    `UPDATE trips SET project_id = NULL WHERE id = ?`
  )
    .bind(tripId)
    .run();
  if (before?.project_id) {
    await logProjectActivity(c.env, before.project_id, "trip_unlink", String(tripId), null, null, user?.id);
  }
  return c.json({ ok: true });
});

// Unlinked trips (candidates to link) — used by the project detail panel
// picker. Returns recent trips with no project_id assigned.
app.get("/trips/unlinked", requirePermission("projects.write"), async (c) => {
  const search = c.req.query("search") || "";
  const where: string[] = ["t.project_id IS NULL"];
  const binds: any[] = [];
  if (search) {
    where.push("(t.trip_no LIKE ? OR t.notes LIKE ?)");
    binds.push(`%${search}%`, `%${search}%`);
  }
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.trip_no, t.status, t.trip_date, t.trip_type, t.warehouse, t.notes
       FROM trips t
      WHERE ${where.join(" AND ")}
      ORDER BY t.trip_date DESC, t.id DESC
      LIMIT 50`
  )
    .bind(...binds)
    .all();
  return c.json({ data: rows.results ?? [] });
});

// ── Attachments ──────────────────────────────────────────────
// R2-backed uploads. Same contract as ASSR attachments: PUT raw binary
// with ?category=&ext=&name= query params. Returns the attachment row.

const PROJECT_ATTACH_ALLOWED = new Set([
  "jpg", "jpeg", "png", "webp", "mp4", "pdf",
  "dwg", "skp", // floorplans / 3D source files from designers
]);
const PROJECT_ATTACH_MAX = 25 * 1024 * 1024; // 25 MB

function projectAttachmentKey(projectId: number, category: string, ext: string): string {
  return `projects/${projectId}/${category}-${Date.now()}.${ext}`;
}

const PROJECT_ATTACH_ROLES = new Set(["sales", "driver", "design", "office"]);

app.put("/:id/attachments", requirePermission("projects.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = c.get("user");
  const category = (c.req.query("category") || "other").toLowerCase();
  const ext = (c.req.query("ext") || "").toLowerCase();
  const fileName = c.req.query("name") || null;
  const roleParam = (c.req.query("role") || "").toLowerCase();
  const role = PROJECT_ATTACH_ROLES.has(roleParam) ? roleParam : null;
  if (!PROJECT_ATTACH_ALLOWED.has(ext)) {
    return c.json({ error: `Extension '${ext}' not allowed` }, 400);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength > PROJECT_ATTACH_MAX) {
    return c.json({ error: "File too large (max 25MB)" }, 400);
  }
  const contentType =
    ext === "mp4" ? "video/mp4" :
    ext === "pdf" ? "application/pdf" :
    ext === "dwg" ? "application/acad" :
    ext === "skp" ? "application/vnd.sketchup.skp" :
    `image/${ext === "jpg" ? "jpeg" : ext}`;
  const key = projectAttachmentKey(id, category, ext);
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  const r = await c.env.DB.prepare(
    `INSERT INTO project_attachments
       (project_id, category, r2_key, file_name, mime_type, size_bytes,
        uploaded_by, uploaded_by_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, category, key, fileName, contentType, body.byteLength, user?.id ?? null, role)
    .run();
  await logProjectActivity(
    c.env,
    id,
    "attachment_add",
    role,
    fileName || category,
    null,
    user?.id
  );
  return c.json({ id: r.meta.last_row_id, key }, 201);
});

// Stream the asset. Auth middleware already gated the request. {.+}
// captures the slash-containing key.
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

app.post("/attachments/:attId/archive", requirePermission("projects.write"), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  await c.env.DB.prepare(
    `UPDATE project_attachments SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(attId)
    .run();
  return c.json({ ok: true });
});

// Rename — only the human label (file_name). The R2 key stays put so
// existing thumbnails / cached URLs don't break. uploaded_by_role is
// also patchable here so a mistagged upload can be re-categorised.
app.patch("/attachments/:attId", requirePermission("projects.write"), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    file_name?: string | null;
    category?: string | null;
    uploaded_by_role?: string | null;
  }>();
  const sets: string[] = [];
  const binds: any[] = [];
  if ("file_name" in body) {
    const v = (body.file_name || "").toString().trim();
    if (!v) return c.json({ error: "file_name cannot be empty" }, 400);
    sets.push("file_name = ?");
    binds.push(v);
  }
  if ("category" in body) {
    sets.push("category = ?");
    binds.push((body.category || "").toString().trim() || null);
  }
  if ("uploaded_by_role" in body) {
    const r = (body.uploaded_by_role || "").toString().toLowerCase();
    sets.push("uploaded_by_role = ?");
    binds.push(["sales", "driver", "design", "office"].includes(r) ? r : null);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  binds.push(attId);
  const r = await c.env.DB.prepare(
    `UPDATE project_attachments SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Calendar feed ────────────────────────────────────────────
// Returns projects overlapping [from, to], plus their open checklist
// items whose due_date falls in the window. Used by the Calendar page.

app.get("/calendar/events", requirePermission("projects.read"), async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) return c.json({ error: "from & to required (YYYY-MM-DD)" }, 400);

  const user = c.get("user");
  const picScope = getProjectPicScope(user);
  // Scoped user with no PIC line → return empty quickly.
  if (picScope && picScope.length === 0) {
    return c.json({ projects: [], tasks: [] });
  }
  const picWhere = picScope
    ? ` AND p.pic_id IN (${picScope.map(() => "?").join(",")})`
    : "";
  const picBinds = picScope ?? [];

  // Projects whose [start_date, end_date] overlaps [from, to].
  const projects = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.stage, p.brand,
            p.start_date, p.end_date, p.venue, p.state
       FROM projects p
      WHERE p.archived_at IS NULL
        AND p.start_date IS NOT NULL
        AND date(p.start_date) <= date(?)
        AND date(COALESCE(p.end_date, p.start_date)) >= date(?)${picWhere}`
  )
    .bind(to, from, ...picBinds)
    .all();

  const tasks = await c.env.DB.prepare(
    `SELECT c.id, c.project_id, c.title, c.due_date, c.status,
            c.required_perm, c.review_status,
            p.code as project_code, p.brand, p.name as project_name,
            u.name as owner_name,
            CASE WHEN date(c.due_date) < date('now') THEN 1 ELSE 0 END as is_overdue
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE p.archived_at IS NULL
        AND c.status != 'done'
        AND c.status != 'na'
        AND c.due_date IS NOT NULL
        AND date(c.due_date) BETWEEN date(?) AND date(?)${picWhere}
      ORDER BY c.due_date, p.brand, c.id`
  )
    .bind(from, to, ...picBinds)
    .all();

  return c.json({ projects: projects.results ?? [], tasks: tasks.results ?? [] });
});

// ── CSV import ───────────────────────────────────────────────
// Admin tool to backfill projects from the existing Google Sheet.
// Accepts a CSV body (text/csv) with a header row. Recognised columns
// (case-insensitive, spaces become underscores):
//   name, brand, event_type, start_date, end_date,
//   venue, state, organizer, booth_no, size_sqm, notion_url,
//   rental, total_sales, contractor_cost, license_fee
// Unknown columns are ignored. Missing name → row skipped.

app.post("/import/csv", requirePermission("projects.manage"), async (c) => {
  const user = c.get("user");
  const text = await c.req.text();
  const parsed = parseCsv(text);
  if (!parsed.rows.length) return c.json({ imported: 0, errors: ["Empty CSV"] });

  const etRows = await c.env.DB.prepare(
    `SELECT id, slug, name FROM project_event_types`
  ).all<{ id: number; slug: string; name: string }>();
  const etBySlug = new Map<string, number>();
  for (const r of etRows.results ?? []) {
    etBySlug.set(r.slug.toLowerCase(), r.id);
    etBySlug.set(r.name.toLowerCase(), r.id);
  }

  const ALLOWED_BRANDS = new Set([
    "AKEMI", "ZANOTTI", "DUNLOPILLO", "ERGOTEX", "MY SOFA FACTORY", "AKEMI C&C",
  ]);

  const { createProject } = await import("../services/projects");

  let imported = 0;
  const errors: string[] = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const name = (row.name || "").trim();
    if (!name) {
      errors.push(`Row ${i + 2}: name is empty, skipped`);
      continue;
    }
    const brand = (row.brand || "").trim().toUpperCase();
    const eventType = (row.event_type || "").trim().toLowerCase();
    const startDate = normalizeDate(row.start_date);
    const endDate = normalizeDate(row.end_date);
    try {
      const result = await createProject(c.env, {
        name,
        brand: ALLOWED_BRANDS.has(brand) ? brand : null,
        event_type_id: etBySlug.get(eventType) ?? null,
        start_date: startDate,
        end_date: endDate,
        venue: row.venue || null,
        state: row.state || null,
        organizer: row.organizer || null,
        notion_url: row.notion_url || null,
        created_by: user?.id ?? 0,
      });
      const numeric = (s: string | undefined): number | null => {
        if (!s) return null;
        const n = parseFloat(s.replace(/[,\s]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      const financeFields: Record<string, any> = {};
      if (row.rental) financeFields.rental = numeric(row.rental);
      if (row.total_sales) financeFields.total_sales = numeric(row.total_sales);
      if (row.contractor_cost) financeFields.contractor_cost = numeric(row.contractor_cost);
      if (row.license_fee) financeFields.license_fee = numeric(row.license_fee);
      if (Object.keys(financeFields).length) {
        const sets = Object.keys(financeFields).map((k) => `${k} = ?`).join(", ");
        const vals = Object.values(financeFields);
        await c.env.DB.prepare(
          `UPDATE project_finance SET ${sets}, updated_at = datetime('now') WHERE project_id = ?`
        )
          .bind(...vals, result.id)
          .run();
      }
      const boothPatch: Record<string, any> = {};
      if (row.booth_no) boothPatch.booth_no = row.booth_no;
      if (row.size_sqm) {
        const n = parseFloat(row.size_sqm.replace(/[,\s]/g, ""));
        if (Number.isFinite(n)) boothPatch.size_sqm = n;
      }
      if (Object.keys(boothPatch).length) {
        const sets = Object.keys(boothPatch).map((k) => `${k} = ?`).join(", ");
        const vals = Object.values(boothPatch);
        await c.env.DB.prepare(
          `UPDATE projects SET ${sets}, updated_at = datetime('now') WHERE id = ?`
        )
          .bind(...vals, result.id)
          .run();
      }
      imported++;
    } catch (e: any) {
      errors.push(`Row ${i + 2}: ${e?.message || String(e)}`);
    }
  }
  return c.json({ imported, errors, total_rows: parsed.rows.length });
});

// Minimal CSV parser — handles quoted fields with embedded commas and
// escaped quotes. Good enough for the Google Sheet export.
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, "\n");
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === "," || ch === "\t") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      cur.push(field);
      lines.push(cur);
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length || cur.length) {
    cur.push(field);
    lines.push(cur);
  }
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < lines.length; r++) {
    const row = lines[r];
    if (row.length === 1 && row[0].trim() === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (row[c] ?? "").trim();
    }
    rows.push(obj);
  }
  return { headers, rows };
}

// Accept YYYY-MM-DD, DD/MM/YYYY, D/M/YYYY. Returns YYYY-MM-DD or null.
function normalizeDate(s: string | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export default app;
