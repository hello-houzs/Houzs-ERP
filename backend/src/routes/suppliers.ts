// ----------------------------------------------------------------------------
// /suppliers — full master + supplier_material_bindings management.
//
// 1:1 clone of 2990s apps/api/src/routes/suppliers.ts. Endpoints, request
// bodies, response shapes, validation and business rules (main-supplier
// demotion, batch de-dupe) are kept identical to 2990s. Only the SEAMS change:
//   - DB client: 2990s per-request createClient(databaseUrl) -> Houzs getDb (rule #3)
//   - Query layer: 2990s Supabase PostgREST chains -> Drizzle against the
//     cloned schema (same JSON shapes in/out) (rule #3 + #7)
//   - Auth: 2990s Supabase-JWT/RLS -> Houzs requirePermission("*") (rule #4)
//
// Product-layer note (Houzs has no furniture catalogue yet): 2990s validated
// the per-category price_matrix against mfg_products.category. Houzs has no
// mfg_products, so price_matrix is stored as a passthrough JSONB (no shape
// validation) for now. unit_price_centi remains the simple price field.
//   TODO: wire price_matrix validation to Houzs product source in the Products slice.
// The scorecard reads purchase_orders / grns, which land in the PO/GRN slices;
// until then it returns the faithful zero shape so the detail page renders.
//   TODO: wire scorecard to Houzs PO/GRN once those slices land.
//
// Endpoints:
//   GET   /suppliers
//   GET   /suppliers/:id                       — supplier + all bindings
//   POST  /suppliers                           — create
//   PATCH /suppliers/:id                       — update
//
//   GET   /suppliers/:id/bindings              — list bindings for a supplier
//   POST  /suppliers/:id/bindings              — add binding
//   POST  /suppliers/:id/bindings/batch        — batch add bindings
//   PATCH /suppliers/:id/bindings/:bindingId   — update binding
//   DELETE /suppliers/:id/bindings/:bindingId  — remove binding
//
//   GET   /suppliers/:id/scorecard             — KPI tiles + last 10 POs
//   GET   /suppliers/material/:kind/:code      — find suppliers for a material
//                                                 (?mainOnly=true for primary)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, ilike, ne, or } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { suppliers as suppliersTable, supplierMaterialBindings } from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

// Owner-only for now (rule #4). Gate every route in this module.
app.use("*", requirePermission("*"));

const SUPPLIER_STATUSES = new Set(["ACTIVE", "INACTIVE", "BLOCKED"]);
const CURRENCIES = new Set(["MYR", "RMB", "USD", "SGD"]);
const MATERIAL_KINDS = new Set(["mfg_product", "fabric", "raw"]);

const STATEMENT_TYPES = new Set(["OPEN_ITEM", "BALANCE_FORWARD", "NO_STATEMENT"]);
const AGING_BASES = new Set(["INVOICE_DATE", "DUE_DATE"]);

/* PostgREST .or() free-text escaper from 2990s lib/postgrest-search.ts — kept
   so a parenthesised code (e.g. a sofa SKU 'BOOQIT-1A(LHF)') can't break the
   search. Inlined here (single-slice scope); the chars are also harmless to an
   ilike. */
function escapeForOr(search: string): string {
  return String(search ?? "").replace(/[,(){}]/g, "").trim();
}

