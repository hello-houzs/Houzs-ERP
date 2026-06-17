// @houzs/shared barrel — Zod schemas + inferred types shared by worker + SPA.
// Import via the "@shared/*" path alias (configured in both tsconfigs + Vite),
// e.g. `import { supplierCreateSchema } from "@shared/scm"`.
export * from "./auth";
// SCM 1:1 clone (Inventory/Warehouse slice) — generic pure helpers shared by the
// inventory route + StockAdjustment pages. Furniture-engine-free; the
// per-category variant maps stay dormant until a Houzs product layer lands.
export * from "./variant-key";
export * from "./adjustment-reasons";
