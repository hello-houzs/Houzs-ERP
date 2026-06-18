// ----------------------------------------------------------------------------
// Product Models — second-layer template entity (PR #49). 1:1 clone of 2990s
// apps/api/src/routes/product-models.ts (PostgREST -> Drizzle).
//
// Every SKU on mfg_products belongs to a Model (e.g. 5530, 1003). The Model owns
// the allowed-options pool the SO/PO line picker + the auto-SKU-generator read.
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4 — 2990s mounted this open-GET with no per-route role gate; collapsed to the
// module's owner-only mount); camelCase Drizzle rows -> snake_case wire shape
// is NOT applied here — 2990s already returns snake_case column SELECTs, so the
// Drizzle rows are explicitly aliased to the same snake_case keys.
//
// DROPPED vs 2990s (out of slice scope, documented):
//   - R2 photo proxy + upload/delete (SO_ITEM_PHOTOS bucket not wired) -> the
//     photo endpoints return 501 not_configured; photo_url stays a passthrough.
//   - generate-skus reads the Maintenance sizeLabels override from the cloned
//     maintenance_config_history (canonical name) instead of the 2990s route's
//     buggy `maintenance_config` ref; same best-effort fallback to static SIZE_INFO.
//
// Endpoints:
//   GET    /product-models               list (?category= filter)
//   GET    /product-models/:id           detail + side-loaded SKU rows
//   POST   /product-models               create
//   PATCH  /product-models/:id           update + sofa auto-SKU + size mirror
//   POST   /product-models/:id/generate-skus   bulk SKU materialise
//   DELETE /product-models/:id           hard delete (usage-guarded)
//   GET/POST/DELETE /product-models/:id/photo*  501 (R2 not wired)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  productModels as productModelsTable,
  mfgProducts,
  maintenanceConfigHistory,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { findModelUsage } from "../lib/sku-usage";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

type MfgCategory = "SOFA" | "BEDFRAME" | "MATTRESS" | "ACCESSORY" | "SERVICE";
const CATEGORIES = ["SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY", "SERVICE"] as const;

const CreateBody = z.object({
  branding: z.string().trim().max(80).optional().nullable(),
  modelCode: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES),
  description: z.string().trim().max(500).optional().nullable(),
  photoUrl: z.string().trim().url().optional().nullable(),
  allowedOptions: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
});

const PatchBody = z.object({
  branding: z.string().trim().max(80).nullable().optional(),
  modelCode: z.string().trim().min(1).max(32).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  photoUrl: z.string().trim().url().nullable().optional(),
  allowedOptions: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
});

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}

