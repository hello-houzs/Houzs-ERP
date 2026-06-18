// ----------------------------------------------------------------------------
// /sofa-combos — Sofa Combo Pricing maintenance. 1:1 clone of 2990s
// apps/api/src/routes/sofa-combos.ts (PostgREST -> Drizzle). Module-set combo
// deals — when a SO/POS line composes the modules array on a base model with the
// matching tier + customer scope, the combo price OVERRIDES per-Model
// compartment pricing. Append-only history: editing INSERTs a new effective row.
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4 — 2990s gated writes via a WRITE_ROLES staff-role lookup, collapsed to the
// module's owner-only mount); created_by -> users.id INTEGER soft-ref; reads the
// ported @shared combo helpers + the lib loadModelSofaModuleCosts (Drizzle).
//
// Endpoints:
//   GET    /sofa-combos               list (filterable; active-per-scope reducer)
//   GET    /sofa-combos/history       append-only history rows for one scope tuple
//   POST   /sofa-combos               create (insert new effective row)
//   PUT    /sofa-combos/:id           convenience: re-insert by id with new prices
//   DELETE /sofa-combos/:id           soft-delete (deleted_at = now)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  canonicalizeComboModulesForStorage,
  comboSlotsKey,
  sofaComboCostSen,
  parseDefaultFreeGifts,
  type ComboSlots,
} from "@shared/index";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { sofaComboPricing } from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { loadModelSofaModuleCosts } from "../lib/mfg-pricing-recompute";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => new Date().toISOString().slice(0, 10);
const TIERS = new Set(["PRICE_1", "PRICE_2", "PRICE_3"]);
type Tier = "PRICE_1" | "PRICE_2" | "PRICE_3" | null;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type RowDb = typeof sofaComboPricing.$inferSelect;
function rowToWire(r: RowDb) {
  return {
    id: r.id,
    baseModel: r.baseModel,
    modules: r.modules,
    tier: r.tier,
    customerId: r.customerId,
    supplierId: r.supplierId,
    pricesByHeight: (r.pricesByHeight as Record<string, number | null>) ?? {},
    sellingPricesByHeight: (r.sellingPricesByHeight as Record<string, number | null>) ?? {},
    pwpPricesByHeight: (r.pwpPricesByHeight as Record<string, number | null>) ?? {},
    defaultFreeGifts: r.defaultFreeGifts ?? [],
    label: r.label,
    effectiveFrom: r.effectiveFrom,
    deletedAt: r.deletedAt instanceof Date ? r.deletedAt.toISOString() : r.deletedAt,
    notes: r.notes ?? "",
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
    createdBy: r.createdBy,
  };
}

function validateComboModules(v: unknown): ComboSlots | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  for (const entry of v) {
    if (Array.isArray(entry)) {
      if (entry.some((x) => typeof x !== "string")) return null;
    } else if (typeof entry !== "string") {
      return null;
    }
  }
  return canonicalizeComboModulesForStorage(v);
}

function validatePricesByHeight(v: unknown): Record<string, number | null> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number | null> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(k)) return null;
    if (raw === null || raw === undefined || raw === "") {
      out[k] = null;
      continue;
    }
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    out[k] = Math.round(n);
  }
  return out;
}

