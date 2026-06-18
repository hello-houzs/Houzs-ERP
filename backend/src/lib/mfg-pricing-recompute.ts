// ----------------------------------------------------------------------------
// mfg-pricing-recompute (Houzs slice #58 subset) — only the combo-cost loader
// that the /sofa-combos route needs for COST auto-detect.
//
// 1:1 clone of the `loadModelSofaModuleCosts` helper from 2990s
// apps/api/src/lib/mfg-pricing-recompute.ts. SEAM: 2990s read via the Supabase
// PostgREST client; Houzs reads via Drizzle against the cloned mfg_products
// table. The pure builders (sofaModulePricesFromSkus / SofaComboCostSen) live in
// the ported @shared/sofa-build. The full 2990s SO/PO re-cost chain
// (recomputeFromSnapshot etc.) is NOT cloned — out of this slice's scope.
// ----------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import {
  sofaModulePricesFromSkus,
  type SofaModulePriceSen,
} from "@shared/sofa-build";
import type { getDb } from "../db/client";
import { mfgProducts } from "../db/schema";

type Db = ReturnType<typeof getDb>;

/** Load a base model's per-module COST map (base_price_sen carries COST on the
 *  mfg side) keyed by canonical module code, for combo COST auto-detect. */
export async function loadModelSofaModuleCosts(
  db: Db,
  baseModel: string | null | undefined,
): Promise<SofaModulePriceSen | null> {
  if (!baseModel) return null;
  const rows = await db
    .select({ code: mfgProducts.code, basePriceSen: mfgProducts.basePriceSen })
    .from(mfgProducts)
    .where(and(eq(mfgProducts.baseModel, baseModel), eq(mfgProducts.category, "SOFA")));
  if (rows.length === 0) return null;
  return sofaModulePricesFromSkus(
    rows.map((r) => ({
      code: r.code,
      sellPriceSen: r.basePriceSen, // reuse the SELLING builder; field carries COST here
    })),
    baseModel,
  );
}
