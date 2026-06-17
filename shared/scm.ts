// Supply Chain — shared Zod schemas + inferred types.
// Single source of truth consumed by BOTH the worker (request validation) and
// the frontend (form typing). Field sets mirror the scm_* tables in
// backend/src/db/schema.pg.ts. Unknown keys are stripped on parse (Zod default),
// which replaces the old hand-rolled pick(body, FIELDS) whitelists. DB column
// DEFAULTs apply for omitted optional fields — schemas don't re-declare defaults.
import { z } from "zod";

const optStr = z.string().trim().optional().nullable();
const optDate = z.string().trim().optional().nullable(); // ISO date 'YYYY-MM-DD'
const optInt = z.coerce.number().int().optional();

// ── Suppliers ─────────────────────────────────────────────────────────────
export const SupplierStatus = z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]);
export const StatementType = z.enum(["OPEN_ITEM", "BALANCE_FORWARD", "NO_STATEMENT"]);
export const AgingBasis = z.enum(["INVOICE_DATE", "DUE_DATE"]);

export const supplierCreateSchema = z.object({
  code: z.string().trim().min(1, "Code is required"),
  name: z.string().trim().min(1, "Name is required"),
  whatsapp_number: optStr,
  email: optStr,
  contact_person: optStr,
  phone: optStr,
  address: optStr,
  state: optStr,
  country: optStr,
  payment_terms: optStr,
  status: SupplierStatus.optional(),
  rating: z.coerce.number().int().min(0).max(5).optional(),
  notes: optStr,
  supplier_type: optStr,
  category: optStr,
  tin_number: optStr,
  business_reg_no: optStr,
  postcode: optStr,
  area: optStr,
  mobile: optStr,
  fax: optStr,
  website: optStr,
  attention: optStr,
  business_nature: optStr,
  currency: optStr,
  statement_type: StatementType.optional(),
  aging_basis: AgingBasis.optional(),
  credit_limit_sen: z.coerce.number().int().min(0).optional(),
});
export const supplierUpdateSchema = supplierCreateSchema.partial();
export type SupplierCreate = z.infer<typeof supplierCreateSchema>;
export type SupplierUpdate = z.infer<typeof supplierUpdateSchema>;

// ── Supplier ↔ material bindings ───────────────────────────────────────────
export const MaterialKind = z.enum(["mfg_product", "fabric", "raw"]);

export const bindingCreateSchema = z.object({
  material_kind: MaterialKind.optional(),
  material_code: z.string().trim().min(1, "material_code is required"),
  material_name: optStr,
  supplier_sku: optStr,
  unit_price_centi: z.coerce.number().int().min(0).optional(),
  currency: optStr,
  lead_time_days: optInt,
  payment_terms_override: optStr,
  moq: optInt,
  price_valid_from: optDate,
  price_valid_to: optDate,
  is_main_supplier: z.coerce.boolean().optional(),
  notes: optStr,
  price_matrix: z.record(z.string(), z.any()).optional().nullable(),
});
export const bindingUpdateSchema = bindingCreateSchema.partial();
export type BindingCreate = z.infer<typeof bindingCreateSchema>;

// ── Purchase Orders (header + line items) ──────────────────────────────────
export const PurchaseOrderStatus = z.enum([
  "SUBMITTED", "SCHEDULED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED",
]);

export const poItemSchema = z.object({
  binding_id: z.string().uuid().optional().nullable(),
  material_kind: MaterialKind.optional(),
  material_code: z.string().trim().min(1, "material_code is required"),
  material_name: z.string().trim().min(1, "material_name is required"),
  supplier_sku: optStr,
  qty: z.coerce.number().int().min(0),
  unit_price_centi: z.coerce.number().int().min(0).optional(),
  discount_centi: z.coerce.number().int().min(0).optional(),
  uom: optStr,
  variants: z.record(z.string(), z.any()).optional().nullable(),
  notes: optStr,
  delivery_date: optDate,
});
export type PoItem = z.infer<typeof poItemSchema>;

export const purchaseOrderCreateSchema = z.object({
  po_number: z.string().trim().min(1).optional(), // server auto-generates when absent
  supplier_id: z.string().uuid("supplier_id must be a uuid"),
  status: PurchaseOrderStatus.optional(),
  po_date: optDate,
  expected_at: optDate,
  currency: optStr,
  notes: optStr,
  items: z.array(poItemSchema).optional().default([]),
});
export const purchaseOrderUpdateSchema = purchaseOrderCreateSchema
  .omit({ items: true })
  .partial();
export type PurchaseOrderCreate = z.infer<typeof purchaseOrderCreateSchema>;
