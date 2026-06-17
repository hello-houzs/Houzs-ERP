// Supply Chain — Purchase Billing (Invoices) + Purchase Returns shared Zod
// schemas + inferred types. Single source of truth consumed by BOTH the worker
// (request validation) and the frontend (form typing). Field sets mirror the
// scm_purchase_invoice* / scm_purchase_return* tables in
// backend/src/db/schema.pg.ts. Unknown keys are stripped on parse (Zod default).
// DB column DEFAULTs apply for omitted optional fields — schemas don't re-declare
// defaults. Money is integer cents (*_centi).
import { z } from "zod";

const optStr = z.string().trim().optional().nullable();
const optDate = z.string().trim().optional().nullable(); // ISO date 'YYYY-MM-DD'

// Reused from the SCM material taxonomy (mfg_product / fabric / raw).
export const BillingMaterialKind = z.enum(["mfg_product", "fabric", "raw"]);
export const PurchaseInvoiceStatus = z.enum(["UNPAID", "PARTIAL", "PAID", "CANCELLED"]);
export const PurchaseReturnStatus = z.enum(["DRAFT", "POSTED", "CANCELLED"]);

// ── Purchase Invoices (header + line items) ─────────────────────────────────
export const invoiceItemSchema = z.object({
  material_kind: BillingMaterialKind.optional(),
  material_code: z.string().trim().min(1, "material_code is required"),
  material_name: optStr,
  qty: z.coerce.number().int().min(0),
  unit_price_centi: z.coerce.number().int().min(0).optional(),
  discount_centi: z.coerce.number().int().min(0).optional(),
  notes: optStr,
});
export type InvoiceItem = z.infer<typeof invoiceItemSchema>;

export const purchaseInvoiceCreateSchema = z.object({
  supplier_id: z.string().uuid("supplier_id must be a uuid"),
  purchase_order_id: z.string().uuid().optional().nullable(),
  supplier_invoice_no: optStr,
  invoice_date: optDate,
  due_date: optDate,
  currency: optStr,
  tax_centi: z.coerce.number().int().min(0).optional(),
  notes: optStr,
  items: z.array(invoiceItemSchema).min(1, "At least one line is required"),
});

export const purchaseInvoiceUpdateSchema = purchaseInvoiceCreateSchema
  .omit({ items: true })
  .partial()
  .extend({
    amount_paid_centi: z.coerce.number().int().min(0).optional(),
    status: PurchaseInvoiceStatus.optional(),
  });

export type PurchaseInvoiceCreate = z.infer<typeof purchaseInvoiceCreateSchema>;
export type PurchaseInvoiceUpdate = z.infer<typeof purchaseInvoiceUpdateSchema>;

// ── Purchase Returns (header + line items) ──────────────────────────────────
export const returnItemSchema = z.object({
  material_kind: BillingMaterialKind.optional(),
  material_code: z.string().trim().min(1, "material_code is required"),
  material_name: optStr,
  qty_returned: z.coerce.number().int().min(1, "qty_returned must be at least 1"),
  unit_cost_centi: z.coerce.number().int().min(0).optional(),
  notes: optStr,
});
export type ReturnItem = z.infer<typeof returnItemSchema>;

export const purchaseReturnCreateSchema = z.object({
  supplier_id: z.string().uuid("supplier_id must be a uuid"),
  warehouse_code: z.string().trim().min(1, "warehouse_code is required"),
  purchase_order_id: z.string().uuid().optional().nullable(),
  reason: optStr,
  notes: optStr,
  items: z.array(returnItemSchema).min(1, "At least one line is required"),
});

export const purchaseReturnUpdateSchema = purchaseReturnCreateSchema
  .omit({ items: true })
  .partial();

export type PurchaseReturnCreate = z.infer<typeof purchaseReturnCreateSchema>;
export type PurchaseReturnUpdate = z.infer<typeof purchaseReturnUpdateSchema>;
