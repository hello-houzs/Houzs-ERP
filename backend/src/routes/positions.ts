import { Hono } from "hono";
import type { Env } from "../types";
import {
  PAGES,
  isValidPageKey,
  isValidPositionLevel,
  loadPageAccessForPosition,
  type AccessLevel,
} from "../services/pageAccess";
import { requirePermission, requirePermissionOrSalesDirector } from "../middleware/auth";
import { isSalesDirectorUser } from "../services/pmsAccess";
import { hasPermission } from "../services/permissions";
import { setSetting } from "../services/email";
import { audit } from "../services/audit";
import { getDb } from "../db/client";
import { positions, position_page_access, users, departments } from "../db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

// Positions = the staff org unit (department × position). Mirrors roles.ts but
// keyed on POSITION and using the 4-level page-access matrix (none/view/edit/
// full). Gated under users.read / users.manage — positions are a
// user-management concern, so no new permission verb is introduced.

const app = new Hono<{ Bindings: Env }>();

const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** GET /api/positions  (?department_id= to scope the invite-form dropdown) */
app.get("/", requirePermissionOrSalesDirector("users.read"), async (c) => {
  const db = getDb(c.env);
  const deptParam = c.req.query("department_id");
  const deptId = deptParam ? parseInt(deptParam, 10) : null;

  // Sales Director (dept-scoped admin, NOT a full users.read admin) → own-dept
  // positions only, mirroring GET /api/departments ("删掉别部门内容"). This also
  // scopes the member-form Position picker to the positions a Sales Director may
  // actually assign (invite/patch already reject cross-dept positions). A full
  // admin (users.read / `*`) is unaffected; no department assigned → -1 (empty).
  const user = c.get("user");
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  const isFullAdmin =
    hasPermission(granted, "*") || hasPermission(granted, "users.read");
  const scopeDeptId =
    !isFullAdmin && isSalesDirectorUser(user) ? user?.department_id ?? -1 : null;
  const effectiveDeptId = scopeDeptId !== null ? scopeDeptId : deptId;

  const rows = await db
    .select({
      id: positions.id,
      department_id: positions.department_id,
      slug: positions.slug,
      name: positions.name,
      level: positions.level,
      sort_order: positions.sort_order,
      active: positions.active,
      department_name: departments.name,
      member_count: sql<number>`(SELECT COUNT(*) FROM ${users} WHERE ${users.position_id} = ${positions.id})`,
    })
    .from(positions)
    .leftJoin(departments, eq(departments.id, positions.department_id))
    .where(
      effectiveDeptId != null
        ? eq(positions.department_id, effectiveDeptId)
        : undefined,
    )
    .orderBy(asc(positions.sort_order), asc(positions.name));

  return c.json({
    positions: rows.map((r) => ({
      id: r.id,
      department_id: r.department_id,
      department_name: r.department_name,
      slug: r.slug,
      name: r.name,
      level: r.level,
      sort_order: r.sort_order,
      active: !!r.active,
      member_count: r.member_count ?? 0,
    })),
  });
});

/**
 * Read the admin-defined display order for the matrix (a flat list of page
 * keys). Stored in app_settings under POSITION_PAGE_ORDER_KEY. Returns [] when
 * unset or unreadable — callers then fall back to the catalogue's own order.
 */
const POSITION_PAGE_ORDER_KEY = "position_page_order";
async function getPageOrder(env: Env): Promise<string[]> {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = ?",
    )
      .bind(POSITION_PAGE_ORDER_KEY)
      .first<{ value: string }>();
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Sort the catalogue by a stored key order (stable). Keys absent from the
 * order keep their catalogue position (they sort after ordered ones, in
 * original sequence). Display-only — the cascade in loadPageAccessForPosition
 * still reads PAGES in code order, so parent-before-child is never disturbed.
 */
function orderPages<T extends { key: string }>(list: T[], order: string[]): T[] {
  if (order.length === 0) return list;
  const rank = new Map(order.map((k, i) => [k, i]));
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ra = rank.has(a.p.key) ? rank.get(a.p.key)! : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.p.key) ? rank.get(b.p.key)! : Number.MAX_SAFE_INTEGER;
      return ra - rb || a.i - b.i;
    })
    .map((x) => x.p);
}

/**
 * GET /api/positions/pages
 * Page catalogue for the matrix editor (same payload as /api/roles/pages),
 * sorted by the admin's saved matrix order when one exists.
 */
app.get("/pages", requirePermission("users.read"), async (c) => {
  const order = await getPageOrder(c.env);
  return c.json({
    pages: orderPages([...PAGES], order).map((p) => ({
      key: p.key,
      label: p.label,
      partialMeaning: p.partialMeaning,
      supportsPartial: p.supportsPartial,
      parent: p.parent ?? null,
    })),
  });
});

