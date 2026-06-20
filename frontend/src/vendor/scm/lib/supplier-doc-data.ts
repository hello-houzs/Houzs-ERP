// ----------------------------------------------------------------------------
// supplier-doc-data — print-time lookups for SUPPLIER-FACING purchasing docs
// (PO / GRN / PI / PR PDFs).
//
// Owner's rule (Commander): the supplier must see THEIR codes (they can only
// act on their own), and our internal codes stay visible too — BOTH on every
// purchasing document. Fabric/colour must show the SUPPLIER's colour code with
// our internal code alongside.
//
// Data sources (REUSED, no new backend routes):
//   • supplier_material_bindings — via GET /suppliers/:id (the SupplierDetail
//     page endpoint, returns { supplier, bindings }) → material_code →
//     supplier_sku for material_kind='mfg_product'. Main binding wins.
//   • fabric_trackings — via GET /fabric-tracking (the FabricTracking page
//     endpoint) → fabric_code (internal) → supplier_code.
//
// All loaders are DEFENSIVE: any fetch failure returns an empty map so PDF
// generation never dies on a lookup hiccup — the doc just falls back to '—' /
// our internal codes.
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '@2990s/shared';
import { authedFetch } from './authed-fetch';

/** Minimal line shape the PDF generators share. Extra fields welcome. */
export type SupplierDocLine = {
  material_code: string;
  supplier_sku?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

/** Full supplier master row (GET /suppliers/:id → `supplier`). The PO detail
 *  endpoint embeds only a 7-field subset (no fax / attention / payment_terms),
 *  so the PO PDF tops itself up from this record at print time — fail-soft. */
export type SupplierRecord = {
  id?: string;
  code?: string | null;
  name?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  mobile?: string | null;
  fax?: string | null;
  email?: string | null;
  address?: string | null;
  area?: string | null;
  postcode?: string | null;
  state?: string | null;
  country?: string | null;
  attention?: string | null;
  payment_terms?: string | null;
};

/* The variant keys that can carry an INTERNAL fabric/colour code. SO-keyed
   lines use fabricCode/colorCode; GRN/PI/PR editors store fabricColor (see
   buildVariantSummary in packages/shared). */
const FABRIC_VARIANT_KEYS = ['fabricCode', 'colorCode', 'fabricColor'] as const;

/**
 * internal fabric_code → supplier_code, via the same /fabric-tracking endpoint
 * the FabricTracking page queries. Only codes in `fabricCodes` are kept.
 */
export async function loadFabricSupplierMap(fabricCodes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(fabricCodes.map((c) => c.trim()).filter(Boolean));
  if (wanted.size === 0) return new Map();
  try {
    const res = await authedFetch<{ fabrics: Array<{ fabric_code: string; supplier_code: string | null }> }>(
      '/fabric-tracking',
    );
    const map = new Map<string, string>();
    for (const f of res.fabrics ?? []) {
      const sup = (f.supplier_code ?? '').trim();
      if (sup && wanted.has(f.fabric_code)) map.set(f.fabric_code, sup);
    }
    return map;
  } catch {
    return new Map(); // lookup failure must never block the PDF
  }
}

/**
 * internal fabric_code → fabric_description, same /fabric-tracking endpoint.
 * Used by the CUSTOMER-facing SO PDF so the printed line reads
 * "EZ-001 — Easy Clean Velvet" instead of the bare code. Fail-soft: any
 * fetch hiccup returns an empty map and the PDF prints codes as-is.
 */
export async function loadFabricDescriptionMap(fabricCodes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(fabricCodes.map((c) => c.trim()).filter(Boolean));
  if (wanted.size === 0) return new Map();
  try {
    const res = await authedFetch<{ fabrics: Array<{ fabric_code: string; fabric_description: string | null }> }>(
      '/fabric-tracking',
    );
    const map = new Map<string, string>();
    for (const f of res.fabrics ?? []) {
      const desc = (f.fabric_description ?? '').trim();
      if (desc && wanted.has(f.fabric_code)) map.set(f.fabric_code, desc);
    }
    return map;
  } catch {
    return new Map(); // lookup failure must never block the PDF
  }
}

/**
 * material_code → supplier_sku for ONE supplier, via the SupplierDetail page's
 * GET /suppliers/:id (returns every binding for that supplier). Filters to
 * material_kind='mfg_product' and the requested codes; when the same code is
 * bound twice the main binding (is_main_supplier) wins.
 */
export async function loadSupplierSkuMap(
  supplierId: string | null | undefined,
  codes: string[],
): Promise<Map<string, string>> {
  const wanted = new Set(codes.map((c) => c.trim()).filter(Boolean));
  if (!supplierId || wanted.size === 0) return new Map();
  try {
    const res = await authedFetch<{
      bindings: Array<{
        material_kind: string;
        material_code: string;
        supplier_sku: string | null;
        is_main_supplier: boolean;
      }>;
    }>(`/suppliers/${supplierId}`);
    const candidates = (res.bindings ?? [])
      .filter((b) => b.material_kind === 'mfg_product'
        && wanted.has(b.material_code)
        && (b.supplier_sku ?? '').trim() !== '')
      // Main binding first; first writer wins below.
      .sort((a, b) => Number(b.is_main_supplier) - Number(a.is_main_supplier));
    const map = new Map<string, string>();
    for (const b of candidates) {
      if (!map.has(b.material_code)) map.set(b.material_code, (b.supplier_sku ?? '').trim());
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Collect every internal fabric code riding in the lines' variants JSONB. */
export function collectFabricCodes(items: SupplierDocLine[]): string[] {
  const codes = new Set<string>();
  for (const it of items) {
    const v = it.variants;
    if (!v || typeof v !== 'object') continue;
    for (const key of FABRIC_VARIANT_KEYS) {
      const raw = v[key];
      if (typeof raw === 'string' && raw.trim()) codes.add(raw.trim());
    }
  }
  return [...codes];
}

/** Full supplier master record via GET /suppliers/:id. Fail-soft → null. */
export async function loadSupplierRecord(
  supplierId: string | null | undefined,
): Promise<SupplierRecord | null> {
  if (!supplierId) return null;
  try {
    const res = await authedFetch<{ supplier: SupplierRecord | null }>(`/suppliers/${supplierId}`);
    return res.supplier ?? null;
  } catch {
    return null;
  }
}

/** Everything a purchasing-doc PDF needs, fetched in one parallel round.
 *  `supplier` = the FULL master record (fax / attention / payment_terms …)
 *  that the PO detail endpoint's 7-field embed omits; null on any failure. */
export async function loadSupplierDocData(
  supplierId: string | null | undefined,
  items: SupplierDocLine[],
): Promise<{
  skuMap: Map<string, string>;
  fabricMap: Map<string, string>;
  supplier: SupplierRecord | null;
}> {
  // Binding lookup only for lines that never snapshotted a supplier_sku
  // (PI/PR lines have no supplier_sku column at all → all of them).
  const missing = items
    .filter((it) => !(it.supplier_sku ?? '').trim())
    .map((it) => it.material_code);
  const [skuMap, fabricMap, supplier] = await Promise.all([
    loadSupplierSkuMap(supplierId, missing),
    loadFabricSupplierMap(collectFabricCodes(items)),
    loadSupplierRecord(supplierId),
  ]);
  return { skuMap, fabricMap, supplier };
}

/**
 * The supplier-facing item code for a line: snapshotted supplier_sku first,
 * then the live binding lookup, else '—' (our code has its own column).
 */
export function supplierCodeFor(it: SupplierDocLine, skuMap: Map<string, string>): string {
  return (it.supplier_sku ?? '').trim() || skuMap.get(it.material_code) || '—';
}

/**
 * Specs / variant summary where fabric segments show the SUPPLIER's colour
 * code with our internal code alongside — `supplierColour (ourCode)` — when a
 * fabric_trackings mapping exists; otherwise our code as-is.
 */
export function specsLine(it: SupplierDocLine, fabricMap: Map<string, string>): string {
  const v = it.variants;
  if (!v || typeof v !== 'object') return '';
  let mapped: Record<string, unknown> = v;
  for (const key of FABRIC_VARIANT_KEYS) {
    const raw = v[key];
    if (typeof raw === 'string') {
      const sup = fabricMap.get(raw.trim());
      if (sup) {
        if (mapped === v) mapped = { ...v }; // clone once, on demand
        mapped[key] = `${sup} (${raw.trim()})`;
      }
    }
  }
  // labelled: supplier docs (PO / GRN / PI) prefix the fabric segment "Fabric: ".
  return buildVariantSummary(it.item_group ?? null, mapped, { labelled: true });
}

/* ── Customer-facing document variant line (Commander 2026-06-16) ───────────
   ONE shared composer so EVERY customer document — SO, DO, DR, SI, Consignment
   Note/Return — renders the line description identically: buildVariantSummary
   with each fabric code shown as "internal (external) — description". This is
   what unifies the supply-chain docs (the supplier docs keep specsLine, which
   leads with the SUPPLIER's code per the owner's "supplier acts on their own
   code" rule). */
export function docVariantLine(
  item: { item_group?: string | null; variants?: Record<string, unknown> | null },
  fabricExtMap: Map<string, string>,
  fabricDescMap: Map<string, string>,
): string {
  const v = item.variants;
  if (!v || typeof v !== 'object') return '';
  let mapped: Record<string, unknown> = v;
  for (const key of FABRIC_VARIANT_KEYS) {
    const raw = v[key];
    if (typeof raw === 'string' && raw.trim()) {
      const code = raw.trim();
      const ext = fabricExtMap.get(code);   // supplier external colour code
      const desc = fabricDescMap.get(code);  // our fabric description
      if (ext || desc) {
        if (mapped === v) mapped = { ...v };
        // Strip a redundant leading code from the description (the fabric_trackings
        // description often starts with the code, e.g. "EZ-008 Forest") so the line
        // doesn't read "EZ-008 (M2402-13) — EZ-008 Forest" (Commander 2026-06-19).
        const cleanDesc = desc && desc.toLowerCase().startsWith(code.toLowerCase())
          ? desc.slice(code.length).trim()
          : desc;
        mapped[key] = `${code}${ext ? ` (${ext})` : ''}${cleanDesc ? ` — ${cleanDesc}` : ''}`;
      }
    }
  }
  return buildVariantSummary(item.item_group ?? null, mapped);
}

/** Load BOTH fabric maps (supplier external colour + our description) for a set
 *  of doc lines in one parallel round — feeds docVariantLine on customer docs. */
export async function loadCustomerFabricMaps(
  items: Array<{ variants?: Record<string, unknown> | null }>,
): Promise<{ ext: Map<string, string>; desc: Map<string, string> }> {
  const set = new Set<string>();
  for (const it of items) {
    const v = it.variants;
    if (!v || typeof v !== 'object') continue;
    for (const k of FABRIC_VARIANT_KEYS) {
      const r = v[k];
      if (typeof r === 'string' && r.trim()) set.add(r.trim());
    }
  }
  const codes = [...set];
  const [ext, desc] = await Promise.all([loadFabricSupplierMap(codes), loadFabricDescriptionMap(codes)]);
  return { ext, desc };
}
