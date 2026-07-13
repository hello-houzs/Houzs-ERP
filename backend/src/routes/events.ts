import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { hasPermission } from "../services/permissions";
import { activeCompanyId } from "../scm/lib/companyScope";
import { getDb } from "../db/client";
import { events, lorries, projects, users } from "../db/schema";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

/**
 * Events — manual setup / dismantle calendar entries.
 *
 * Not tied to sales orders. The dispatcher creates them for one-off
 * jobs (e.g. "Setup at Customer X tomorrow"). Status is intentionally
 * a free-text field until the lifecycle is finalized — no validation
 * here so the dispatcher can experiment.
 *
 * Permissions:
 *   read  → trips.read.all
 *   write → trips.manage
 */

const PATCHABLE = ["type", "title", "event_date", "address", "status", "notes"] as const;

app.get("/", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user.permissions, "trips.read.all")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");
  const type = c.req.query("type");

  const db = getDb(c.env);

  // Multi-company: the calendar is PER-COMPANY — both the manual events table
  // and the project-derived synthetic rows carry company_id (mig-pg 0093).
  // Predicates are added ONLY when the company context resolves, so the
  // pre-migration window / D1 test mirror keeps the legacy unscoped queries.
  const companyId = activeCompanyId(c);

  // ── Manual events ───────────────────────────────────────
  const manualConds: any[] = [];
  if (companyId != null) manualConds.push(eq(events.company_id, companyId));
  if (dateFrom) manualConds.push(gte(events.event_date, dateFrom));
  if (dateTo) manualConds.push(lte(events.event_date, dateTo));
  if (type) manualConds.push(eq(events.type, type));

  const manualRows = await db
    .select({
      id: events.id,
      type: events.type,
      title: events.title,
      event_date: events.event_date,
      address: events.address,
      status: events.status,
      notes: events.notes,
      created_by: events.created_by,
      created_at: events.created_at,
      updated_at: events.updated_at,
      created_by_name: users.name,
    })
    .from(events)
    .leftJoin(users, eq(users.id, events.created_by))
    .where(manualConds.length ? and(...manualConds) : undefined)
    .orderBy(desc(events.event_date), desc(events.id));

  const manual = manualRows.map((r) => ({
    ...r,
    source: "manual" as const,
  }));

  // ── Project-sourced events ──────────────────────────────
  // Any project with setup_start_at or dismantle_start_at populated
  // surfaces here automatically — no manual entry needed. Driver +
  // lorry are joined in so the dispatcher view shows assignment in
  // the same row. Synthetic ids use a string prefix so they can't
  // collide with the autoincrement event ids; the frontend uses the
  // `source` flag to route clicks to /projects/:id and to hide
  // edit/delete affordances for these rows.
  const wantsType = (t: "setup" | "dismantle") => !type || type === t;
  const inRangeConds = (col: any) => {
    const parts: any[] = [sql`${col} IS NOT NULL`];
    if (dateFrom) parts.push(sql`date(${col}) >= date(${dateFrom})`);
    if (dateTo) parts.push(sql`date(${col}) <= date(${dateTo})`);
    return parts;
  };

  // Join aliases — projects has two driver and two lorry FKs, so we
  // need separate joins for setup vs dismantle.
  const setupDriver = alias(users, "setup_driver");
  const dismantleDriver = alias(users, "dismantle_driver");
  const setupLorry = alias(lorries, "setup_lorry");
  const dismantleLorry = alias(lorries, "dismantle_lorry");

  type SyntheticEvent = {
    id: string;
    type: "setup" | "dismantle";
    title: string;
    event_date: string;
    address: string | null;
    status: string | null;
    notes: string | null;
    created_by: number | null;
    created_at: string | null;
    updated_at: string | null;
    created_by_name: string | null;
    source: "project";
    project_id: number;
    project_code: string | null;
    driver_name: string | null;
    lorry_plate: string | null;
    end_at: string | null;
  };
  const synthetic: SyntheticEvent[] = [];

  if (wantsType("setup")) {
    const setupRows = await db
      .select({
        project_id: projects.id,
        project_code: projects.code,
        project_name: projects.name,
        project_stage: projects.stage,
        project_venue: projects.venue,
        project_venue_address: projects.venue_address,
        project_brand: projects.brand,
        setup_start_at: projects.setup_start_at,
        setup_end_at: projects.setup_end_at,
        project_created_at: projects.created_at,
        project_updated_at: projects.updated_at,
        setup_driver_name: setupDriver.name,
        setup_lorry_plate: setupLorry.plate,
      })
      .from(projects)
      .leftJoin(setupDriver, eq(setupDriver.id, projects.setup_driver_user_id))
      .leftJoin(setupLorry, eq(setupLorry.id, projects.setup_lorry_id))
      .where(
        and(
          isNull(projects.archived_at),
          ...(companyId != null ? [eq(projects.company_id, companyId)] : []),
          ...inRangeConds(projects.setup_start_at)
        )
      )
      .orderBy(desc(projects.setup_start_at));

    for (const r of setupRows) {
      synthetic.push({
        id: `project-${r.project_id}-setup`,
        type: "setup",
        title: r.project_code
          ? `${r.project_code} · ${r.project_name}`
          : r.project_name,
        event_date: String(r.setup_start_at).slice(0, 10),
        address: r.project_venue_address || r.project_venue || null,
        status: r.project_stage || null,
        notes: assignmentNote(r.setup_driver_name, r.setup_lorry_plate),
        created_by: null,
        created_at: r.project_created_at,
        updated_at: r.project_updated_at,
        created_by_name: null,
        source: "project",
        project_id: r.project_id,
        project_code: r.project_code,
        driver_name: r.setup_driver_name,
        lorry_plate: r.setup_lorry_plate,
        end_at: r.setup_end_at,
      });
    }
  }

  if (wantsType("dismantle")) {
    const dismantleRows = await db
      .select({
        project_id: projects.id,
        project_code: projects.code,
        project_name: projects.name,
        project_stage: projects.stage,
        project_venue: projects.venue,
        project_venue_address: projects.venue_address,
        project_brand: projects.brand,
        dismantle_start_at: projects.dismantle_start_at,
        dismantle_end_at: projects.dismantle_end_at,
        project_created_at: projects.created_at,
        project_updated_at: projects.updated_at,
        dismantle_driver_name: dismantleDriver.name,
        dismantle_lorry_plate: dismantleLorry.plate,
      })
      .from(projects)
      .leftJoin(
        dismantleDriver,
        eq(dismantleDriver.id, projects.dismantle_driver_user_id)
      )
      .leftJoin(
        dismantleLorry,
        eq(dismantleLorry.id, projects.dismantle_lorry_id)
      )
      .where(
        and(
          isNull(projects.archived_at),
          ...(companyId != null ? [eq(projects.company_id, companyId)] : []),
          ...inRangeConds(projects.dismantle_start_at)
        )
      )
      .orderBy(desc(projects.dismantle_start_at));

    for (const r of dismantleRows) {
      synthetic.push({
        id: `project-${r.project_id}-dismantle`,
        type: "dismantle",
        title: r.project_code
          ? `${r.project_code} · ${r.project_name}`
          : r.project_name,
        event_date: String(r.dismantle_start_at).slice(0, 10),
        address: r.project_venue_address || r.project_venue || null,
        status: r.project_stage || null,
        notes: assignmentNote(
          r.dismantle_driver_name,
          r.dismantle_lorry_plate
        ),
        created_by: null,
        created_at: r.project_created_at,
        updated_at: r.project_updated_at,
        created_by_name: null,
        source: "project",
        project_id: r.project_id,
        project_code: r.project_code,
        driver_name: r.dismantle_driver_name,
        lorry_plate: r.dismantle_lorry_plate,
        end_at: r.dismantle_end_at,
      });
    }
  }

  // Merge — most recent date first.
  const merged = [...manual, ...synthetic].sort((a: any, b: any) => {
    if (a.event_date !== b.event_date) return a.event_date < b.event_date ? 1 : -1;
    return String(b.id).localeCompare(String(a.id));
  });

  return c.json({ data: merged });
});

