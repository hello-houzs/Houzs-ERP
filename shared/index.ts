// @houzs/shared barrel — Zod schemas + inferred types shared by worker + SPA.
// Import via the "@shared/*" path alias (configured in both tsconfigs + Vite),
// e.g. `import { supplierCreateSchema } from "@shared/scm"`.
export * from "./auth";
// SCM 1:1 clone (Inventory/Warehouse slice) — generic pure helpers shared by the
// inventory route + StockAdjustment pages. Furniture-engine-free; the
// per-category variant maps stay dormant until a Houzs product layer lands.
export * from "./variant-key";
export * from "./adjustment-reasons";
// Products & Maintenance slice (#58) — FULL furniture pricing engine cloned 1:1
// from 2990s packages/shared/src (owner: clone it all, modify later — NOT
// Strategy-2-stripped). Pure functions, no I/O. `sofa-combo-pricing` is exported
// before `sofa-build` (which re-exports a couple of its symbols — TS tolerates
// the same-binding re-export). `product` schema imports `zod` (alias configured
// in all 4 toolchains, rule #8).
export * from "./sofa-combo-pricing";
export * from "./maintenance-pools";
export * from "./mfg-pricing";
export * from "./sofa-tier";
export * from "./sofa-build";
export * from "./fabric-tier-addon";
export * from "./variant-summary";
export * from "./free-gift";
export * from "./schemas/product";