// Map a Drizzle product_models row to the snake_case wire shape (the COLS select
// 2990s used: id, branding, model_code, name, category, description, photo_url,
// allowed_options, active, created_at, updated_at).
type ModelRowDb = typeof productModelsTable.$inferSelect;
function toModelWire(r: ModelRowDb) {
  return {
    id: r.id,
    branding: r.branding,
    model_code: r.modelCode,
    name: r.name,
    category: r.category,
    description: r.description,
    photo_url: r.photoUrl,
    allowed_options: r.allowedOptions,
    active: r.active,
    created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updated_at: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

// ── GET / ────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const category = c.req.query("category");
  try {
    const conds = [];
    if (category && (CATEGORIES as readonly string[]).includes(category)) {
      conds.push(eq(productModelsTable.category, category as MfgCategory));
    }
    const rows = await db
      .select()
      .from(productModelsTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(productModelsTable.category), asc(productModelsTable.modelCode));
    return c.json({ models: rows.map(toModelWire) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /:id ─────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    const modelRows = await db.select().from(productModelsTable).where(eq(productModelsTable.id, id)).limit(1);
    const model = modelRows[0];
    if (!model) return c.json({ error: "not_found" }, 404);

    const skus = await db
      .select({
        id: mfgProducts.id,
        code: mfgProducts.code,
        name: mfgProducts.name,
        size_code: mfgProducts.sizeCode,
        size_label: mfgProducts.sizeLabel,
        status: mfgProducts.status,
        base_price_sen: mfgProducts.basePriceSen,
        price1_sen: mfgProducts.price1Sen,
        cost_price_sen: mfgProducts.costPriceSen,
        unit_m3_milli: mfgProducts.unitM3,
        pos_active: mfgProducts.posActive,
        one_shot: mfgProducts.oneShot,
        source_doc_no: mfgProducts.sourceDocNo,
      })
      .from(mfgProducts)
      .where(eq(mfgProducts.modelId, id))
      .orderBy(asc(mfgProducts.code))
      .limit(200);

    return c.json({ model: toModelWire(model), skus });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST / ───────────────────────────────────────────────────────────
app.post("/", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);

  const db = getDb(c.env);
  try {
    const inserted = await db
      .insert(productModelsTable)
      .values({
        branding: parsed.data.branding ?? null,
        modelCode: parsed.data.modelCode,
        name: parsed.data.name,
        category: parsed.data.category,
        description: parsed.data.description ?? null,
        photoUrl: parsed.data.photoUrl ?? null,
        allowedOptions: parsed.data.allowedOptions ?? {},
        active: parsed.data.active ?? true,
      })
      .returning();
    return c.json({ model: toModelWire(inserted[0]) }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_code", reason: errMsg(e) }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /:id ───────────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);

  const u: Record<string, unknown> = {};
  if (parsed.data.branding !== undefined) u.branding = parsed.data.branding;
  if (parsed.data.modelCode !== undefined) u.modelCode = parsed.data.modelCode;
  if (parsed.data.name !== undefined) u.name = parsed.data.name;
  if (parsed.data.description !== undefined) u.description = parsed.data.description;
  if (parsed.data.photoUrl !== undefined) u.photoUrl = parsed.data.photoUrl;
  if (parsed.data.allowedOptions !== undefined) u.allowedOptions = parsed.data.allowedOptions;
  if (parsed.data.active !== undefined) u.active = parsed.data.active;
  if (Object.keys(u).length === 0) return c.json({ error: "empty_patch" }, 400);

  const db = getDb(c.env);
  try {
    // Snapshot pre-update compartments for the sofa auto-SKU diff below.
    const beforeRows = await db
      .select({ allowedOptions: productModelsTable.allowedOptions })
      .from(productModelsTable)
      .where(eq(productModelsTable.id, id))
      .limit(1);
    const before = beforeRows[0];

    const updatedRows = await db.update(productModelsTable).set(u).where(eq(productModelsTable.id, id)).returning();
    const data = updatedRows[0];
    if (!data) return c.json({ error: "not_found" }, 404);

    const cat = data.category;

    // MATTRESS / BEDFRAME: mirror allowed_options.sizes onto each SKU's pos_active.
    const aoSizes = (parsed.data.allowedOptions as { sizes?: unknown } | undefined)?.sizes;
    if ((cat === "MATTRESS" || cat === "BEDFRAME") && Array.isArray(aoSizes) && aoSizes.length > 0) {
      const allowedSet = new Set((aoSizes as unknown[]).map((s) => String(s).toUpperCase()));
      const skuRows = await db
        .select({ id: mfgProducts.id, sizeCode: mfgProducts.sizeCode, posActive: mfgProducts.posActive })
        .from(mfgProducts)
        .where(eq(mfgProducts.modelId, id));
      const toOn: string[] = [];
      const toOff: string[] = [];
      for (const s of skuRows) {
        const inAllowed = allowedSet.has((s.sizeCode ?? "").toUpperCase());
        if (inAllowed && s.posActive === false) toOn.push(s.id);
        else if (!inAllowed && s.posActive !== false) toOff.push(s.id);
      }
      if (toOn.length) await db.update(mfgProducts).set({ posActive: true }).where(inArray(mfgProducts.id, toOn));
      if (toOff.length) await db.update(mfgProducts).set({ posActive: false }).where(inArray(mfgProducts.id, toOff));
    }

    // SOFA: activating a compartment auto-creates its SKU when missing.
    const autoCreatedSkus: string[] = [];
    if (cat === "SOFA" && parsed.data.allowedOptions !== undefined) {
      const oldComps = new Set(
        Array.isArray((before?.allowedOptions as { compartments?: unknown } | null)?.compartments)
          ? ((before!.allowedOptions as { compartments: unknown[] }).compartments).map((x) => String(x))
          : [],
      );
      const newComps = Array.isArray((parsed.data.allowedOptions as { compartments?: unknown }).compartments)
        ? ((parsed.data.allowedOptions as { compartments: unknown[] }).compartments).map((x) => String(x))
        : [];
      const added = [...new Set(newComps)].filter((comp) => comp && !oldComps.has(comp));
      if (added.length > 0) {
        const modelCode = String(data.modelCode ?? "");
        const codePrefix = modelCode.toUpperCase();
        const modelName = String(data.name ?? "").trim();
        const branding = String(data.branding ?? "").trim();
        const namePrefix = (branding ? `${branding} ` : "").toUpperCase();
        const upperName = (modelName || modelCode).toUpperCase();
        const wantCodes = added.map((comp) => `${codePrefix}-${comp}`);
        const existing = await db
          .select({ code: mfgProducts.code })
          .from(mfgProducts)
          .where(inArray(mfgProducts.code, wantCodes));
        const have = new Set(existing.map((r) => r.code));
        const rows = added
          .filter((comp) => !have.has(`${codePrefix}-${comp}`))
          .map((comp) => ({
            id: `mfg-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
            code: `${codePrefix}-${comp}`,
            name: `${namePrefix}SOFA ${upperName} ${comp}`.trim(),
            category: "SOFA" as MfgCategory,
            baseModel: modelCode,
            modelId: id,
            branding: branding || null,
            status: "ACTIVE" as const,
          }));
        if (rows.length > 0) {
          try {
            await db.insert(mfgProducts).values(rows);
            autoCreatedSkus.push(...rows.map((r) => r.code));
          } catch (e) {
            // 23505 = a concurrent create already made it — idempotent success.
            if (isUniqueViolation(e)) autoCreatedSkus.push(...rows.map((r) => r.code));
          }
        }
      }
    }

    return c.json({ model: toModelWire(data), autoCreatedSkus });
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_code", reason: errMsg(e) }, 409);
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /:id/generate-skus ──────────────────────────────────────────
const SIZE_INFO: Record<string, { label: string; dim: string; w: number; l: number }> = {
  K: { label: "6FT", dim: "183X190CM", w: 183, l: 190 },
  Q: { label: "5FT", dim: "152X190CM", w: 152, l: 190 },
  S: { label: "3FT", dim: "90X190CM", w: 90, l: 190 },
  SS: { label: "3.5FT", dim: "107X190CM", w: 107, l: 190 },
  SK: { label: "200X200CM", dim: "", w: 200, l: 200 },
  SP: { label: "220X220CM", dim: "", w: 220, l: 220 },
};

function resolveSizeInfoServer(
  code: string,
  overrides?: Record<string, { label?: string; dimensions?: string } | undefined> | null,
): { label: string; dim: string; w: number; l: number } {
  const o = overrides?.[code];
  const base = SIZE_INFO[code];
  const label = o?.label?.trim() || base?.label || code;
  const dim = o?.dimensions?.trim() || base?.dim || "";
  let w = base?.w ?? 0;
  let l = base?.l ?? 0;
  if (o?.dimensions) {
    const m = o.dimensions.trim().match(/^(\d+)\s*[xX×]\s*(\d+)/);
    if (m && m[1] && m[2]) {
      w = parseInt(m[1], 10);
      l = parseInt(m[2], 10);
    }
  }
  return { label, dim, w, l };
}

app.post("/:id/generate-skus", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);

  let body: {
    rows?: Array<{ code: string; name: string; size_code?: string | null; size_label?: string | null }>;
    codes?: string[];
  } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch {
    /* allow empty body */
  }
  const explicitRows = Array.isArray(body.rows) && body.rows.length > 0 ? body.rows : null;
  const filterCodes = Array.isArray(body.codes) && body.codes.length > 0 ? new Set(body.codes) : null;

  let model: {
    id: string;
    branding: string | null;
    modelCode: string;
    name: string;
    category: MfgCategory;
    allowedOptions: unknown;
  };
  try {
    const modelRows = await db
      .select({
        id: productModelsTable.id,
        branding: productModelsTable.branding,
        modelCode: productModelsTable.modelCode,
        name: productModelsTable.name,
        category: productModelsTable.category,
        allowedOptions: productModelsTable.allowedOptions,
      })
      .from(productModelsTable)
      .where(eq(productModelsTable.id, id))
      .limit(1);
    if (!modelRows[0]) return c.json({ error: "not_found" }, 404);
    model = modelRows[0] as typeof model;
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }

  // Maintenance sizeLabels override (best-effort; falls back to static SIZE_INFO).
  // SEAM: reads the cloned maintenance_config_history (canonical name).
  let sizeOverrides: Record<string, { label?: string; dimensions?: string }> | null = null;
  try {
    const cfgRows = await db
      .select({ config: maintenanceConfigHistory.config })
      .from(maintenanceConfigHistory)
      .where(
        and(
          eq(maintenanceConfigHistory.scope, "master"),
          lte(maintenanceConfigHistory.effectiveFrom, new Date().toISOString().slice(0, 10)),
        ),
      )
      .orderBy(desc(maintenanceConfigHistory.effectiveFrom))
      .limit(1);
    const blob = cfgRows[0]?.config as { sizeLabels?: typeof sizeOverrides } | undefined;
    if (blob?.sizeLabels && typeof blob.sizeLabels === "object") sizeOverrides = blob.sizeLabels;
  } catch {
    /* swallow — generator stays functional with static SIZE_INFO */
  }

  const opts = (model.allowedOptions ?? {}) as Record<string, unknown>;
  const modelName = (model.name ?? "").trim();
  const sizesArr = Array.isArray(opts.sizes) ? (opts.sizes as string[]) : [];
  const compsArr = Array.isArray(opts.compartments) ? (opts.compartments as string[]) : [];
  const mattressThickness = typeof opts.mattress_thickness_cm === "number" ? opts.mattress_thickness_cm : null;

  type GenRow = { code: string; name: string; size_code: string | null; size_label: string | null };
  const wanted: GenRow[] = [];

  if (explicitRows) {
    for (const r of explicitRows) {
      if (!r?.code || !r?.name) continue;
      wanted.push({ code: String(r.code), name: String(r.name), size_code: r.size_code ?? null, size_label: r.size_label ?? null });
    }
  } else if (model.category === "SOFA") {
    if (compsArr.length === 0) {
      return c.json({ error: "no_compartments", reason: "Allowed Options -> Compartments is empty. Toggle at least one before generating." }, 400);
    }
    const branding = (model.branding ?? "").trim();
    const prefix = branding ? `${branding} ` : "";
    for (const comp of compsArr) {
      wanted.push({ code: `${model.modelCode}-${comp}`, name: `${prefix}SOFA ${modelName} ${comp}`.trim(), size_code: null, size_label: null });
    }
  } else if (model.category === "BEDFRAME") {
    if (sizesArr.length === 0) {
      return c.json({ error: "no_sizes", reason: "Allowed Options -> Sizes is empty. Toggle at least one before generating." }, 400);
    }
    const branding = (model.branding ?? "").trim();
    const prefix = branding ? `${branding} ` : "";
    const namePrefix = modelName ? `${prefix}${modelName} ` : prefix;
    for (const sz of sizesArr) {
      const info = resolveSizeInfoServer(sz, sizeOverrides);
      const namePart = info.dim ? `${namePrefix}BEDFRAME (${info.label}) (${info.dim})` : `${namePrefix}BEDFRAME (${info.label})`;
      wanted.push({ code: `${model.modelCode}-(${sz})`, name: namePart.trim(), size_code: sz, size_label: info.label });
    }
  } else if (model.category === "MATTRESS") {
    if (sizesArr.length === 0) {
      return c.json({ error: "no_sizes", reason: "Allowed Options -> Sizes is empty. Toggle at least one before generating." }, 400);
    }
    const branding = (model.branding ?? "").trim();
    const prefix = branding ? `${branding} ` : "";
    for (const sz of sizesArr) {
      const info = resolveSizeInfoServer(sz, sizeOverrides);
      let dimPart: string;
      if (info.w && info.l && mattressThickness != null) dimPart = `${info.w}x${info.l}x${mattressThickness}CM`;
      else if (info.dim) dimPart = info.dim.toLowerCase();
      else dimPart = info.label;
      wanted.push({
        code: `${branding ? branding + " " : ""}${model.modelCode} MATT (${sz})`,
        name: `${prefix}${modelName} MATTRESS (${dimPart})`.trim(),
        size_code: sz,
        size_label: info.label,
      });
    }
  } else if (model.category === "ACCESSORY" || model.category === "SERVICE") {
    const branding = (model.branding ?? "").trim();
    const prefix = branding ? `${branding} ` : "";
    wanted.push({
      code: model.modelCode,
      name: (modelName ? `${prefix}${modelName}` : `${prefix}${model.modelCode}`).trim(),
      size_code: null,
      size_label: null,
    });
  } else {
    return c.json({ error: "unsupported_category", reason: `Auto-generate not supported for ${model.category}.` }, 400);
  }

  // UPPERCASE every code + name + size_label (2990s PR #85).
  for (const w of wanted) {
    w.code = w.code.toUpperCase();
    w.name = w.name.toUpperCase();
    if (w.size_label) w.size_label = w.size_label.toUpperCase();
  }

  const filterCodesUpper = filterCodes ? new Set(Array.from(filterCodes).map((x) => x.toUpperCase())) : null;
  const wantedFiltered = filterCodesUpper ? wanted.filter((w) => filterCodesUpper.has(w.code)) : wanted;

  const codes = wantedFiltered.map((w) => w.code);
  let existingSet = new Set<string>();
  try {
    if (codes.length) {
      const existing = await db.select({ code: mfgProducts.code }).from(mfgProducts).where(inArray(mfgProducts.code, codes));
      existingSet = new Set(existing.map((r) => r.code));
    }
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }

  const toInsert = wantedFiltered.filter((w) => !existingSet.has(w.code));
  if (toInsert.length === 0) {
    return c.json({ generated: 0, skipped: wanted.length, reason: "All variant codes already exist — nothing to insert." });
  }

  const rows = toInsert.map((w) => ({
    id: `mfg-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    code: w.code,
    name: w.name,
    category: model.category,
    baseModel: model.modelCode,
    sizeCode: w.size_code,
    sizeLabel: w.size_label,
    branding: model.branding ?? null,
    modelId: model.id,
    status: "ACTIVE" as const,
  }));

  try {
    await db.insert(mfgProducts).values(rows);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
  return c.json({ generated: rows.length, skipped: existingSet.size, codes: rows.map((r) => r.code) });
});

// ── DELETE /:id ──────────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    const used = await findModelUsage(db, id);
    if (used) {
      return c.json(
        {
          error: "model_in_use",
          reason: `SKU "${used.code}" under this model is used in ${used.where}${used.doc ? ` (${used.doc})` : ""} — it can't be deleted.`,
        },
        409,
      );
    }
    await db.delete(productModelsTable).where(eq(productModelsTable.id, id));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Photo (R2) — not wired this slice ─────────────────────────────────
// 2990s stored Model hero photos in the SO_ITEM_PHOTOS R2 bucket + served them
// via an auth-validated proxy. Houzs has no such binding wired in this slice —
// return 501 so the UI shows a clear not-configured state. (TODO: wire R2.)
app.get("/:id/photo/:key", (c) =>
  c.json({ error: "photo_bucket_not_configured" }, 501),
);
app.post("/:id/photo", (c) =>
  c.json({ error: "photo_bucket_not_configured", reason: "SO_ITEM_PHOTOS R2 bucket not wired in this slice." }, 501),
);
app.delete("/:id/photo", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    await db.update(productModelsTable).set({ photoUrl: null }).where(eq(productModelsTable.id, id));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "db_update_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
