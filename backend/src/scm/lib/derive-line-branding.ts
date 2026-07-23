// Auto-derive `branding` for SO/DO/consignment line rows from the product
// catalog. Called BEFORE any INSERT of new item rows so the "SO Branding is
// blank" bug can't reoccur.
//
// Owner rule (2026-07-23, Loo): "by default 从 SKU 就可以知道是什么 brand".
// Manual per-line branding entry is not a workflow — the SO CREATE form has
// never exposed a branding field, and 2990's imported SOs (68 orders, 203
// items) all landed with NULL line branding because the source system had
// the same gap. Rather than adding a UI field, we resolve branding from the
// product catalog on save — the ONE place that already knows the answer.
//
// Non-destructive: a caller-supplied branding always wins. Only NULL / blank
// rows are filled. Codes not found in the catalog stay blank (the SO list's
// existing category-based fallbacks — MATTRESS → mfg_products.branding,
// BEDFRAME-only → "BEDFRAME" — still apply on the derive path in the /list
// handler; this fill just closes the common case at write time).

import type { SupabaseClient } from '@supabase/supabase-js';

export type LineBrandingRow = {
  item_code?: string | null;
  branding?: string | null;
  company_id?: number | null;
};

const isBlank = (v: string | null | undefined) =>
  v == null || String(v).trim() === '';

/**
 * Fill in `branding` in place from `scm.mfg_products.branding` for any row
 * that has an item_code but no branding. Scoped per-company (mfg_products is
 * company-scoped since mig 0061); rows without a company_id fall back to
 * `fallbackCompanyId` (typically the active caller's company).
 */
export async function deriveLineBrandingFromProduct(
  sb: SupabaseClient,
  rows: LineBrandingRow[],
  fallbackCompanyId: number | null,
): Promise<void> {
  // Group codes that need lookup by their effective company_id so we can hit
  // the catalog with a single .in() per company (bounded chunks below).
  const need = new Map<number | null, Set<string>>();
  for (const r of rows) {
    if (!isBlank(r.branding) || !r.item_code) continue;
    const cid = r.company_id ?? fallbackCompanyId;
    if (!need.has(cid)) need.set(cid, new Set());
    need.get(cid)!.add(r.item_code);
  }
  if (need.size === 0) return;

  // key = `${cid ?? 0}:${code}` — same convention we look up with below.
  const brandByKey = new Map<string, string>();
  for (const [cid, codeSet] of need) {
    const codes = [...codeSet];
    for (let i = 0; i < codes.length; i += 300) {
      const chunk = codes.slice(i, i + 300);
      let q = sb.from('mfg_products').select('code, branding').in('code', chunk);
      if (cid != null) q = q.eq('company_id', cid);
      const { data } = await q;
      for (const p of (data ?? []) as Array<{ code: string; branding: string | null }>) {
        if (!isBlank(p.branding)) {
          brandByKey.set(`${cid ?? 0}:${p.code}`, p.branding!.trim());
        }
      }
    }
  }

  for (const r of rows) {
    if (!isBlank(r.branding) || !r.item_code) continue;
    const cid = r.company_id ?? fallbackCompanyId;
    const brand = brandByKey.get(`${cid ?? 0}:${r.item_code}`);
    if (brand) r.branding = brand;
  }
}
