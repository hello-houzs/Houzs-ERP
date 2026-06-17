// Supply Chain — Goods Receipt (GRN) shared Zod schemas + inferred types.
// Single source of truth consumed by BOTH the worker (request validation) and
// the frontend (form typing). Field sets mirror the scm_goods_receipt_* tables
// in backend/src/db/schema.pg.ts. Unknown keys are stripped on parse (Zod
// default). DB column DEFAULTs apply for omitted optional fields — schemas don't
// re-declare defaults. Money is integer cents (*_centi).
import { z } from "zod";

const optStr = z.string().trim().optional().nullable();
const optDate = z.string().trim().optional().nullable(); // ISO date 'YYYY-MM-DD'

// Reused from the SCM material taxonomy (mfg_product / fabric / raw).
export const GrnMaterialKind = z.enum(["mfg_product", "fabric", "raw"]);
export const GrnStatus = z.enum(["DRAFT", "POSTED", "CANCELLED"]);

export const grnItemSchema = z.object({
  po_item_id: z.string().uuid().optional().nullable(),
  material_kind: GrnMaterialKind.optional(),
  material_code: z.string().trim().min(1, "material_code is required"),
  material_name: optStr,
  qty_received: z.coerce.number().int().min(0),
  unit_cost_centi: z.coerce.number().int().min(0).optional(),
  notes: optStr,
});
export type GrnItem = z.infer<typeof grnItemSchema>;

export const grnCreateSchema = z.object({
  supplier_id: z.string().uuid("supplier_id must be a uuid"),
  purchase_order_id: z.string().uuid().optional().nullable(),
  warehouse_code: z.string().trim().min(1, "warehouse_code is required"),
  received_date: optDate,
  notes: optStr,
  items: z.array(grnItemSchema).min(1, "At least one line is required"),
});
export const grnUpdateSchema = grnCreateSchema.omit({ items: true }).partial();
export type GrnCreate = z.infer<typeof grnCreateSchema>;
export type GrnUpdate = z.infer<typeof grnUpdateSchema>;
