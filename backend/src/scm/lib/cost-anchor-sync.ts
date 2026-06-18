// ─────────────────────────────────────────────────────────────────────────
// cost-anchor-sync.ts — Product cost ⇄ supplier-binding cost mapping (R8 at
// the SKU level). Pure functions only: NO db, NO io. The suppliers.ts /
// mfg-products.ts routes call these, then perform the single mirror write.
//
// SCALE: mfg_products cost is in *sen* (base_price_sen = PRICE_2/cost ref,
// price1_sen = PRICE_1 cost). supplier_material_bindings cost is in *centi*
// (unit_price_centi flat, or price_matrix cells). centi === sen (both RM×100),
// so the mapping is 1:1 — no unit conversion, only field/shape mapping.
//
// DIRECTIONS (bidirectional while a binding is the cost anchor):
//   FLAT  (unit_price_centi; MATTRESS/ACCESSORY/SERVICE)
//        binding→product: base_price_sen = unit_price_centi
//        product→binding: unit_price_centi = base_price_sen
//   BEDFRAME (price_matrix {P1,P2})
//        binding→product: base_price_sen = matrix.P2, price1_sen = matrix.P1
//        product→binding: matrix.P2 = base_price_sen, matrix.P1 = price1_sen
//   SOFA (per-height matrix {height:{P1,P2,P3}})
//        SKIPPED — a single SKU cost vs a per-height grid is ambiguous; we
//        return { skipped:true } and touch nothing. Documented phase-2 gap.
// ─────────────────────────────────────────────────────────────────────────

/** Category as stored on mfg_products (uppercased before calling). */
export type AnchorCategory = 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | 'BEDFRAME' | 'SOFA' | string;

/** Minimal binding cost shape this helper reads/writes. */
export type BindingCost = {
  category: AnchorCategory | null;
  unit_price_centi: number | null;
  price_matrix: unknown; // JSONB — { P1,P2 } (bedframe) | { h:{P1,P2,P3} } (sofa) | null
};

/** Minimal product cost shape this helper reads/writes (sen). */
export type ProductCost = {
  base_price_sen: number | null;
  price1_sen: number | null;
};

/** Patch to apply to the mfg_products row (only the keys that changed). */
export type ProductPatch = Partial<Pick<ProductCost, 'base_price_sen' | 'price1_sen'>>;

/** Patch to apply to the binding row (only the keys that changed). */
export type BindingPatch = {
  unit_price_centi?: number;
  price_matrix?: Record<string, unknown>;
};

export type SyncResult<P> =
  | { skipped: true; reason: string; patch?: undefined }
  | { skipped: false; patch: P };

/** Which cost "lane" a binding uses, derived from its category. SOFA is its
 *  own lane purely so it can be skipped; everything that isn't BEDFRAME/SOFA
 *  falls back to the FLAT unit_price lane (matches validatePriceMatrix, where
 *  only BEDFRAME + SOFA carry a matrix and the rest use unit_price_centi). */
function laneFor(category: AnchorCategory | null): 'FLAT' | 'BEDFRAME' | 'SOFA' {
  const cat = (category ?? '').toUpperCase();
  if (cat === 'SOFA') return 'SOFA';
  if (cat === 'BEDFRAME') return 'BEDFRAME';
  return 'FLAT';
}

/** Coerce a JSONB cell to a finite non-negative integer, or null. */
function asCent(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Coerce a sen value (from a product row / patch) to int, or null. */
function asSen(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/* ── binding cost → product cost ──────────────────────────────────────────
   Called after a binding's cost is written (suppliers.ts PATCH). Returns the
   mfg_products patch to mirror, or { skipped } for SOFA / no-op. */
export function bindingToProductPatch(binding: BindingCost): SyncResult<ProductPatch> {
  const lane = laneFor(binding.category);

  if (lane === 'SOFA') {
    return { skipped: true, reason: 'sofa_per_height_matrix_ambiguous' };
  }

  if (lane === 'BEDFRAME') {
    const m = (binding.price_matrix && typeof binding.price_matrix === 'object' && !Array.isArray(binding.price_matrix))
      ? (binding.price_matrix as Record<string, unknown>)
      : {};
    const p2 = asCent(m.P2);
    const p1 = asCent(m.P1);
    const patch: ProductPatch = {};
    // base_price_sen ⇐ matrix.P2 (PRICE_2 / cost ref); price1_sen ⇐ matrix.P1.
    // A missing matrix cell maps to null (clears the product side) so the two
    // sides can't silently diverge.
    patch.base_price_sen = p2;
    patch.price1_sen = p1;
    return { skipped: false, patch };
  }

  // FLAT — 1:1 unit_price_centi → base_price_sen. price1 untouched (flat
  // categories have no PRICE_1 lane on the binding side).
  return { skipped: false, patch: { base_price_sen: asCent(binding.unit_price_centi) } };
}

/* ── product cost → binding cost ──────────────────────────────────────────
   Called after a product's cost is written (mfg-products.ts PATCH). Needs the
   binding's CURRENT price_matrix so the bedframe path can merge P1/P2 onto the
   existing object (preserving any unrelated keys). Returns the binding patch
   to mirror, or { skipped } for SOFA / no-op. */
export function productToBindingPatch(
  product: ProductCost,
  binding: Pick<BindingCost, 'category' | 'price_matrix'>,
): SyncResult<BindingPatch> {
  const lane = laneFor(binding.category);

  if (lane === 'SOFA') {
    return { skipped: true, reason: 'sofa_per_height_matrix_ambiguous' };
  }

  if (lane === 'BEDFRAME') {
    const prev = (binding.price_matrix && typeof binding.price_matrix === 'object' && !Array.isArray(binding.price_matrix))
      ? (binding.price_matrix as Record<string, unknown>)
      : {};
    const next: Record<string, unknown> = { ...prev };
    const p2 = asSen(product.base_price_sen);
    const p1 = asSen(product.price1_sen);
    // Write set cells; strip a cell whose product side is null so the matrix
    // doesn't accumulate nulls (matches the UI's sparse-matrix convention).
    if (p2 === null) delete next.P2; else next.P2 = p2;
    if (p1 === null) delete next.P1; else next.P1 = p1;
    return { skipped: false, patch: { price_matrix: next } };
  }

  // FLAT — 1:1 base_price_sen → unit_price_centi. unit_price_centi is NOT NULL
  // (default 0) on the binding, so a null product cost maps to 0.
  return { skipped: false, patch: { unit_price_centi: asSen(product.base_price_sen) ?? 0 } };
}
