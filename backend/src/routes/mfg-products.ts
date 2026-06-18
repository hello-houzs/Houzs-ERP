// ----------------------------------------------------------------------------
// /mfg-products — Manufacturer SKU master. 1:1 clone of 2990s
// apps/api/src/routes/mfg-products.ts (PostgREST -> Drizzle). Separate from
// /products (retail catalogue). Drives the Products & Maintenance page.
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4 — 2990s had an app-layer EDIT_ROLES/CREATE_ROLES gate via a staff-role
// lookup; collapsed to the module's owner-only mount, the role lookups dropped);
// changed_by -> users.id INTEGER soft-ref (c.get("user").id); camelCase Drizzle
// rows aliased to the snake_case wire keys 2990s returned (rule #7); the
// service-role admin client for activate-one-shot uses the same Drizzle handle.
//
// Endpoints:
//   GET   /mfg-products?category=&search=
//   POST  /mfg-products                       create
//   POST  /mfg-products/batch-import          bulk upsert by code
//   DELETE /mfg-products/:id?force=           delete (usage-locked; force wipes side tables)
//   GET   /mfg-products/:id                   detail + side-loaded dept config
//   PATCH /mfg-products/:id                   price/field edits + audit history
//   POST  /mfg-products/:id/activate-one-shot re-activate a one-shot SKU
//   GET   /mfg-products/:id/price-history     audit drawer
//   GET   /mfg-products/:id/suppliers         supplier bindings for this SKU
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, or, ilike } from "drizzle-orm";
import { moduleCodeFromSku, normalizeSofaTier, parseDefaultFreeGifts } from "@shared/index";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  mfgProducts,
  productModels as productModelsTable,
  productDeptConfigs,
  masterPriceHistory,
  supplierMaterialBindings,
  suppliers as suppliersTable,
  inventoryMovements,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { findSkuUsage } from "../lib/sku-usage";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

const VALID_CATEGORIES = new Set(["SOFA", "BEDFRAME", "ACCESSORY", "MATTRESS", "SERVICE"]);
type MfgCategory = "SOFA" | "BEDFRAME" | "ACCESSORY" | "MATTRESS" | "SERVICE";
const PRICE_FIELDS = new Set(["base_price_sen", "price1_sen", "cost_price_sen", "sell_price_sen", "pwp_price_sen"]);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}
function isFkViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23503");
}
// PostgREST .or() free-text escaper (inlined, single-slice scope — same as suppliers.ts).
function escapeForOr(search: string): string {
  return String(search ?? "").replace(/[,(){}]/g, "").trim();
}

// Drizzle row -> the snake_case wire shape the 2990s SKU Master list consumed.
function toListWire(r: typeof mfgProducts.$inferSelect & { allowed_options?: unknown }) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    description: r.description,
    base_model: r.baseModel,
    size_code: r.sizeCode,
    size_label: r.sizeLabel,
    base_price_sen: r.basePriceSen,
    price1_sen: r.price1Sen,
    sell_price_sen: r.sellPriceSen,
    pwp_price_sen: r.pwpPriceSen,
    unit_m3_milli: r.unitM3,
    status: r.status,
    pos_active: r.posActive,
    one_shot: r.oneShot,
    source_doc_no: r.sourceDocNo,
    included_addons: r.includedAddons,
    sku_code: r.skuCode,
    model_id: r.modelId,
    branding: r.branding,
    barcode: r.barcode,
    sub_assemblies: r.subAssemblies,
    pieces: r.pieces,
    seat_height_prices: r.seatHeightPrices,
    default_variants: r.defaultVariants,
    updated_at: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
    allowed_options: r.allowed_options ?? null,
  };
}