/**
 * PATCH /api/positions/page-order
 * Save the matrix display order (drag-reorder). Body: { order: string[] } —
 * a flat list of valid page keys. Global (affects every position's matrix);
 * gated on users.manage like the rest of the position admin surface.
 * Registered before "/:id" so the literal path wins over the id param.
 */
app.patch("/page-order", requirePermission("users.manage"), async (c) => {
  const body = await c.req.json<{ order?: unknown }>().catch(() => ({}) as any);
  if (!Array.isArray(body.order)) {
    return c.json({ error: "order[] is required" }, 400);
  }
  const order = body.order.filter(
    (k: unknown): k is string => typeof k === "string" && isValidPageKey(k),
  );
  const userId = (c.get("user") as { id?: number } | undefined)?.id ?? null;
  await setSetting(c.env, POSITION_PAGE_ORDER_KEY, order, userId);
  await audit(c, {
    action: "positions.page_order.update",
    summary: `Reordered the position matrix (${order.length} pages)`,
    meta: { count: order.length },
  });
  return c.json({ ok: true, count: order.length });
});

/**
 * GET /api/positions/page-access/export
 *
 * Every position's matrix in ONE response — the input to
 * `scripts/export-position-access.mjs`, which turns it into
 * `services/positionAccessSnapshot.ts`.
 *
 * WHY THIS EXISTS AT ALL. The rules are moving out of this table and into
 * backend code (services/salesJdAccess.ts is the first one). Before anything is
 * switched off, the owner has to be able to READ what the table currently says
 * — all 17 positions at once, not one click at a time — because nobody can
 * currently state what a position sees. The code cannot answer it either: nav
 * visibility ORs `anyPerm`/`anyAccess` (frontend navFilter.ts:76-91) and with
 * `scm_l2_configured` the `scm.access` term is dropped, so for a non-`*` user
 * the matrix cell alone decides. Read from the ROWS or be wrong. This was
 * proven the expensive way on 2026-07-17: Sales Director's access was reported
 * from Sidebar.tsx's flags and the owner corrected it from memory.
 *
 * WHY `entries` IS THE EXPLICIT ROWS AND NOT THE RESOLVED MAP. An absent row
 * and a `level = 'none'` row are DIFFERENT FACTS for any child page, and
 * flattening them is how this export would silently destroy his settings:
 * loadPageAccessForPosition (pageAccess.ts:748) resolves a child as
 * `explicit[key] ?? out[parent]` — absent means INHERIT THE PARENT, `'none'`
 * means DENIED even when the parent is full. Writing a resolved map back as
 * explicit rows would nail every child to today's parent value and quietly
 * sever the inheritance. So `entries` is a photograph: exactly the rows that
 * exist, verbatim, and nothing invented for the ones that don't.
 * (`reference_houzs_nullish_hides_ignorance` — `?? "none"` turning "unknown"
 * into a confident lie is this codebase's most repeated bug.)
 *
 * `resolved` is the DERIVED companion — what each position actually gets at
 * login, inheritance applied, via the real loader. It is what the owner reads
 * to check "我現在看到的東西" is intact. It is NOT the snapshot's source of
 * truth and must never be written back as rows.
 *
 * Registered before "/:id" so the literal path wins over the id param.
 */
