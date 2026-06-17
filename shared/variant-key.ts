// ----------------------------------------------------------------------------
// Inventory variant key — the canonical "attribute composition" identity.
//
// 1:1 clone of 2990s packages/shared/src/variant-key.ts (pure functions, no I/O,
// no furniture-engine coupling). Stock is bucketed by (warehouse_id,
// product_code, variant_key). Two lines with identical physical attributes
// produce the SAME key, so they pool into one on-hand bucket; any difference
// produces a different key. Single source of truth shared by the API (writing
// inventory movements) AND the frontend (grouping / display), so both agree
// byte-for-byte.
//
// STRATEGY-2 NOTE (Houzs): Houzs materials are plain text with no category /
// item-group, so callers pass `itemGroup = '' / null` and `computeVariantKey`
// returns '' (the unclassified bucket) — stock pools per product_code. The
// per-category attribute maps below are kept VERBATIM for the future product
// layer; they simply don't fire until an item-group is supplied.
//   TODO: wire item-group + attribute pickers when the Houzs product layer lands.
// ----------------------------------------------------------------------------

export type InventoryItemGroup =
  | 'sofa'
  | 'bedframe'
  | 'mattress'
  | 'accessory'
  | 'others'
  | 'service';

/** Loose attribute bag — callers map a SO/PO/GRN line onto this shape. */
export type VariantAttrs = {
  fabricCode?: string | null;
  /** Aliases for the SAME physical attribute (the fabric). */
  colorCode?: string | null;
  colourCode?: string | null;
  fabricColor?: string | null;
  seatHeight?: string | null; // sofa
  depth?: string | null; // sofa (POS vocabulary for seatHeight)
  gap?: string | null; // bedframe
  divanHeight?: string | null; // bedframe
  legHeight?: string | null; // sofa + bedframe
  sofaLegHeight?: string | null; // sofa (POS vocabulary for legHeight)
  totalHeight?: string | null; // bedframe (derived from divan+leg+gap)
  /** Special-order config — labels/specs that change the physical item.
   *  Accepts strings or {code|label} objects; order-independent. */
  specials?: Array<string | { code?: string | null; label?: string | null }> | null;
};

/** Which physical attributes count toward identity, per category, in a fixed
 *  order so the key is deterministic. Specials are appended for every group. */
const ATTRS_BY_GROUP: Record<string, Array<keyof VariantAttrs>> = {
  sofa: ['fabricCode', 'seatHeight', 'legHeight'],
  bedframe: ['fabricCode', 'gap', 'divanHeight', 'legHeight', 'totalHeight'],
  mattress: [],
  accessory: [],
  others: [],
  service: [],
};

const norm = (v: unknown): string => (v == null ? '' : String(v).trim().toLowerCase());

/** Specials → a normalized, order-independent, comma-joined string. */
const normSpecials = (specials: VariantAttrs['specials']): string => {
  if (!Array.isArray(specials) || specials.length === 0) return '';
  return specials
    .map((s) => (typeof s === 'string' ? s : (s?.code ?? s?.label ?? '')))
    .map(norm)
    .filter(Boolean)
    .sort()
    .join(',');
};

/**
 * Compute the canonical variant key for an inventory line.
 *
 * Deterministic: attributes are emitted in a fixed per-category order, empty
 * values are dropped, and specials are sorted. Identical attribute sets always
 * yield an identical string. Returns '' when nothing meaningful is set
 * (legacy / unclassified bucket).
 */
export function computeVariantKey(
  itemGroup: string | null | undefined,
  attrs: VariantAttrs | null | undefined,
): string {
  const group = norm(itemGroup);
  const a = attrs ?? {};
  const parts: string[] = [];

  for (const k of ATTRS_BY_GROUP[group] ?? []) {
    const raw = k === 'fabricCode'
      ? (a.fabricCode ?? a.colorCode ?? a.colourCode ?? a.fabricColor)
      : k === 'seatHeight'
        ? (a.seatHeight ?? a.depth)
        : k === 'legHeight'
          ? (a.legHeight ?? a.sofaLegHeight)
          : (a[k] as unknown);
    const val = norm(raw);
    if (val) parts.push(`${k.toLowerCase()}=${val}`);
  }

  const sp = normSpecials(a.specials);
  if (sp) parts.push(`special=${sp}`);

  return parts.join('|');
}

/** Human-readable labels for the canonical key's attribute slugs. */
const VARIANT_LABELS: Record<string, string> = {
  fabriccode: 'Fabric',
  seatheight: 'Seat',
  gap: 'Gap',
  divanheight: 'Divan',
  legheight: 'Leg',
  totalheight: 'Total H',
  special: 'Special',
};

/**
 * Turn a canonical variant key into a readable label for the UI, e.g.
 * "fabriccode=bf-16|gap=16|legheight=2" -> "Fabric BF-16 · Gap 16 · Leg 2".
 * Empty / unclassified -> '' (caller decides how to show it, e.g. "Standard").
 */
export function formatVariantKey(key: string | null | undefined): string {
  if (!key) return '';
  return key
    .split('|')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return part;
      const slug = part.slice(0, eq);
      const value = part.slice(eq + 1);
      const label = VARIANT_LABELS[slug] ?? slug;
      return `${label} ${slug === 'fabriccode' ? value.toUpperCase() : value}`;
    })
    .join(' · ');
}
