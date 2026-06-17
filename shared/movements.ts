// Supply Chain — Stock Movements (Transfers + Stocktakes) shared Zod schemas +
// inferred types. Single source of truth consumed by BOTH the worker (request
// validation) and the frontend (form typing). Field sets mirror the
// scm_stock_transfer* / scm_stocktake* tables in backend/src/db/schema.pg.ts.
// Unknown keys are stripped on parse (Zod default). DB column DEFAULTs apply for
// omitted optional fields — schemas don't re-declare defaults. Quantities are
// integers; there is no money on a transfer/stocktake line (cost is sourced from
// the ledger's current FIFO average at post time).
import { z } from "zod";

const optStr = z.string().trim().optional().nullable();

// Reused from the SCM material taxonomy (mfg_product / fabric / raw).
export const MovementMaterialKind = z.enum(["mfg_product", "fabric", "raw"]);
export const MovementStatus = z.enum(["DRAFT", "POSTED", "CANCELLED"]);

// ── Stock Transfers (header + line items) ───────────────────────────────────
export const transferItemSchema = z.object({
  material_kind: MovementMaterialKind.optional(),
  material_code: z.string().trim().min(1, "material_code is required"),
  material_name: optStr,
  qty: z.coerce.number().int().min(1, "qty must be at least 1"),
  notes: optStr,
});
export type TransferItem = z.infer<typeof transferItemSchema>;

export const stockTransferCreateSchema = z
  .object({
    from_warehouse_code: z.string().trim().min(1, "from_warehouse_code is required"),
    to_warehouse_code: z.string().trim().min(1, "to_warehouse_code is required"),
    notes: optStr,
    items: z.array(transferItemSchema).min(1, "At least one line is required"),
  })
  .refine((d) => d.from_warehouse_code !== d.to_warehouse_code, {
    message: "from and to warehouse must differ",
    path: ["to_warehouse_code"],
  });

export const stockTransferUpdateSchema = z.object({
  from_warehouse_code: z.string().trim().min(1).optional(),
  to_warehouse_code: z.string().trim().min(1).optional(),
  notes: optStr,
});

export type StockTransferCreate = z.infer<typeof stockTransferCreateSchema>;
export type StockTransferUpdate = z.infer<typeof stockTransferUpdateSchema>;

// ── Stocktakes (header + line items) ────────────────────────────────────────
// system_qty is optional on input — the server recomputes it authoritatively
// from the ledger at create time, so a client-supplied value is advisory only.
export const stocktakeItemSchema = z.object({
  material_kind: MovementMaterialKind.optional(),
  material_code: z.string().trim().min(1, "material_code is required"),
  material_name: optStr,
  counted_qty: z.coerce.number().int().min(0),
  system_qty: z.coerce.number().int().optional(),
  notes: optStr,
});
export type StocktakeItem = z.infer<typeof stocktakeItemSchema>;

export const stocktakeCreateSchema = z.object({
  warehouse_code: z.string().trim().min(1, "warehouse_code is required"),
  notes: optStr,
  items: z.array(stocktakeItemSchema).min(1, "At least one line is required"),
});

export const stocktakeUpdateSchema = z.object({
  warehouse_code: z.string().trim().min(1).optional(),
  notes: optStr,
});

export type StocktakeCreate = z.infer<typeof stocktakeCreateSchema>;
export type StocktakeUpdate = z.infer<typeof stocktakeUpdateSchema>;