// ── List suppliers ────────────────────────────────────────────────────
app.get("/", async (c) => {
  const status = c.req.query("status");
  const search = c.req.query("search");
  const db = getDb(c.env);

  // 2990s queried the suppliers_with_derived_category view (auto-derived
  // Category from assigned SKUs). Houzs has no mfg_products yet, so we read the
  // base suppliers table; derived_category is omitted from the response (the
  // frontend treats it as optional). Same row shape otherwise.
  const conds = [];
  if (status && SUPPLIER_STATUSES.has(status)) {
    conds.push(eq(suppliersTable.status, status as "ACTIVE" | "INACTIVE" | "BLOCKED"));
  }
  if (search) {
    const s = escapeForOr(search);
    if (s) {
      const like = `%${s}%`;
      conds.push(
        or(
          ilike(suppliersTable.code, like),
          ilike(suppliersTable.name, like),
          ilike(suppliersTable.contactPerson, like),
        ),
      );
    }
  }

  try {
    const rows = await db
      .select()
      .from(suppliersTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(suppliersTable.name));
    return c.json({ suppliers: rows.map(toSupplierResponse) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Supplier detail (+ bindings) ──────────────────────────────────────
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);

  try {
    const [supplierRows, bindingRows] = await Promise.all([
      db.select().from(suppliersTable).where(eq(suppliersTable.id, id)).limit(1),
      db
        .select()
        .from(supplierMaterialBindings)
        .where(eq(supplierMaterialBindings.supplierId, id))
        .orderBy(asc(supplierMaterialBindings.materialCode)),
    ]);
    const supplier = supplierRows[0];
    if (!supplier) return c.json({ error: "not_found" }, 404);
    return c.json({
      supplier: toSupplierResponse(supplier),
      bindings: bindingRows.map(toBindingResponse),
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Create supplier ──────────────────────────────────────────────────
app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const code = (body.code as string | undefined)?.trim();
  const name = (body.name as string | undefined)?.trim();
  if (!code) return c.json({ error: "code_required" }, 400);
  if (!name) return c.json({ error: "name_required" }, 400);

  // 2990s normalised phone-like fields to E.164 (normPhone) on the server.
  // Houzs has no phone lib in this slice — store the trimmed value as-is.
  const row = {
    code,
    name,
    whatsappNumber: (body.whatsappNumber as string) ?? null,
    email: (body.email as string) ?? null,
    contactPerson: (body.contactPerson as string) ?? null,
    phone: (body.phone as string) ?? null,
    address: (body.address as string) ?? null,
    state: (body.state as string) ?? null,
    paymentTerms: (body.paymentTerms as string) ?? null,
    status: (SUPPLIER_STATUSES.has(body.status as string) ? body.status : "ACTIVE") as
      | "ACTIVE"
      | "INACTIVE"
      | "BLOCKED",
    rating: typeof body.rating === "number" ? body.rating : 0,
    notes: (body.notes as string) ?? null,
    /* PR #40 — full master record */
    supplierType: (body.supplierType as string) ?? null,
    category: (body.category as string) ?? null,
    /* PR #47 — country (defaults Malaysia at DB level) */
    country: (body.country as string) ?? "Malaysia",
    tinNumber: (body.tinNumber as string) ?? null,
    businessRegNo: (body.businessRegNo as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    area: (body.area as string) ?? null,
    mobile: (body.mobile as string) ?? null,
    fax: (body.fax as string) ?? null,
    website: (body.website as string) ?? null,
    attention: (body.attention as string) ?? null,
    businessNature: (body.businessNature as string) ?? null,
    currency: CURRENCIES.has(body.currency as string) ? (body.currency as string) : "MYR",
    statementType: STATEMENT_TYPES.has(body.statementType as string)
      ? (body.statementType as string)
      : "OPEN_ITEM",
    agingBasis: AGING_BASES.has(body.agingBasis as string)
      ? (body.agingBasis as string)
      : "INVOICE_DATE",
    creditLimitSen: typeof body.creditLimitSen === "number" ? body.creditLimitSen : 0,
  };

  const db = getDb(c.env);
  try {
    const inserted = await db.insert(suppliersTable).values(row).returning();
    return c.json({ supplier: toSupplierResponse(inserted[0]) }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_code" }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── Update supplier ─────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  // [bodyKey, drizzleColumnKey]. Mirrors 2990s's [from,to] map (to is the
  // camelCase Drizzle key here, not the snake_case column string).
  const map: Array<[string, string]> = [
    ["code", "code"],
    ["name", "name"],
    ["whatsappNumber", "whatsappNumber"],
    ["email", "email"],
    ["contactPerson", "contactPerson"],
    ["phone", "phone"],
    ["address", "address"],
    ["state", "state"],
    ["paymentTerms", "paymentTerms"],
    ["rating", "rating"],
    ["notes", "notes"],
    /* PR #40 — full master record */
    ["supplierType", "supplierType"],
    ["category", "category"],
    ["country", "country"],
    ["tinNumber", "tinNumber"],
    ["businessRegNo", "businessRegNo"],
    ["postcode", "postcode"],
    ["area", "area"],
    ["mobile", "mobile"],
    ["fax", "fax"],
    ["website", "website"],
    ["attention", "attention"],
    ["businessNature", "businessNature"],
    ["creditLimitSen", "creditLimitSen"],
  ];
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    updates[to] = body[from];
  }
  if (body.status !== undefined && SUPPLIER_STATUSES.has(body.status as string)) {
    updates.status = body.status;
  }
  if (body.currency !== undefined && CURRENCIES.has(body.currency as string)) {
    updates.currency = body.currency;
  }
  if (body.statementType !== undefined && STATEMENT_TYPES.has(body.statementType as string)) {
    updates.statementType = body.statementType;
  }
  if (body.agingBasis !== undefined && AGING_BASES.has(body.agingBasis as string)) {
    updates.agingBasis = body.agingBasis;
  }

  const db = getDb(c.env);
  try {
    const updated = await db
      .update(suppliersTable)
      .set(updates)
      .where(eq(suppliersTable.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ supplier: toSupplierResponse(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── Bindings: list / create / batch / update / delete ─────────────────
app.get("/:id/bindings", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    const rows = await db
      .select()
      .from(supplierMaterialBindings)
      .where(eq(supplierMaterialBindings.supplierId, id))
      .orderBy(asc(supplierMaterialBindings.materialCode));
    return c.json({ bindings: rows.map(toBindingResponse) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

app.post("/:id/bindings", async (c) => {
  const supplierId = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const kind = body.materialKind as string;
  if (!MATERIAL_KINDS.has(kind)) return c.json({ error: "invalid_material_kind" }, 400);
  if (!body.materialCode) return c.json({ error: "material_code_required" }, 400);
  if (!body.materialName) return c.json({ error: "material_name_required" }, 400);
  if (!body.supplierSku) return c.json({ error: "supplier_sku_required" }, 400);
  const currency = (body.currency as string) ?? "MYR";
  if (!CURRENCIES.has(currency)) return c.json({ error: "invalid_currency" }, 400);

  const db = getDb(c.env);

  // 2990s validated body.priceMatrix against the SKU's mfg_products.category.
  // Houzs has no product catalogue yet — store the matrix as-is (passthrough).
  // TODO: wire to Houzs product source in the Products slice.
  const priceMatrix =
    body.priceMatrix !== undefined ? (body.priceMatrix as Record<string, unknown> | null) : undefined;

  const row: Record<string, unknown> = {
    supplierId,
    materialKind: kind as "mfg_product" | "fabric" | "raw",
    materialCode: body.materialCode,
    materialName: body.materialName,
    supplierSku: body.supplierSku,
    unitPriceCenti: typeof body.unitPriceCenti === "number" ? body.unitPriceCenti : 0,
    currency: currency as "MYR" | "RMB" | "USD" | "SGD",
    leadTimeDays: typeof body.leadTimeDays === "number" ? body.leadTimeDays : 0,
    paymentTermsOverride: (body.paymentTermsOverride as string) ?? null,
    moq: typeof body.moq === "number" ? body.moq : 0,
    priceValidFrom: (body.priceValidFrom as string) ?? null,
    priceValidTo: (body.priceValidTo as string) ?? null,
    isMainSupplier: Boolean(body.isMainSupplier),
    notes: (body.notes as string) ?? null,
  };
  if (priceMatrix !== undefined) row.priceMatrix = priceMatrix;

  try {
    // If marking as main supplier, demote any other main for the same material.
    if (row.isMainSupplier) {
      await db
        .update(supplierMaterialBindings)
        .set({ isMainSupplier: false })
        .where(
          and(
            eq(supplierMaterialBindings.materialKind, row.materialKind as "mfg_product" | "fabric" | "raw"),
            eq(supplierMaterialBindings.materialCode, row.materialCode as string),
            eq(supplierMaterialBindings.isMainSupplier, true),
          ),
        );
    }

    const inserted = await db.insert(supplierMaterialBindings).values(row as never).returning();
    return c.json({ binding: toBindingResponse(inserted[0]) }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// Batch-create bindings — multi-select maps to N bindings in a single POST.
// Each row may have its own supplier_sku/price/lead/moq. Skips materials
// already bound for this supplier (returns count skipped).
app.post("/:id/bindings/batch", async (c) => {
  const supplierId = c.req.param("id");
  let body: { bindings?: Array<Record<string, unknown>> };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const list = body.bindings;
  if (!Array.isArray(list) || list.length === 0) return c.json({ error: "bindings_required" }, 400);

  const db = getDb(c.env);

  try {
    // Pre-check: drop rows already bound for this supplier (avoid duplicates).
    const existing = await db
      .select({
        material_code: supplierMaterialBindings.materialCode,
        material_kind: supplierMaterialBindings.materialKind,
      })
      .from(supplierMaterialBindings)
      .where(eq(supplierMaterialBindings.supplierId, supplierId));
    const seen = new Set<string>(existing.map((r) => `${r.material_kind}|${r.material_code}`));

    const rows: Array<Record<string, unknown>> = [];
    let skipped = 0;
    for (const b of list) {
      const kind = String(b.materialKind ?? "mfg_product");
      if (!MATERIAL_KINDS.has(kind)) continue;
      if (!b.materialCode || !b.materialName || !b.supplierSku) continue;
      const key = `${kind}|${b.materialCode}`;
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      const currency = String(b.currency ?? "MYR");
      if (!CURRENCIES.has(currency)) continue;
      const row: Record<string, unknown> = {
        supplierId,
        materialKind: kind as "mfg_product" | "fabric" | "raw",
        materialCode: b.materialCode,
        materialName: b.materialName,
        supplierSku: b.supplierSku,
        unitPriceCenti: typeof b.unitPriceCenti === "number" ? b.unitPriceCenti : 0,
        currency: currency as "MYR" | "RMB" | "USD" | "SGD",
        leadTimeDays: typeof b.leadTimeDays === "number" ? b.leadTimeDays : 0,
        moq: typeof b.moq === "number" ? b.moq : 0,
        isMainSupplier: Boolean(b.isMainSupplier),
        notes: (b.notes as string | undefined) ?? null,
      };
      // 2990s validated an optional per-category cost matrix here. Houzs stores
      // it as-is (passthrough). TODO: wire to Houzs product source.
      if (b.priceMatrix !== undefined) row.priceMatrix = b.priceMatrix;
      rows.push(row);
      seen.add(key);
    }

    if (rows.length === 0) return c.json({ inserted: 0, skipped });

    const data = await db.insert(supplierMaterialBindings).values(rows as never).returning();
    return c.json({ inserted: data.length, skipped, bindings: data.map(toBindingResponse) }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.patch("/:id/bindings/:bindingId", async (c) => {
  const bindingId = c.req.param("bindingId");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const map: Array<[string, string]> = [
    ["materialCode", "materialCode"],
    ["materialName", "materialName"],
    ["supplierSku", "supplierSku"],
    ["unitPriceCenti", "unitPriceCenti"],
    ["leadTimeDays", "leadTimeDays"],
    ["paymentTermsOverride", "paymentTermsOverride"],
    ["moq", "moq"],
    ["priceValidFrom", "priceValidFrom"],
    ["priceValidTo", "priceValidTo"],
    ["notes", "notes"],
  ];
  for (const [from, to] of map) if (body[from] !== undefined) updates[to] = body[from];
  if (body.currency !== undefined && CURRENCIES.has(body.currency as string)) updates.currency = body.currency;
  if (body.materialKind !== undefined && MATERIAL_KINDS.has(body.materialKind as string))
    updates.materialKind = body.materialKind;
  if (body.isMainSupplier !== undefined) updates.isMainSupplier = Boolean(body.isMainSupplier);

  const db = getDb(c.env);

  try {
    // 2990s validated body.priceMatrix against the binding's current category.
    // Houzs stores it as-is (passthrough). TODO: wire to Houzs product source.
    if (body.priceMatrix !== undefined) {
      const existing = await db
        .select({
          material_kind: supplierMaterialBindings.materialKind,
          material_code: supplierMaterialBindings.materialCode,
        })
        .from(supplierMaterialBindings)
        .where(eq(supplierMaterialBindings.id, bindingId))
        .limit(1);
      if (!existing[0]) return c.json({ error: "not_found" }, 404);
      updates.priceMatrix = body.priceMatrix;
    }

    // If promoting to main, demote others first (need the binding's material info).
    if (updates.isMainSupplier === true) {
      const existing = await db
        .select({
          material_kind: supplierMaterialBindings.materialKind,
          material_code: supplierMaterialBindings.materialCode,
        })
        .from(supplierMaterialBindings)
        .where(eq(supplierMaterialBindings.id, bindingId))
        .limit(1);
      const found = existing[0];
      if (found) {
        await db
          .update(supplierMaterialBindings)
          .set({ isMainSupplier: false })
          .where(
            and(
              eq(supplierMaterialBindings.materialKind, found.material_kind),
              eq(supplierMaterialBindings.materialCode, found.material_code),
              eq(supplierMaterialBindings.isMainSupplier, true),
              ne(supplierMaterialBindings.id, bindingId),
            ),
          );
      }
    }

    const updated = await db
      .update(supplierMaterialBindings)
      .set(updates)
      .where(eq(supplierMaterialBindings.id, bindingId))
      .returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ binding: toBindingResponse(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:id/bindings/:bindingId", async (c) => {
  const bindingId = c.req.param("bindingId");
  const db = getDb(c.env);
  try {
    await db.delete(supplierMaterialBindings).where(eq(supplierMaterialBindings.id, bindingId));
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Scorecard: live PO + GRN aggregation for KPI tiles ───────────────
//
// Returns:
//   { onTimeRate %, defectRate %, averageLeadDays, totalPOs, receivedPOs,
//     onTimeCount, last10POs: [...] }
//
// 2990s computed this live from purchase_orders / grn_items /
// purchase_order_items. Those tables land in the PO + GRN slices; until then
// this returns the faithful zero shape so the SupplierDetail Overview tab
// renders. TODO: wire to Houzs PO/GRN once those slices land.
app.get("/:id/scorecard", async (c) => {
  const id = c.req.param("id");
  return c.json({
    supplierId: id,
    onTimeRate: 0,
    defectRate: 0,
    averageLeadDays: 0,
    totalPOs: 0,
    receivedPOs: 0,
    onTimeCount: 0,
    last10POs: [] as unknown[],
  });
});

// ── Reverse lookup: who supplies this material? ──────────────────────
app.get("/material/:kind/:code", async (c) => {
  const kind = c.req.param("kind");
  const code = c.req.param("code");
  const mainOnly = c.req.query("mainOnly") === "true";

  if (!MATERIAL_KINDS.has(kind)) return c.json({ error: "invalid_material_kind" }, 400);

  const db = getDb(c.env);
  try {
    const conds = [
      eq(supplierMaterialBindings.materialKind, kind as "mfg_product" | "fabric" | "raw"),
      eq(supplierMaterialBindings.materialCode, code),
    ];
    if (mainOnly) conds.push(eq(supplierMaterialBindings.isMainSupplier, true));

    // 2990s embedded supplier:suppliers(id,code,name,status) via PostgREST.
    // Reproduce with a left join; same nested `supplier` shape in the response.
    const rows = await db
      .select({
        binding: supplierMaterialBindings,
        supplier: {
          id: suppliersTable.id,
          code: suppliersTable.code,
          name: suppliersTable.name,
          status: suppliersTable.status,
        },
      })
      .from(supplierMaterialBindings)
      .leftJoin(suppliersTable, eq(supplierMaterialBindings.supplierId, suppliersTable.id))
      .where(and(...conds))
      .orderBy(
        desc(supplierMaterialBindings.isMainSupplier),
        asc(supplierMaterialBindings.unitPriceCenti),
      );

    return c.json({
      bindings: rows.map((r) => ({ ...toBindingResponse(r.binding), supplier: r.supplier })),
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Response shaping ─────────────────────────────────────────────────
// Map Drizzle's camelCase rows to the snake_case JSON the 2990s frontend
// consumes (its SupplierRow / BindingRow types). Keeps the wire shape
// identical to 2990s (rule #7) even though the ORM returns camelCase.

type SupplierRowDb = typeof suppliersTable.$inferSelect;
type BindingRowDb = typeof supplierMaterialBindings.$inferSelect;

function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toSupplierResponse(s: SupplierRowDb) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    whatsapp_number: s.whatsappNumber,
    email: s.email,
    contact_person: s.contactPerson,
    phone: s.phone,
    address: s.address,
    state: s.state,
    payment_terms: s.paymentTerms,
    status: s.status,
    rating: s.rating,
    notes: s.notes,
    supplier_type: s.supplierType,
    category: s.category,
    tin_number: s.tinNumber,
    business_reg_no: s.businessRegNo,
    postcode: s.postcode,
    area: s.area,
    mobile: s.mobile,
    fax: s.fax,
    website: s.website,
    attention: s.attention,
    business_nature: s.businessNature,
    country: s.country,
    currency: s.currency,
    statement_type: s.statementType,
    aging_basis: s.agingBasis,
    credit_limit_sen: s.creditLimitSen,
    created_at: isoOrNull(s.createdAt),
    updated_at: isoOrNull(s.updatedAt),
  };
}

function toBindingResponse(b: BindingRowDb) {
  return {
    id: b.id,
    supplier_id: b.supplierId,
    material_kind: b.materialKind,
    material_code: b.materialCode,
    material_name: b.materialName,
    supplier_sku: b.supplierSku,
    unit_price_centi: b.unitPriceCenti,
    currency: b.currency,
    lead_time_days: b.leadTimeDays,
    payment_terms_override: b.paymentTermsOverride,
    moq: b.moq,
    price_valid_from: b.priceValidFrom,
    price_valid_to: b.priceValidTo,
    is_main_supplier: b.isMainSupplier,
    notes: b.notes,
    price_matrix: b.priceMatrix ?? null,
    created_at: isoOrNull(b.createdAt),
    updated_at: isoOrNull(b.updatedAt),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Postgres unique-violation (SQLSTATE 23505), surfaced by postgres.js as
// err.code. Mirrors 2990s's check for error.code === '23505'.
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}

export default app;
