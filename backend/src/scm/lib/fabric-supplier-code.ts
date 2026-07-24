// ----------------------------------------------------------------------------
// fabric-supplier-code — READ-time enrichment that stamps each SO/PO/DO/SI line's
// variants with `fabricSupplierCode` (the supplier's own code for our internal
// fabric), so the on-screen detail line reads "BF-01 (PC151-01)" — the same
// internal-plus-supplier pairing the fabric PICKER and the PDFs already show.
//
// Owner rule (2026-07-24): "orders 全部也是要补回去 ... 显示两个 code BF-01（PC151-01)".
// buildVariantSummary renders the parenthesised supplier code when this field is
// present + DISTINCT; absent -> the line is unchanged (old behaviour). So this is
// a pure DISPLAY enrichment on the returned rows — it never mutates stored data.
//
// ONE batched query per document (NOT per line): Cloudflare Workers cap the
// subrequests a single request may make, so a per-line lookup would blow the cap
// on a large order. We collect the distinct internal fabric codes off the lines'
// variants, resolve them all in a single scm.fabric_trackings read scoped to the
// active company, then stamp each line from the resulting map.
//
// Fail-soft: any lookup error leaves the lines untouched (they fall back to the
// bare internal code) — a fabric-code hiccup must never fail a detail response.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';

/* The variant key carrying the LEAD internal fabric code buildVariantSummary
   shows first (and the one it parenthesises the supplier code after). SO/PO/DO/SI
   lines store the fabric there; the GRN/PI/PR `fabricColor` fallback is a
   separate, out-of-scope path (see the task's deferred note). */
const FABRIC_CODE_KEY = 'fabricCode';

/* A returned order line, loose enough to accept every detail endpoint's mapped
   row shape. Record (index signature) — NOT `{ variants?: unknown }`, which is a
   weak type TS rejects for the concrete mapped rows that carry no static
   `variants` key. `variants` rides on the row as an index-signature value. */
type LineWithVariants = Record<string, unknown>;

const trimStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Stamp `variants.fabricSupplierCode` on every line whose internal fabricCode has
 * a supplier_code in scm.fabric_trackings (active company). Mutates the passed
 * `items` in place — each enriched line gets a CLONED variants object, so the
 * source row (and any drift comparison already computed off the raw variants) is
 * left untouched. Resolves with nothing; on any failure the lines are unchanged.
 */
export async function enrichLinesWithFabricSupplierCode(
  sb: SupabaseClient<any, any, any>,
  c: CompanyScopeCtx,
  items: LineWithVariants[],
): Promise<void> {
  // Distinct internal fabric codes riding on the lines.
  const codes = new Set<string>();
  for (const it of items) {
    const v = it.variants;
    if (v && typeof v === 'object') {
      const fc = trimStr((v as Record<string, unknown>)[FABRIC_CODE_KEY]);
      if (fc) codes.add(fc);
    }
  }
  if (codes.size === 0) return;

  const map = new Map<string, string>();
  try {
    // ONE batched read, company-scoped (no-op pre-activation / single-company).
    const { data } = await scopeToCompany(
      sb.from('fabric_trackings').select('fabric_code, supplier_code').in('fabric_code', [...codes]),
      c,
    );
    for (const r of (data ?? []) as Array<{ fabric_code?: string | null; supplier_code?: string | null }>) {
      const code = trimStr(r.fabric_code);
      const sup = trimStr(r.supplier_code);
      // On HOUZS fabrics supplier_code is often blank -> skip, so the line falls
      // back to the bare internal code with NO empty parens.
      if (code && sup) map.set(code, sup);
    }
  } catch {
    return; // a lookup hiccup must never fail the detail response
  }
  if (map.size === 0) return;

  for (const it of items) {
    const v = it.variants;
    if (!v || typeof v !== 'object') continue;
    const fc = trimStr((v as Record<string, unknown>)[FABRIC_CODE_KEY]);
    if (!fc) continue;
    const sup = map.get(fc);
    // Distinct-only: a supplier code equal to the internal code adds no parens
    // (buildVariantSummary guards this too — belt and braces).
    if (sup && sup !== fc) {
      it.variants = { ...(v as Record<string, unknown>), fabricSupplierCode: sup };
    }
  }
}
