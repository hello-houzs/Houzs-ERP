// ----------------------------------------------------------------------------
// /fabric-tracking — Fabric Converter: cost ledger + per-context price tiers.
// 1:1 clone of 2990s apps/api/src/routes/fabric-tracking.ts (PostgREST ->
// Drizzle). Reads the static fabric_trackings table; mirrors new/imported
// fabrics into the SELLING library (fabric_library + fabric_colours).
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4); the selling-library mirror uses Drizzle onConflictDoNothing (the RLS
// "INSERT-only, never clobber a tier edit" semantics 2990s relied on — never
// overwrite, so DO NOTHING matches).
//
// Endpoints:
//   GET   /fabric-tracking?category=&search=
//   POST  /fabric-tracking                 create one
//   POST  /fabric-tracking/bulk-upsert     CSV import (per-column partial upsert by id)
//   DELETE /fabric-tracking/:id            delete one
//   PATCH /fabric-tracking/:id/active
//   PATCH /fabric-tracking/:id/series
//   PATCH /fabric-tracking/:id/supplier-code
//   PATCH /fabric-tracking/:id/description
//   PATCH /fabric-tracking/:id/tier
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, eq, inArray, or, ilike, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  fabricTrackings,
  fabricLibrary,
  fabricColours,
  mfgProducts,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";

type Db = ReturnType<typeof getDb>;

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

const VALID_CATEGORIES = new Set(["B.M-FABR", "S-FABR", "S.M-FABR", "LINING", "WEBBING"]);
type FabricCategory = "B.M-FABR" | "S-FABR" | "S.M-FABR" | "LINING" | "WEBBING";
const VALID_TIER_FIELDS = new Set(["sofaPriceTier", "bedframePriceTier"]);
const VALID_TIERS = new Set(["PRICE_1", "PRICE_2", "PRICE_3"]);
type FabricTier = "PRICE_1" | "PRICE_2" | "PRICE_3";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}
function isFkViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23503");
}
function escapeForOr(search: string): string {
  return String(search ?? "").replace(/[,(){}]/g, "").trim();
}

// SELLING library projection: series = code prefix before '-'; colour = code,
// labelled with the text after the first space in the description.
const seriesOf = (code: string): string => code.split("-")[0] || code;
const colourLabelOf = (code: string, description: string | null): string => {
  const desc = (description ?? "").trim();
  const sp = desc.indexOf(" ");
  return sp > 0 ? desc.slice(sp + 1).trim() : code;
};

// Mirror a fabric into the SELLING library (series + colour). INSERT-only
// (onConflictDoNothing) — never clobber a Master-Admin selling-tier edit.
async function syncFabricToSellingLibrary(db: Db, fabricCode: string, description: string | null): Promise<string | null> {
  const code = fabricCode.trim();
  if (!code) return null;
  const series = seriesOf(code);
  try {
    await db
      .insert(fabricLibrary)
      .values({ id: series, label: series, tier: "standard", defaultSurcharge: 0, active: true, sortOrder: 0 })
      .onConflictDoNothing({ target: fabricLibrary.id });
  } catch (e) {
    return `fabric_library: ${errMsg(e)}`;
  }
  try {
    await db
      .insert(fabricColours)
      .values({ fabricId: series, colourId: code, label: colourLabelOf(code, description), swatchHex: null, active: true, sortOrder: 0 })
      .onConflictDoNothing({ target: [fabricColours.fabricId, fabricColours.colourId] });
  } catch (e) {
    return `fabric_colours: ${errMsg(e)}`;
  }
  return null;
}