// ── GET / ────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const category = c.req.query("category");
  const search = c.req.query("search");
  const db = getDb(c.env);
  try {
    const conds = [eq(mfgProducts.status, "ACTIVE" as const)];
    if (category) conds.push(eq(mfgProducts.category, category as MfgCategory));
    if (search) {
      const s = escapeForOr(search);
      if (s) {
        const like = `%${s}%`;
        conds.push(
          or(
            ilike(mfgProducts.code, like),
            ilike(mfgProducts.name, like),
            ilike(mfgProducts.description, like),
            ilike(mfgProducts.barcode, like),
          )!,
        );
      }
    }
    // Embed the Model's allowed_options (2990s: model:product_models(allowed_options)).
    const rows = await db
      .select({
        p: mfgProducts,
        allowed_options: productModelsTable.allowedOptions,
      })
      .from(mfgProducts)
      .leftJoin(productModelsTable, eq(mfgProducts.modelId, productModelsTable.id))
      .where(and(...conds))
      .orderBy(asc(mfgProducts.code));

    const products = rows.map((r) => toListWire({ ...r.p, allowed_options: r.allowed_options }));
    return c.json({ products });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST / ───────────────────────────────────────────────────────────
app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const code = String(body.code ?? "").trim();
  const name = String(body.name ?? "").trim();
  const category = String(body.category ?? "").trim();
  if (!code) return c.json({ error: "code_required" }, 400);
  if (!name) return c.json({ error: "name_required" }, 400);
  if (!VALID_CATEGORIES.has(category)) return c.json({ error: "invalid_category", allowed: [...VALID_CATEGORIES] }, 400);

  const id = `mfg-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const row = {
    id,
    code,
    name,
    category: category as MfgCategory,
    status: "ACTIVE" as const,
    description: (body.description as string) ?? null,
    baseModel: (body.baseModel as string) ?? null,
    sizeCode: (body.sizeCode as string) ?? null,
    sizeLabel: (body.sizeLabel as string) ?? null,
    basePriceSen: body.basePriceSen == null ? null : Number(body.basePriceSen),
    price1Sen: body.price1Sen == null ? null : Number(body.price1Sen),
    costPriceSen: body.costPriceSen == null ? 0 : Number(body.costPriceSen),
    unitM3: body.unitM3Milli == null ? 0 : Number(body.unitM3Milli),
    branding: (body.branding as string) ?? null,
    barcode: typeof body.barcode === "string" && body.barcode.trim() ? body.barcode.trim() : null,
  };

  const db = getDb(c.env);
  try {
    const inserted = await db.insert(mfgProducts).values(row).returning({ id: mfgProducts.id, code: mfgProducts.code });
    return c.json(inserted[0], 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_code", reason: errMsg(e) }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /batch-import ───────────────────────────────────────────────
app.post("/batch-import", async (c) => {
  let body: { rows?: Array<Record<string, unknown>> };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const list = body.rows ?? [];
  if (list.length === 0) return c.json({ error: "rows_required" }, 400);
  if (list.length > 500) return c.json({ error: "too_many", message: "Max 500 rows per import" }, 400);

  const db = getDb(c.env);
  let upserted = 0;
  const failures: Array<{ code: string; reason: string }> = [];
  const hasVal = (v: unknown): boolean => v != null && v !== "";

  type SeatEntry = { height: string; priceSen: number; tier?: string };

  for (const r of list) {
    const code = String(r.code ?? "").trim();
    const name = String(r.name ?? "").trim();
    const category = String(r.category ?? "").trim();
    if (!code || !name || !VALID_CATEGORIES.has(category)) {
      failures.push({ code, reason: "missing code/name or invalid category" });
      continue;
    }
    const row: Record<string, unknown> = { code, name, category };
    if (hasVal(r.status)) row.status = String(r.status);
    if (hasVal(r.description)) row.description = String(r.description);
    if (hasVal(r.base_model)) row.baseModel = String(r.base_model);
    if (hasVal(r.size_label)) row.sizeLabel = String(r.size_label);
    if (hasVal(r.branding)) row.branding = String(r.branding);
    if (hasVal(r.base_price_sen)) row.basePriceSen = Number(r.base_price_sen);
    if (hasVal(r.price1_sen)) row.price1Sen = Number(r.price1_sen);
    if (hasVal(r.unit_m3_milli)) row.unitM3 = Number(r.unit_m3_milli);

    const seatRaw = (r.seatHeightPrices ?? r.seat_height_prices) as unknown;
    const rawSeat = (Array.isArray(seatRaw) ? seatRaw : []) as SeatEntry[];
    let badTier: string | null = null;
    const incomingSeat: SeatEntry[] = [];
    for (const e of rawSeat) {
      const t = e.tier == null || e.tier === "" ? "PRICE_2" : normalizeSofaTier(e.tier);
      if (!t) {
        badTier = String(e.tier);
        break;
      }
      incomingSeat.push({ ...e, tier: t });
    }
    if (badTier !== null) {
      failures.push({ code, reason: `price tier "${badTier}" not recognized — use P1, P2, or P3` });
      continue;
    }
    const tierOf = (e: SeatEntry) => e.tier ?? "PRICE_2";

    try {
      const existingRows = await db
        .select({ id: mfgProducts.id, seatHeightPrices: mfgProducts.seatHeightPrices })
        .from(mfgProducts)
        .where(eq(mfgProducts.code, code))
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        if (incomingSeat.length > 0) {
          const incomingTiers = new Set(incomingSeat.map(tierOf));
          const existingSeat = Array.isArray(existing.seatHeightPrices) ? (existing.seatHeightPrices as SeatEntry[]) : [];
          const kept = existingSeat.filter((e) => !incomingTiers.has(tierOf(e)));
          row.seatHeightPrices = [...kept, ...incomingSeat];
        }
        await db.update(mfgProducts).set(row).where(eq(mfgProducts.code, code));
      } else {
        if (incomingSeat.length > 0) row.seatHeightPrices = incomingSeat;
        const id = `mfg-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        await db.insert(mfgProducts).values({ ...row, id } as typeof mfgProducts.$inferInsert);
      }
      upserted += 1;
    } catch (e) {
      failures.push({ code, reason: errMsg(e) });
    }
  }

  return c.json({ upserted, failed: failures.length, failures: failures.slice(0, 50) });
});