app.get("/page-access/export", requirePermission("users.manage"), async (c) => {
  const db = getDb(c.env);

  // Which DB answered. Staging and prod are DIFFERENT Supabase projects with
  // different rows — a snapshot generated off staging and shipped as prod's
  // would rewrite real people's access with test data. The generator refuses on
  // this string rather than trusting whoever ran it to remember.
  const generatedFrom = `${c.env.PUBLIC_APP_URL ?? "unknown-app-url"} (${new URL(c.req.url).host})`;

  const posRows = await db
    .select({
      id: positions.id,
      name: positions.name,
      slug: positions.slug,
      active: positions.active,
      department_id: positions.department_id,
      department_name: departments.name,
    })
    .from(positions)
    .leftJoin(departments, eq(positions.department_id, departments.id))
    .orderBy(asc(positions.id));

  // One read of the whole table — no per-position round-trip. Ungated by
  // page_key on purpose: rows whose key is no longer in the registry are still
  // rows, and a photograph that drops them is not a photograph.
  const allRows = await db
    .select({
      position_id: position_page_access.position_id,
      page_key: position_page_access.page_key,
      level: position_page_access.level,
    })
    .from(position_page_access);

  const byPosition = new Map<number, Array<{ page_key: string; level: string }>>();
  for (const r of allRows) {
    const list = byPosition.get(r.position_id) ?? [];
    list.push({ page_key: r.page_key, level: r.level });
    byPosition.set(r.position_id, list);
  }

  const registryKeys = new Set(PAGES.map((p) => p.key));
  let explicitRows = 0;
  let orphanRows = 0;
  let gapCells = 0;

  const out: Array<{
    id: number;
    name: string;
    slug: string;
    active: number;
    department_id: number | null;
    department_name: string | null;
    entries: Record<string, string>;
    orphan_keys: string[];
    missing_keys: string[];
    resolved: Record<string, AccessLevel>;
  }> = [];
  for (const p of posRows) {
    const rows = byPosition.get(p.id) ?? [];

    // Sorted by key so a regenerated file diffs cleanly — row order out of PG
    // is not stable, and an unsorted export would churn every regeneration and
    // bury a real change in the noise.
    const entries: Record<string, string> = {};
    for (const r of [...rows].sort((a, b) => a.page_key.localeCompare(b.page_key))) {
      entries[r.page_key] = r.level;
    }

    // Rows whose page_key the registry no longer knows. loadPageAccessForPosition
    // ignores them (isValidPageKey, pageAccess.ts:727) so they grant nothing
    // today — but they are still in the table and would come back to life if the
    // key were ever re-added. Named, not dropped.
    const orphan_keys = Object.keys(entries).filter((k) => !registryKeys.has(k));

    // Registry pages this position has NO row for. This is where "he never set
    // it" hides: a gap is not a decision, and it must not be exported as one.
    const missing_keys = PAGES.map((x) => x.key).filter((k) => !(k in entries));

    explicitRows += Object.keys(entries).length;
    orphanRows += orphan_keys.length;
    gapCells += missing_keys.length;

    out.push({
      id: p.id,
      name: p.name,
      slug: p.slug,
      active: p.active,
      department_id: p.department_id,
      department_name: p.department_name ?? null,
      entries,
      orphan_keys,
      missing_keys,
      // Derived — inheritance applied, through the SAME loader login uses, so
      // the review table cannot disagree with the live system. Re-reading the
      // rows once per position (rather than resolving from `allRows` in memory)
      // is a deliberate N+1: ~17 positions, admin-only, run by hand a few times
      // in this migration's life. A second local implementation of the inherit
      // cascade is the thing worth avoiding here — a review table that quietly
      // disagrees with login is worse than 17 cheap indexed reads.
      resolved: await loadPageAccessForPosition(c.env, p.id),
    });
  }

  return c.json({
    generatedFrom,
    generatedAt: new Date().toISOString(),
    // The table has NO company_id and NO updated_by (schema.pg.ts:266-276):
    // position_id, page_key, level, created_at, updated_at, PK(position_id,
    // page_key). Positions are global across both companies, so there is no
    // per-company cell for this export to flatten. Timestamps are deliberately
    // NOT exported: they are not access facts, and they would churn the diff on
    // every regeneration.
    schemaNote: "position_page_access has no company_id and no updated_by; positions are global",
    registryPageCount: PAGES.length,
    totals: {
      positions: out.length,
      explicit_rows: explicitRows,
      orphan_rows: orphanRows,
      gap_cells: gapCells,
    },
    positions: out,
  });
});

/** POST /api/positions  Body: { department_id, name, slug?, level?, sort_order? } */
app.post("/", requirePermission("users.manage"), async (c) => {
  const body = await c.req.json<{
    department_id?: number;
    name: string;
    slug?: string;
    level?: number;
    sort_order?: number;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  const name = body.name.trim();
  const slug = (body.slug?.trim() || slugify(name)) || null;
  if (!slug) return c.json({ error: "could not derive a slug from name" }, 400);

  const db = getDb(c.env);
  const exists = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.slug, slug))
    .limit(1);
  if (exists.length > 0) {
    return c.json({ error: "A position with that slug already exists" }, 409);
  }

  const inserted = await db
    .insert(positions)
    .values({
      department_id: body.department_id ?? null,
      slug,
      name,
      level: body.level ?? 100,
      sort_order: body.sort_order ?? 100,
      active: 1,
    })
    .returning({ id: positions.id });

  await audit(c, {
    action: "position.create",
    entityType: "position",
    entityId: inserted[0]?.id,
    summary: `Created position "${name}"`,
    meta: { name, slug, department_id: body.department_id ?? null },
  });

  return c.json({ id: inserted[0]?.id, slug, name });
});

