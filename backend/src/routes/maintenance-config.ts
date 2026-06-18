// ----------------------------------------------------------------------------
// /maintenance-config — variant config (Bedframe + Sofa + Fabrics) with
// effective-date versioning. 1:1 clone of 2990s apps/api/src/routes/
// maintenance-config.ts (PostgREST -> Drizzle).
//
// scope encoding: 'master', 'customer:<uuid>', or 'supplier:<uuid>' (stored as
// TEXT). Append-only history: each POST inserts a new effective-dated row; the
// newest row with effective_from <= asOf wins.
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4 — 2990s gated writes via authed-staff / RLS, collapsed to owner-only);
// created_by -> users.id INTEGER soft-ref (c.get("user").id); reads the canonical
// `maintenance_config_history` table.
//
// DROPPED vs 2990s: POST /sofa-compartments/rename delegated to the
// rename_sofa_compartment() SECURITY DEFINER Postgres function (migration 0149)
// — Houzs has no such function; the endpoint returns 501 not_configured. The
// cascade-rename is out of this slice's scope (TODO: port the rename as a
// Drizzle transaction when the SO/cart line snapshots it touches are needed).
//
// Endpoints:
//   GET    /maintenance-config/resolved?scope=&asOf=
//   GET    /maintenance-config/history?scope=
//   POST   /maintenance-config/changes
//   POST   /maintenance-config/sofa-compartments/rename   (501)
//   DELETE /maintenance-config/changes/:id
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { maintenanceConfigHistory } from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => new Date().toISOString().slice(0, 10);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseScope(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (s === "master") return "master";
  if (s.startsWith("customer:")) {
    const id = s.slice("customer:".length).trim();
    return id ? `customer:${id}` : null;
  }
  if (s.startsWith("supplier:")) {
    const id = s.slice("supplier:".length).trim();
    return id ? `supplier:${id}` : null;
  }
  return null;
}

function genId(): string {
  const rnd = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `mch-${rnd}`;
}

// ── GET /resolved ──────────────────────────────────────────────────────
app.get("/resolved", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  if (!scope) return c.json({ error: "scope_required" }, 400);

  const asOfRaw = (c.req.query("asOf") ?? "").trim();
  const asOf = ISO_DATE.test(asOfRaw) ? asOfRaw : todayIso();
  const db = getDb(c.env);

  try {
    const rows = await db
      .select()
      .from(maintenanceConfigHistory)
      .where(and(eq(maintenanceConfigHistory.scope, scope), lte(maintenanceConfigHistory.effectiveFrom, asOf)))
      .orderBy(desc(maintenanceConfigHistory.effectiveFrom), desc(maintenanceConfigHistory.createdAt))
      .limit(1);

    if (!rows.length) {
      return c.json({ data: null, effectiveFrom: null, hasPendingPriceChange: false, pendingEffectiveFrom: null });
    }
    const row = rows[0];

    const pending = await db
      .select({ effective_from: maintenanceConfigHistory.effectiveFrom })
      .from(maintenanceConfigHistory)
      .where(and(eq(maintenanceConfigHistory.scope, scope), gt(maintenanceConfigHistory.effectiveFrom, asOf)))
      .orderBy(asc(maintenanceConfigHistory.effectiveFrom))
      .limit(1);

    return c.json({
      data: row.config,
      effectiveFrom: row.effectiveFrom,
      hasPendingPriceChange: pending.length > 0,
      pendingEffectiveFrom: pending[0]?.effective_from ?? null,
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /history ───────────────────────────────────────────────────────
app.get("/history", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  if (!scope) return c.json({ error: "scope_required" }, 400);
  const db = getDb(c.env);

  try {
    const data = await db
      .select()
      .from(maintenanceConfigHistory)
      .where(eq(maintenanceConfigHistory.scope, scope))
      .orderBy(desc(maintenanceConfigHistory.effectiveFrom), desc(maintenanceConfigHistory.createdAt));

    const today = todayIso();
    const rows = data.map((r) => ({
      id: r.id,
      scope: r.scope,
      config: r.config,
      effectiveFrom: r.effectiveFrom,
      notes: r.notes ?? "",
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      createdBy: r.createdBy,
      isPending: r.effectiveFrom > today,
    }));
    return c.json({ history: rows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /changes ──────────────────────────────────────────────────────
app.post("/changes", async (c) => {
  let body: { scope?: string; config?: unknown; effectiveFrom?: string; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const scope = parseScope(body.scope);
  if (!scope) return c.json({ error: "scope_required" }, 400);

  const effectiveFrom = (body.effectiveFrom ?? "").trim();
  if (!ISO_DATE.test(effectiveFrom)) return c.json({ error: "effective_from_required", message: "YYYY-MM-DD" }, 400);
  if (body.config == null) return c.json({ error: "config_required" }, 400);

  const db = getDb(c.env);
  const user = c.get("user");
  const id = genId();

  try {
    const inserted = await db
      .insert(maintenanceConfigHistory)
      .values({
        id,
        scope,
        config: body.config,
        effectiveFrom,
        notes: body.notes ?? null,
        createdBy: user.id,
      })
      .returning();
    const row = inserted[0];
    return c.json(
      { id: row.id, scope: row.scope, config: row.config, effectiveFrom: row.effectiveFrom, notes: row.notes ?? "" },
      201,
    );
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /sofa-compartments/rename — not wired this slice ──────────────
// 2990s delegated to the rename_sofa_compartment() SECURITY DEFINER function
// (migration 0149) that atomically renames a compartment code across the SKU
// master, every doc-line snapshot, combos, quick picks, carts + the maintenance
// config blobs. Houzs has no such function; the cascade is out of slice scope.
app.post("/sofa-compartments/rename", (c) =>
  c.json({ error: "not_configured", reason: "Cascade compartment rename not wired in this slice." }, 501),
);

// ── DELETE /changes/:id ────────────────────────────────────────────────
app.delete("/changes/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    const found = await db
      .select({ id: maintenanceConfigHistory.id })
      .from(maintenanceConfigHistory)
      .where(eq(maintenanceConfigHistory.id, id))
      .limit(1);
    if (!found[0]) return c.json({ error: "not_found" }, 404);
    await db.delete(maintenanceConfigHistory).where(eq(maintenanceConfigHistory.id, id));
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