// ── POST / ───────────────────────────────────────────────────────────
app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const fabricCode = String(body.fabricCode ?? "").trim();
  if (!fabricCode) return c.json({ error: "fabric_code_required" }, 400);
  const cat = body.fabricCategory as string | undefined;
  if (cat && !VALID_CATEGORIES.has(cat)) return c.json({ error: "invalid_category" }, 400);

  const id = String(body.id ?? fabricCode.toUpperCase().replace(/\s+/g, "_"));
  const row = {
    id,
    fabricCode,
    fabricDescription: (body.fabricDescription as string) ?? null,
    fabricCategory: (cat as FabricCategory) ?? null,
    sofaPriceTier: (body.sofaPriceTier as FabricTier) ?? null,
    bedframePriceTier: (body.bedframePriceTier as FabricTier) ?? null,
    supplierCode: (body.supplierCode as string) ?? null,
    series: (body.series as string) ?? null,
    priceCenti: typeof body.priceCenti === "number" ? body.priceCenti : 0,
    isActive: typeof body.isActive === "boolean" ? body.isActive : true,
  };

  const db = getDb(c.env);
  try {
    const inserted = await db.insert(fabricTrackings).values(row).returning();
    const libraryWarning = await syncFabricToSellingLibrary(db, fabricCode, (body.fabricDescription as string) ?? null);
    return c.json({ fabric: inserted[0], fabricSeries: seriesOf(fabricCode), libraryWarning }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_code" }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /bulk-upsert ────────────────────────────────────────────────
app.post("/bulk-upsert", async (c) => {
  let body: { rows?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!Array.isArray(body.rows)) return c.json({ error: "rows_array_required" }, 400);
  if (body.rows.length === 0) return c.json({ upserted: 0, errors: [] });
  if (body.rows.length > 2000) return c.json({ error: "too_many_rows", max: 2000 }, 413);

  const STRING_COLS: Array<[string, string]> = [
    ["fabricDescription", "fabricDescription"],
    ["supplierCode", "supplierCode"],
    ["supplier", "supplier"],
    ["sofaPriceTier", "sofaPriceTier"],
    ["bedframePriceTier", "bedframePriceTier"],
    ["series", "series"],
  ];
  const INT_COLS: Array<[string, string]> = [
    ["priceCenti", "priceCenti"],
    ["sohCenti", "sohCenti"],
    ["poOutstandingCenti", "poOutstandingCenti"],
    ["lastMonthUsageCenti", "lastMonthUsageCenti"],
    ["oneWeekUsageCenti", "oneWeekUsageCenti"],
    ["twoWeeksUsageCenti", "twoWeeksUsageCenti"],
    ["oneMonthUsageCenti", "oneMonthUsageCenti"],
    ["shortageCenti", "shortageCenti"],
    ["reorderPointCenti", "reorderPointCenti"],
    ["leadTimeDays", "leadTimeDays"],
  ];

  const errors: Array<{ index: number; reason: string }> = [];
  const dbRows: Array<Record<string, unknown>> = [];

  (body.rows as unknown[]).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") {
      errors.push({ index: i, reason: "not_object" });
      return;
    }
    const r = raw as Record<string, unknown>;
    const code = typeof r.fabricCode === "string" ? r.fabricCode.trim() : "";
    if (!code) {
      errors.push({ index: i, reason: "missing_fabric_code" });
      return;
    }
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : code.toUpperCase().replace(/\s+/g, "_");
    const row: Record<string, unknown> = { id, fabricCode: code };
    for (const [k, col] of STRING_COLS) {
      if (k in r) {
        const v = r[k];
        row[col] = v === "" || v == null ? null : String(v);
      }
    }
    let rowFailed = false;
    for (const [k, col] of INT_COLS) {
      if (k in r) {
        const v = r[k];
        if (v === "" || v == null) {
          row[col] = 0;
          continue;
        }
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          errors.push({ index: i, reason: `invalid_${col}` });
          rowFailed = true;
          break;
        }
        row[col] = Math.trunc(n);
      }
    }
    if (!rowFailed) dbRows.push(row);
  });

  if (dbRows.length === 0) return c.json({ upserted: 0, errors }, errors.length ? 400 : 200);

  const db = getDb(c.env);
  try {
    // Per-column partial upsert by id: only the columns present in each row are
    // written; on conflict, update exactly those columns (DB defaults fill the
    // rest on insert). Drizzle's onConflictDoUpdate needs a static `set`, so we
    // upsert row-by-row to honour the per-row column subset 2990s relied on.
    for (const row of dbRows) {
      const setCols: Record<string, unknown> = {};
      for (const k of Object.keys(row)) {
        if (k === "id") continue;
        setCols[k] = row[k];
      }
      await db
        .insert(fabricTrackings)
        .values(row as typeof fabricTrackings.$inferInsert)
        .onConflictDoUpdate({ target: fabricTrackings.id, set: setCols });
    }
  } catch (e) {
    return c.json({ error: "bulk_upsert_failed", reason: errMsg(e), errors }, 500);
  }

  // Mirror into the SELLING library (batched, INSERT-only).
  const seriesSet = [...new Set(dbRows.map((r) => seriesOf(String(r.fabricCode))))];
  try {
    if (seriesSet.length > 0) {
      await db
        .insert(fabricLibrary)
        .values(seriesSet.map((s, i) => ({ id: s, label: s, tier: "standard", defaultSurcharge: 0, active: true, sortOrder: (i + 1) * 10 })))
        .onConflictDoNothing({ target: fabricLibrary.id });
    }
    const colourRows = dbRows.map((r) => {
      const code = String(r.fabricCode);
      return {
        fabricId: seriesOf(code),
        colourId: code,
        label: colourLabelOf(code, typeof r.fabricDescription === "string" ? r.fabricDescription : null),
        swatchHex: null,
        active: true,
        sortOrder: 0,
      };
    });
    if (colourRows.length > 0) {
      await db.insert(fabricColours).values(colourRows).onConflictDoNothing({ target: [fabricColours.fabricId, fabricColours.colourId] });
    }
  } catch {
    /* best-effort: procurement upsert already committed */
  }

  return c.json({ upserted: dbRows.length, errors });
});