/** PATCH /api/positions/:id  Body: { name?, department_id?, level?, sort_order?, active? } */
app.patch("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Position not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    department_id?: number | null;
    level?: number;
    sort_order?: number;
    active?: boolean;
  }>();

  const set: Record<string, unknown> = {};
  if (body.name !== undefined) set.name = body.name.trim();
  if (body.department_id !== undefined) set.department_id = body.department_id;
  if (body.level !== undefined) set.level = body.level;
  if (body.sort_order !== undefined) set.sort_order = body.sort_order;
  if (body.active !== undefined) set.active = body.active ? 1 : 0;
  if (Object.keys(set).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await db.update(positions).set(set).where(eq(positions.id, id));
  await audit(c, {
    action: "position.update",
    entityType: "position",
    entityId: id,
    summary: `Updated position #${id}`,
    meta: { changed: Object.keys(set) },
  });
  return c.json({ ok: true });
});

/** DELETE /api/positions/:id  Refuses if any user still holds it. */
app.delete("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Position not found" }, 404);

  const inUse = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(eq(users.position_id, id));
  const count = inUse[0]?.count ?? 0;
  if (count > 0) {
    return c.json(
      { error: `Position is in use by ${count} user(s) — reassign them first` },
      409,
    );
  }

  // The page-access matrix FK (position_page_access.position_id) was ON DELETE
  // CASCADE in the schema, but the D1->PG load dropped it to NO ACTION — so a
  // bare delete throws once a position has any saved matrix row (virtually all
  // real positions do). Clear children first (same cutover fix as departments).
  await c.env.DB.prepare(`DELETE FROM position_page_access WHERE position_id = ?`)
    .bind(id)
    .run();

  await db.delete(positions).where(eq(positions.id, id));
  await audit(c, {
    action: "position.delete",
    entityType: "position",
    entityId: id,
    summary: `Deleted position #${id}`,
  });
  return c.json({ ok: true });
});

/**
 * GET /api/positions/:id/page-access
 * The position's per-page map. Unlike roles, positions have NO permission-set
 * backfill — any page without an explicit row defaults to "none".
 */
app.get("/:id/page-access", requirePermission("users.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const db = getDb(c.env);

  const posRow = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.id, id))
    .limit(1);
  if (posRow.length === 0) return c.json({ error: "Position not found" }, 404);

  // Effective level = what the position actually resolves to at login (inherit
  // model: children inherit the parent unless they have an explicit row). The
  // `explicit` flag marks rows the admin set directly vs inherited — so the
  // editor shows the true effective access and only sends overrides on save.
  const effective = await loadPageAccessForPosition(c.env, id);
  const rows = await db
    .select({ page_key: position_page_access.page_key, level: position_page_access.level })
    .from(position_page_access)
    .where(eq(position_page_access.position_id, id));
  const explicitKeys = new Set(
    rows.filter((r) => isValidPageKey(r.page_key) && isValidPositionLevel(r.level)).map((r) => r.page_key),
  );

  const out: Record<string, { level: AccessLevel; explicit: boolean }> = {};
  for (const p of PAGES) {
    out[p.key] = { level: effective[p.key] ?? "none", explicit: explicitKeys.has(p.key) };
  }

  return c.json({ position_id: id, page_access: out });
});

/**
 * PATCH /api/positions/:id/page-access
 * Body: { entries: Array<{ page_key, level }> } — upsert on (position_id, page_key).
 * Levels are 4-level (none/view/edit/full).
 */
app.patch("/:id/page-access", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const body = await c.req.json<{ entries: Array<{ page_key: string; level: string }> }>();
  if (!body || !Array.isArray(body.entries) || body.entries.length === 0) {
    return c.json({ error: "entries[] is required" }, 400);
  }

  const cleaned: Array<{ page_key: string; level: string }> = [];
  for (const e of body.entries) {
    if (!isValidPageKey(e.page_key)) {
      return c.json({ error: `Unknown page_key: ${e.page_key}` }, 400);
    }
    if (!isValidPositionLevel(e.level)) {
      return c.json({ error: `Invalid level: ${e.level}` }, 400);
    }
    cleaned.push({ page_key: e.page_key, level: e.level });
  }

  const db = getDb(c.env);
  const posRow = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.id, id))
    .limit(1);
  if (posRow.length === 0) return c.json({ error: "Position not found" }, 404);

  for (const e of cleaned) {
    await c.env.DB.prepare(
      `INSERT INTO position_page_access (position_id, page_key, level, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(position_id, page_key) DO UPDATE SET
         level = excluded.level, updated_at = excluded.updated_at`,
    )
      .bind(id, e.page_key, e.level)
      .run();
  }

  await audit(c, {
    action: "position.page_access.update",
    entityType: "position",
    entityId: id,
    summary: `Updated page access for position #${id} (${cleaned.length} page(s))`,
    meta: { entries: cleaned },
  });

  return c.json({ ok: true, written: cleaned.length });
});

export default app;