// ── GET / ────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const baseModel = (c.req.query("baseModel") ?? "").trim();
  const customerIdRaw = c.req.query("customerId");
  const supplierIdRaw = c.req.query("supplierId");
  const includeAll = c.req.query("includeAll") === "1";

  try {
    const conds = [];
    if (!includeAll) conds.push(isNull(sofaComboPricing.deletedAt));
    if (baseModel) conds.push(eq(sofaComboPricing.baseModel, baseModel));
    if (customerIdRaw !== undefined) {
      if (customerIdRaw === "" || customerIdRaw === "__all__" || customerIdRaw === "null") {
        conds.push(isNull(sofaComboPricing.customerId));
      } else {
        conds.push(eq(sofaComboPricing.customerId, customerIdRaw));
      }
    }
    if (supplierIdRaw !== undefined && supplierIdRaw !== "" && supplierIdRaw !== "null") {
      conds.push(eq(sofaComboPricing.supplierId, supplierIdRaw));
    } else {
      conds.push(isNull(sofaComboPricing.supplierId));
    }

    const rows = await db
      .select()
      .from(sofaComboPricing)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(sofaComboPricing.baseModel), desc(sofaComboPricing.effectiveFrom), desc(sofaComboPricing.createdAt));

    if (includeAll) return c.json({ rules: rows.map(rowToWire) });

    // Reduce to "currently active per scope tuple".
    const today = todayIso();
    const seen = new Set<string>();
    const out: RowDb[] = [];
    for (const r of rows) {
      if (r.effectiveFrom > today) continue;
      const key = JSON.stringify([r.baseModel, comboSlotsKey((r.modules as string[][]) ?? []), r.tier, r.customerId, r.supplierId]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return c.json({ rules: out.map(rowToWire) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /history ─────────────────────────────────────────────────────
app.get("/history", async (c) => {
  const db = getDb(c.env);
  const baseModel = (c.req.query("baseModel") ?? "").trim();
  const tierRaw = (c.req.query("tier") ?? "").trim();
  const customerIdRaw = c.req.query("customerId");
  const supplierIdRaw = c.req.query("supplierId");
  const modulesRaw = c.req.query("modules");

  if (!baseModel) return c.json({ error: "base_model_required" }, 400);
  if (!modulesRaw) return c.json({ error: "modules_required" }, 400);

  let parsedModules: unknown;
  try {
    parsedModules = JSON.parse(modulesRaw);
  } catch {
    parsedModules = modulesRaw.split(",");
  }
  const wantedKey = comboSlotsKey(Array.isArray(parsedModules) ? (parsedModules as (string | string[])[]) : modulesRaw.split(","));
  const tier: Tier = TIERS.has(tierRaw) ? (tierRaw as Tier) : null;

  try {
    const conds = [eq(sofaComboPricing.baseModel, baseModel)];
    if (tier === null) conds.push(isNull(sofaComboPricing.tier));
    else conds.push(eq(sofaComboPricing.tier, tier));
    if (customerIdRaw === undefined || customerIdRaw === "" || customerIdRaw === "null") {
      conds.push(isNull(sofaComboPricing.customerId));
    } else {
      conds.push(eq(sofaComboPricing.customerId, customerIdRaw));
    }
    if (supplierIdRaw !== undefined && supplierIdRaw !== "" && supplierIdRaw !== "null") {
      conds.push(eq(sofaComboPricing.supplierId, supplierIdRaw));
    } else {
      conds.push(isNull(sofaComboPricing.supplierId));
    }

    const rows = await db
      .select()
      .from(sofaComboPricing)
      .where(and(...conds))
      .orderBy(desc(sofaComboPricing.effectiveFrom), desc(sofaComboPricing.createdAt));

    const matching = rows.filter((r) => comboSlotsKey((r.modules as string[][]) ?? []) === wantedKey);
    return c.json({ rules: matching.map(rowToWire) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST / ───────────────────────────────────────────────────────────
app.post("/", async (c) => {
  let body: {
    baseModel?: string;
    modules?: unknown;
    tier?: string | null;
    customerId?: string | null;
    supplierId?: string | null;
    pricesByHeight?: unknown;
    sellingPricesByHeight?: unknown;
    pwpPricesByHeight?: unknown;
    defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
    label?: string | null;
    effectiveFrom?: string;
    notes?: string | null;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const baseModel = (body.baseModel ?? "").trim();
  if (!baseModel) return c.json({ error: "base_model_required" }, 400);
  const modules = validateComboModules(body.modules);
  if (!modules) return c.json({ error: "modules_required" }, 400);

  const tier: Tier =
    body.tier === null || body.tier === "" || body.tier === undefined ? null : TIERS.has(body.tier) ? (body.tier as Tier) : null;
  const customerId = body.customerId === null || body.customerId === "" || body.customerId === undefined ? null : body.customerId;
  const supplierId = body.supplierId === null || body.supplierId === "" || body.supplierId === undefined ? null : body.supplierId;

  const db = getDb(c.env);
  const user = c.get("user");

  const sellingProvided = body.sellingPricesByHeight !== undefined;
  const selling = sellingProvided ? validatePricesByHeight(body.sellingPricesByHeight) : null;
  if (sellingProvided && !selling) return c.json({ error: "selling_prices_by_height_invalid" }, 400);

  const pwpProvided = body.pwpPricesByHeight !== undefined;
  const pwpPrices = pwpProvided ? validatePricesByHeight(body.pwpPricesByHeight) : null;
  if (pwpProvided && !pwpPrices) return c.json({ error: "pwp_prices_by_height_invalid" }, 400);

  // COST prices: explicit, or auto-detect = Σ module SKU costs, else reject.
  let prices: Record<string, number | null> | null;
  if (body.pricesByHeight !== undefined) {
    prices = validatePricesByHeight(body.pricesByHeight);
    if (!prices) return c.json({ error: "prices_by_height_invalid" }, 400);
  } else if (selling) {
    const moduleCosts = await loadModelSofaModuleCosts(db, baseModel);
    const costSen = sofaComboCostSen(modules, moduleCosts ?? {});
    prices = {};
    for (const h of Object.keys(selling)) prices[h] = costSen > 0 ? costSen : null;
  } else {
    return c.json({ error: "prices_by_height_required" }, 400);
  }

  const sellingPrices = selling ?? prices;
  if (!Object.values(sellingPrices).some((v) => v !== null)) {
    return c.json({ error: "selling_prices_all_null", message: "At least one height needs a selling price" }, 400);
  }

  const effectiveFrom = (body.effectiveFrom ?? "").trim();
  if (!ISO_DATE.test(effectiveFrom)) return c.json({ error: "effective_from_required", message: "YYYY-MM-DD" }, 400);

  try {
    const inserted = await db
      .insert(sofaComboPricing)
      .values({
        baseModel,
        modules,
        tier,
        customerId,
        supplierId,
        pricesByHeight: prices,
        sellingPricesByHeight: sellingPrices,
        pwpPricesByHeight: pwpPrices ?? {},
        defaultFreeGifts: Array.isArray(body.defaultFreeGifts) ? parseDefaultFreeGifts(body.defaultFreeGifts) : [],
        label: body.label ?? null,
        effectiveFrom,
        notes: body.notes ?? null,
        createdBy: user.id,
      })
      .returning();
    return c.json(rowToWire(inserted[0]), 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── PUT /:id ─────────────────────────────────────────────────────────
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);

  let orig: RowDb | undefined;
  try {
    const origRows = await db.select().from(sofaComboPricing).where(eq(sofaComboPricing.id, id)).limit(1);
    orig = origRows[0];
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
  if (!orig) return c.json({ error: "not_found" }, 404);

  let body: {
    pricesByHeight?: unknown;
    sellingPricesByHeight?: unknown;
    pwpPricesByHeight?: unknown;
    defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
    label?: string | null;
    effectiveFrom?: string;
    notes?: string | null;
    supplierId?: string | null;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const prices = validatePricesByHeight(body.pricesByHeight);
  if (!prices) return c.json({ error: "prices_by_height_invalid" }, 400);

  const sellingPrices = body.sellingPricesByHeight === undefined ? prices : validatePricesByHeight(body.sellingPricesByHeight);
  if (!sellingPrices) return c.json({ error: "selling_prices_by_height_invalid" }, 400);

  const pwpPrices =
    body.pwpPricesByHeight === undefined
      ? ((orig.pwpPricesByHeight as Record<string, number | null>) ?? {})
      : validatePricesByHeight(body.pwpPricesByHeight);
  if (!pwpPrices) return c.json({ error: "pwp_prices_by_height_invalid" }, 400);

  const effectiveFrom = (body.effectiveFrom ?? "").trim();
  if (!ISO_DATE.test(effectiveFrom)) return c.json({ error: "effective_from_required", message: "YYYY-MM-DD" }, 400);

  const supplierId =
    body.supplierId === undefined ? orig.supplierId : body.supplierId === null || body.supplierId === "" ? null : body.supplierId;

  const user = c.get("user");
  try {
    const inserted = await db
      .insert(sofaComboPricing)
      .values({
        baseModel: orig.baseModel,
        modules: orig.modules,
        tier: orig.tier,
        customerId: orig.customerId,
        supplierId,
        pricesByHeight: prices,
        sellingPricesByHeight: sellingPrices,
        pwpPricesByHeight: pwpPrices,
        defaultFreeGifts: Array.isArray(body.defaultFreeGifts)
          ? parseDefaultFreeGifts(body.defaultFreeGifts)
          : (orig.defaultFreeGifts ?? []),
        label: body.label ?? null,
        effectiveFrom,
        notes: body.notes ?? null,
        createdBy: user.id,
      })
      .returning();
    return c.json(rowToWire(inserted[0]), 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    await db.update(sofaComboPricing).set({ deletedAt: new Date() }).where(eq(sofaComboPricing.id, id));
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