// ── DELETE /:id ──────────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    await db.delete(fabricTrackings).where(eq(fabricTrackings.id, id));
    return c.body(null, 204);
  } catch (e) {
    if (isFkViolation(e)) {
      return c.json({ error: "fabric_in_use", reason: "Fabric is referenced by a product or PO; remove those links first." }, 409);
    }
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET / ────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const category = c.req.query("category");
  const search = c.req.query("search");
  const db = getDb(c.env);
  try {
    const conds = [];
    if (category && VALID_CATEGORIES.has(category)) conds.push(eq(fabricTrackings.fabricCategory, category as FabricCategory));
    if (search) {
      const s = escapeForOr(search);
      if (s) {
        const like = `%${s}%`;
        conds.push(or(ilike(fabricTrackings.fabricCode, like), ilike(fabricTrackings.fabricDescription, like))!);
      }
    }
    const rows = await db
      .select()
      .from(fabricTrackings)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(fabricTrackings.fabricCode));
    // 2990s returned the snake_case column set verbatim; map the Drizzle row.
    const fabrics = rows.map((r) => ({
      id: r.id,
      fabric_code: r.fabricCode,
      fabric_description: r.fabricDescription,
      fabric_category: r.fabricCategory,
      price_tier: r.priceTier,
      sofa_price_tier: r.sofaPriceTier,
      bedframe_price_tier: r.bedframePriceTier,
      price_centi: r.priceCenti,
      soh_centi: r.sohCenti,
      po_outstanding_centi: r.poOutstandingCenti,
      last_month_usage_centi: r.lastMonthUsageCenti,
      one_week_usage_centi: r.oneWeekUsageCenti,
      two_weeks_usage_centi: r.twoWeeksUsageCenti,
      one_month_usage_centi: r.oneMonthUsageCenti,
      shortage_centi: r.shortageCenti,
      reorder_point_centi: r.reorderPointCenti,
      supplier: r.supplier,
      supplier_code: r.supplierCode,
      lead_time_days: r.leadTimeDays,
      series: r.series,
      is_active: r.isActive,
    }));
    return c.json({ fabrics });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /:id/active ─────────────────────────────────────────────────
app.patch("/:id/active", async (c) => {
  const id = c.req.param("id");
  let body: { isActive?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body.isActive !== "boolean") return c.json({ error: "is_active_boolean_required" }, 400);

  const db = getDb(c.env);
  try {
    await db.update(fabricTrackings).set({ isActive: body.isActive }).where(eq(fabricTrackings.id, id));
    return c.json({ ok: true, isActive: body.isActive });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /:id/series ─────────────────────────────────────────────────
app.patch("/:id/series", async (c) => {
  const id = c.req.param("id");
  let body: { series?: string | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const trimmed = typeof body.series === "string" ? body.series.trim() : null;
  const next = trimmed === "" ? null : trimmed;
  const db = getDb(c.env);
  try {
    await db.update(fabricTrackings).set({ series: next }).where(eq(fabricTrackings.id, id));
    return c.json({ ok: true, series: next });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /:id/supplier-code ──────────────────────────────────────────
app.patch("/:id/supplier-code", async (c) => {
  const id = c.req.param("id");
  let body: { supplierCode?: string | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const trimmed = typeof body.supplierCode === "string" ? body.supplierCode.trim() : null;
  const next = trimmed === "" ? null : trimmed;
  const db = getDb(c.env);
  try {
    await db.update(fabricTrackings).set({ supplierCode: next }).where(eq(fabricTrackings.id, id));
    return c.json({ ok: true, supplierCode: next });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /:id/description ────────────────────────────────────────────
app.patch("/:id/description", async (c) => {
  const id = c.req.param("id");
  let body: { description?: string | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const trimmed = typeof body.description === "string" ? body.description.trim() : null;
  const next = trimmed === "" ? null : trimmed;
  const db = getDb(c.env);
  try {
    await db.update(fabricTrackings).set({ fabricDescription: next }).where(eq(fabricTrackings.id, id));
    return c.json({ ok: true, description: next });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /:id/tier ───────────────────────────────────────────────────
app.patch("/:id/tier", async (c) => {
  const id = c.req.param("id");
  let body: { field?: string; tier?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.field || !VALID_TIER_FIELDS.has(body.field)) {
    return c.json({ error: "invalid_field", allowed: [...VALID_TIER_FIELDS] }, 400);
  }
  if (!body.tier || !VALID_TIERS.has(body.tier)) {
    return c.json({ error: "invalid_tier", allowed: [...VALID_TIERS] }, 400);
  }

  const db = getDb(c.env);
  try {
    const fabricRows = await db
      .select({ fabric_code: fabricTrackings.fabricCode })
      .from(fabricTrackings)
      .where(eq(fabricTrackings.id, id))
      .limit(1);
    const fabricCode = fabricRows[0]?.fabric_code ?? null;

    const set =
      body.field === "sofaPriceTier" ? { sofaPriceTier: body.tier as FabricTier } : { bedframePriceTier: body.tier as FabricTier };
    await db.update(fabricTrackings).set(set).where(eq(fabricTrackings.id, id));

    // Downstream-product count (propagation hint). Sofa tier affects SOFA +
    // ACCESSORY; bedframe tier affects BEDFRAME only.
    let affectedProducts = 0;
    if (fabricCode) {
      const targetCategories: Array<"SOFA" | "BEDFRAME" | "ACCESSORY"> =
        body.field === "bedframePriceTier" ? ["BEDFRAME"] : ["SOFA", "ACCESSORY"];
      const cntRows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(mfgProducts)
        .where(and(eq(mfgProducts.fabricColor, fabricCode), inArray(mfgProducts.category, targetCategories)));
      affectedProducts = cntRows[0]?.n ?? 0;
    }
    return c.json({ ok: true, affectedProducts, fabricCode });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
