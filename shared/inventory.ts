// Supply Chain — Inventory shared Zod schemas + inferred types (stock moves / adjustments).
import { z } from "zod";

export const MoveType = z.enum([
  "GRN_IN",
  "PURCHASE_RETURN_OUT",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "ADJUST_IN",
  "ADJUST_OUT",
  "STOCKTAKE_ADJ",
]);

export const stockAdjustSchema = z.object({
  warehouse_code: z.string().trim().min(1),
  material_kind: z.enum(["mfg_product", "fabric", "raw"]),
  material_code: z.string().trim().min(1),
  material_name: z.string().trim().optional().nullable(),
  qty: z.coerce.number().int().refine((n) => n !== 0, "qty cannot be zero"),
  unit_cost_centi: z.coerce.number().int().min(0).optional(),
  note: z.string().trim().optional().nullable(),
});
export type StockAdjust = z.infer<typeof stockAdjustSchema>;