// ── DELETE /:id ──────────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const force = c.req.query("force") === "true";
  const db = getDb(c.env);

  try {
    const rows = await db.select({ code: mfgProducts.code }).from(mfgProducts).where(eq(mfgProducts.id, id)).limit(1);
    if (!rows[0]) return c.json({ error: "not_found" }, 404);
    const code = rows[0].code;

    // Lock USED SKUs — never deletable, not even by force.
    const used = await findSkuUsage(db, code);
    if (used) {
      return c.json(
        {
          error: "sku_in_use",
          reason: `"${code}" is used in ${used.where}${used.doc ? ` (${used.doc})` : ""} and can't be deleted.`,
        },
        409,
      );
    }

    if (force) {
      // Wipe the inventory-movement + supplier-binding side rows keyed off code.
      // (2990s also cleared inventory_stock_lots; Houzs's FIFO lot table is keyed
      // off movements, which the trigger maintains — clearing movements suffices.)
      await db.delete(inventoryMovements).where(eq(inventoryMovements.productCode, code));
      await db.delete(supplierMaterialBindings).where(eq(supplierMaterialBindings.materialCode, code));
    }

    await db.delete(mfgProducts).where(eq(mfgProducts.id, id));
    return c.body(null, 204);
  } catch (e) {
    if (isFkViolation(e)) {
      return c.json(
        {
          error: "product_in_use",
          reason: "Product is referenced by an order / PO / GRN line; remove those first or use force delete.",
        },
        409,
      );
    }
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /:id ─────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    const rows = await db.select().from(mfgProducts).where(eq(mfgProducts.id, id)).limit(1);
    const data = rows[0];
    if (!data) return c.json({ error: "not_found" }, 404);

    const cfgRows = await db
      .select()
      .from(productDeptConfigs)
      .where(eq(productDeptConfigs.productCode, data.code))
      .limit(1);

    // Return the full SKU row (2990s did select('*')). Re-use the list mapper +
    // append the columns the list shape omits so callers see every field.
    return c.json({
      product: {
        ...toListWire(data),
        cost_price_sen: data.costPriceSen,
        fabric_usage_centi: data.fabricUsage,
        production_time_minutes: data.productionTimeMinutes,
        fabric_color: data.fabricColor,
        default_free_gifts: data.defaultFreeGifts,
        retail_product_id: data.retailProductId,
        created_at: data.createdAt instanceof Date ? data.createdAt.toISOString() : data.createdAt,
      },
      deptConfig: cfgRows[0] ?? null,
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /:id ───────────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: {
    basePriceSen?: number | null;
    price1Sen?: number | null;
    costPriceSen?: number | null;
    sellPriceSen?: number | null;
    pwpPriceSen?: number | null;
    notes?: string;
    defaultVariants?: unknown;
    subAssemblies?: unknown;
    pieces?: unknown;
    seatHeightPrices?: Array<{ height: string; priceSen: number; tier?: "PRICE_1" | "PRICE_2" | "PRICE_3"; sellingPriceSen?: number }>;
    branding?: string | null;
    status?: "ACTIVE" | "INACTIVE";
    posActive?: boolean;
    includedAddons?: Array<{ addonId: string; qty: number }>;
    defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
    code?: string;
    name?: string;
    barcode?: string | null;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const db = getDb(c.env);
  const user = c.get("user");

  try {
    const currentRows = await db
      .select({
        code: mfgProducts.code,
        base_price_sen: mfgProducts.basePriceSen,
        price1_sen: mfgProducts.price1Sen,
        cost_price_sen: mfgProducts.costPriceSen,
        sell_price_sen: mfgProducts.sellPriceSen,
        pwp_price_sen: mfgProducts.pwpPriceSen,
        seat_height_prices: mfgProducts.seatHeightPrices,
      })
      .from(mfgProducts)
      .where(eq(mfgProducts.id, id))
      .limit(1);
    const current = currentRows[0];
    if (!current) return c.json({ error: "not_found" }, 404);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const priceChanges: Array<{ field: string; oldValueSen: number | null; newValueSen: number | null }> = [];

    if (body.basePriceSen !== undefined && body.basePriceSen !== current.base_price_sen) {
      updates.basePriceSen = body.basePriceSen;
      priceChanges.push({ field: "base_price_sen", oldValueSen: current.base_price_sen, newValueSen: body.basePriceSen });
    }
    if (body.price1Sen !== undefined && body.price1Sen !== current.price1_sen) {
      updates.price1Sen = body.price1Sen;
      priceChanges.push({ field: "price1_sen", oldValueSen: current.price1_sen, newValueSen: body.price1Sen });
    }
    if (body.sellPriceSen !== undefined && body.sellPriceSen !== current.sell_price_sen) {
      updates.sellPriceSen = body.sellPriceSen;
      priceChanges.push({ field: "sell_price_sen", oldValueSen: current.sell_price_sen, newValueSen: body.sellPriceSen });
    }
    if (body.pwpPriceSen !== undefined && body.pwpPriceSen !== current.pwp_price_sen) {
      updates.pwpPriceSen = body.pwpPriceSen;
      priceChanges.push({ field: "pwp_price_sen", oldValueSen: current.pwp_price_sen, newValueSen: body.pwpPriceSen });
    }
    if (body.costPriceSen !== undefined && body.costPriceSen !== current.cost_price_sen) {
      updates.costPriceSen = body.costPriceSen;
      priceChanges.push({ field: "cost_price_sen", oldValueSen: current.cost_price_sen, newValueSen: body.costPriceSen });
    }
    if (body.defaultVariants !== undefined) updates.defaultVariants = body.defaultVariants;
    if (body.subAssemblies !== undefined) updates.subAssemblies = body.subAssemblies;
    if (body.pieces !== undefined) updates.pieces = body.pieces;
    if (body.branding !== undefined) {
      const trimmed = typeof body.branding === "string" ? body.branding.trim() : null;
      updates.branding = trimmed ? trimmed : null;
    }
    if (body.barcode !== undefined) {
      const trimmed = typeof body.barcode === "string" ? body.barcode.trim() : null;
      updates.barcode = trimmed ? trimmed : null;
    }
    if (body.status === "ACTIVE" || body.status === "INACTIVE") updates.status = body.status;
    if (typeof body.posActive === "boolean") updates.posActive = body.posActive;
    if (Array.isArray(body.includedAddons)) updates.includedAddons = body.includedAddons;
    if (Array.isArray(body.defaultFreeGifts)) updates.defaultFreeGifts = parseDefaultFreeGifts(body.defaultFreeGifts);
    if (body.code !== undefined) {
      const trimmed = typeof body.code === "string" ? body.code.trim() : "";
      if (!trimmed) return c.json({ error: "code_required" }, 400);
      updates.code = trimmed;
    }
    if (body.name !== undefined) {
      const trimmed = typeof body.name === "string" ? body.name.trim() : "";
      if (!trimmed) return c.json({ error: "name_required" }, 400);
      updates.name = trimmed;
    }

    if (Array.isArray(body.seatHeightPrices)) {
      type Slot = { height: string; priceSen: number; tier?: "PRICE_1" | "PRICE_2" | "PRICE_3"; sellingPriceSen?: number };
      for (const s of body.seatHeightPrices) {
        if (s.sellingPriceSen != null && (!Number.isInteger(s.sellingPriceSen) || s.sellingPriceSen < 0)) {
          return c.json({ error: "invalid_selling_price" }, 400);
        }
      }
      updates.seatHeightPrices = body.seatHeightPrices;

      const oldArr = Array.isArray(current.seat_height_prices) ? (current.seat_height_prices as Slot[]) : [];
      const newArr = body.seatHeightPrices;
      const keyOf = (s: Slot) => `${s.height}|${s.tier ?? "PRICE_2"}`;
      const oldMap = new Map(oldArr.map((s) => [keyOf(s), s.priceSen] as const));
      const newMap = new Map(newArr.map((s) => [keyOf(s), s.priceSen] as const));
      for (const k of new Set([...oldMap.keys(), ...newMap.keys()])) {
        const oldVal = oldMap.get(k) ?? null;
        const newVal = newMap.get(k) ?? null;
        if (oldVal !== newVal) priceChanges.push({ field: `seat_height:${k}`, oldValueSen: oldVal, newValueSen: newVal });
      }
      const oldSellMap = new Map(oldArr.map((s) => [keyOf(s), s.sellingPriceSen ?? null] as const));
      const newSellMap = new Map(newArr.map((s) => [keyOf(s), s.sellingPriceSen ?? null] as const));
      for (const k of new Set([...oldSellMap.keys(), ...newSellMap.keys()])) {
        const oldVal = oldSellMap.get(k) ?? null;
        const newVal = newSellMap.get(k) ?? null;
        if (oldVal !== newVal) priceChanges.push({ field: `seat_height_selling:${k}`, oldValueSen: oldVal, newValueSen: newVal });
      }
    }

    if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

    try {
      await db.update(mfgProducts).set(updates).where(eq(mfgProducts.id, id));
    } catch (e) {
      if (isUniqueViolation(e)) return c.json({ error: "duplicate_code", reason: "Another SKU already uses that code." }, 409);
      return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
    }

    // Audit trail (best-effort).
    for (const ch of priceChanges) {
      if (!PRICE_FIELDS.has(ch.field) && !ch.field.startsWith("seat_height")) continue;
      try {
        await db.insert(masterPriceHistory).values({
          productCode: current.code,
          field: ch.field,
          oldValueSen: ch.oldValueSen,
          newValueSen: ch.newValueSen,
          reason: body.notes ?? null,
          changedBy: user.id,
        });
      } catch {
        /* best-effort audit — price already committed */
      }
    }

    return c.json({ ok: true, changed: priceChanges.length });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /:id/activate-one-shot ──────────────────────────────────────
app.post("/:id/activate-one-shot", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    const skuRows = await db
      .select({
        id: mfgProducts.id,
        code: mfgProducts.code,
        category: mfgProducts.category,
        baseModel: mfgProducts.baseModel,
        modelId: mfgProducts.modelId,
        oneShot: mfgProducts.oneShot,
      })
      .from(mfgProducts)
      .where(eq(mfgProducts.id, id))
      .limit(1);
    const sku = skuRows[0];
    if (!sku || !sku.oneShot) return c.json({ error: "not_one_shot" }, 400);

    await db.update(mfgProducts).set({ posActive: true }).where(eq(mfgProducts.id, id));

    if (sku.category === "SOFA" && sku.modelId) {
      const moduleCode = moduleCodeFromSku(sku.code, sku.baseModel);
      const modelRows = await db
        .select({ allowedOptions: productModelsTable.allowedOptions })
        .from(productModelsTable)
        .where(eq(productModelsTable.id, sku.modelId))
        .limit(1);
      const opts = (modelRows[0]?.allowedOptions as Record<string, unknown> | undefined) ?? {};
      const comps = Array.isArray((opts as { compartments?: unknown }).compartments)
        ? ((opts as { compartments: unknown[] }).compartments).map(String)
        : [];
      if (!comps.includes(moduleCode)) {
        const next = { ...opts, compartments: [...comps, moduleCode] };
        await db.update(productModelsTable).set({ allowedOptions: next }).where(eq(productModelsTable.id, sku.modelId));
      }
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "activate_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /:id/price-history ───────────────────────────────────────────
app.get("/:id/price-history", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    const prodRows = await db.select({ code: mfgProducts.code }).from(mfgProducts).where(eq(mfgProducts.id, id)).limit(1);
    if (!prodRows[0]) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select({
        id: masterPriceHistory.id,
        product_code: masterPriceHistory.productCode,
        field: masterPriceHistory.field,
        old_value_sen: masterPriceHistory.oldValueSen,
        new_value_sen: masterPriceHistory.newValueSen,
        reason: masterPriceHistory.reason,
        changed_at: masterPriceHistory.changedAt,
        changed_by: masterPriceHistory.changedBy,
      })
      .from(masterPriceHistory)
      .where(eq(masterPriceHistory.productCode, prodRows[0].code))
      .orderBy(desc(masterPriceHistory.changedAt));
    return c.json({ history: rows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /:id/suppliers ───────────────────────────────────────────────
app.get("/:id/suppliers", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    const prodRows = await db
      .select({ code: mfgProducts.code, name: mfgProducts.name, category: mfgProducts.category })
      .from(mfgProducts)
      .where(eq(mfgProducts.id, id))
      .limit(1);
    if (!prodRows[0]) return c.json({ error: "not_found" }, 404);
    const product = prodRows[0];

    const rows = await db
      .select({
        id: supplierMaterialBindings.id,
        supplier_id: supplierMaterialBindings.supplierId,
        supplier_sku: supplierMaterialBindings.supplierSku,
        unit_price_centi: supplierMaterialBindings.unitPriceCenti,
        currency: supplierMaterialBindings.currency,
        lead_time_days: supplierMaterialBindings.leadTimeDays,
        moq: supplierMaterialBindings.moq,
        is_main_supplier: supplierMaterialBindings.isMainSupplier,
        notes: supplierMaterialBindings.notes,
        s_code: suppliersTable.code,
        s_name: suppliersTable.name,
        s_phone: suppliersTable.phone,
      })
      .from(supplierMaterialBindings)
      .leftJoin(suppliersTable, eq(supplierMaterialBindings.supplierId, suppliersTable.id))
      .where(eq(supplierMaterialBindings.materialCode, product.code))
      .orderBy(desc(supplierMaterialBindings.isMainSupplier), asc(supplierMaterialBindings.unitPriceCenti));

    const sup = rows.map((r) => ({
      id: r.id,
      supplier_id: r.supplier_id,
      supplier_sku: r.supplier_sku,
      unit_price_centi: r.unit_price_centi,
      currency: r.currency,
      lead_time_days: r.lead_time_days,
      moq: r.moq,
      is_main_supplier: r.is_main_supplier,
      notes: r.notes,
      suppliers: r.s_code ? { code: r.s_code, name: r.s_name, phone: r.s_phone } : null,
    }));
    return c.json({ product, suppliers: sup });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