function assignmentNote(driver: string | null, lorry: string | null): string | null {
  if (!driver && !lorry) return null;
  const parts: string[] = [];
  if (driver) parts.push(`Driver: ${driver}`);
  if (lorry) parts.push(`Lorry: ${lorry}`);
  return parts.join(" · ");
}

app.post("/", requirePermission("trips.manage"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<any>();
  if (!body?.type || !body?.title || !body?.event_date) {
    return c.json({ error: "type, title, event_date required" }, 400);
  }
  if (body.type !== "setup" && body.type !== "dismantle") {
    return c.json({ error: "type must be setup or dismantle" }, 400);
  }
  const db = getDb(c.env);
  // Multi-company: stamp the active company; omitted (PG DEFAULT applies)
  // when the company context is unresolved.
  const companyId = activeCompanyId(c);
  const inserted = await db
    .insert(events)
    .values({
      type: body.type,
      title: body.title,
      event_date: body.event_date,
      address: body.address ?? null,
      status: body.status ?? null,
      notes: body.notes ?? null,
      created_by: user.id,
      ...(companyId != null ? { company_id: companyId } : {}),
    })
    .returning({ id: events.id });
  return c.json({ id: inserted[0]?.id });
});

app.patch("/:id", requirePermission("trips.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid ID." }, 400);
  const body = await c.req.json<any>();

  if ("type" in body && body.type !== "setup" && body.type !== "dismantle") {
    return c.json({ error: "type must be setup or dismantle" }, 400);
  }

  const set: Record<string, any> = {};
  for (const k of PATCHABLE) {
    if (k in body) set[k] = body[k] ?? null;
  }
  if (Object.keys(set).length === 0) return c.json({ error: "No fields" }, 400);
  set.updated_at = sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')`;

  const db = getDb(c.env);
  // Multi-company: an edit can only land on the active company's row.
  const companyId = activeCompanyId(c);
  const result = await db
    .update(events)
    .set(set)
    .where(
      and(
        eq(events.id, id),
        ...(companyId != null ? [eq(events.company_id, companyId)] : []),
      ),
    );
  return c.json({ ok: (result.count ?? 0) > 0 });
});

app.delete("/:id", requirePermission("trips.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid ID." }, 400);
  const db = getDb(c.env);
  const companyId = activeCompanyId(c);
  await db
    .delete(events)
    .where(
      and(
        eq(events.id, id),
        ...(companyId != null ? [eq(events.company_id, companyId)] : []),
      ),
    );
  return c.json({ ok: true });
});

export default app;
