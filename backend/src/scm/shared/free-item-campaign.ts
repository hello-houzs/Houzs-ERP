// Free Item Campaign (standalone giveaway, no qualifying purchase). Pure,
// shared by the POS cart "Make free" button and the server SO validator so the
// two NEVER drift (honest-pricing). A campaign lists eligible Models; a sofa
// entry may pin a specific combo (scope 'combo'). See
// docs/superpowers/specs/2026-06-17-free-item-campaign-design.md.
import { matchComboSubset } from './sofa-combo-pricing';
import { normalizeCompartmentCode } from './sofa-build';

export interface FreeItemEligibility {
  /** product_models.id. */
  modelId: string;
  /** 'model' = any build of the Model; 'combo' = only the pinned combo build. */
  scope: 'model' | 'combo';
  /** sofa_combo_pricing.id, required iff scope === 'combo'. */
  comboId: string | null;
}

export interface FreeItemCampaign {
  id: string;
  name: string;
  active: boolean;
  /** per-line max free units (>= 1). */
  maxFreeQty: number;
  eligible: FreeItemEligibility[];
}

/** One cart/order line flattened to what the matcher needs. */
export interface FreeItemLineInput {
  /** SOFA / MATTRESS / BEDFRAME / ACCESSORY (case-insensitive). */
  category: string;
  /** product_models.id of the line's Model (null = no match possible). */
  modelId: string | null;
  /** sofa build module codes (normalized later); [] for non-sofa. */
  builtModuleIds: string[];
}

/** Coerce raw jsonb into clean FreeItemEligibility[] (drops malformed entries;
 *  a 'combo' entry without a comboId is dropped). */
export function parseFreeItemEligible(raw: unknown): FreeItemEligibility[] {
  if (!Array.isArray(raw)) return [];
  const out: FreeItemEligibility[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const modelId = typeof r.modelId === 'string' ? r.modelId.trim() : '';
    if (!modelId) continue;
    const scope = r.scope === 'combo' ? 'combo' : 'model';
    const comboId = typeof r.comboId === 'string' && r.comboId.trim() !== '' ? r.comboId.trim() : null;
    if (scope === 'combo' && !comboId) continue;   // a combo entry must pin a combo
    out.push({ modelId, scope, comboId });
  }
  return out;
}

/** A persisted line carries a free-item marker iff variants.freeItem.campaignId is set. */
export function isFreeItemLine(variants: unknown): boolean {
  const v = variants as { freeItem?: { campaignId?: unknown } } | null;
  return Boolean(v?.freeItem && typeof v.freeItem === 'object' && v.freeItem.campaignId);
}

/** Every ACTIVE campaign that covers this line. Non-sofa / sofa 'model' match by
 *  modelId; sofa 'combo' matches only when the built modules cover the combo's
 *  slots (matchComboSubset). Returns all covering campaigns so the cart can let
 *  the salesperson pick (D4). */
export function campaignsCoveringLine(
  line: FreeItemLineInput,
  campaigns: FreeItemCampaign[],
  comboModulesById: Map<string, string[][]>,
): FreeItemCampaign[] {
  if (!line.modelId) return [];
  const isSofa = String(line.category ?? '').toUpperCase() === 'SOFA';
  const built = isSofa ? line.builtModuleIds.map((m) => normalizeCompartmentCode(m)) : [];
  const out: FreeItemCampaign[] = [];
  for (const c of campaigns) {
    if (!c.active) continue;
    const covered = c.eligible.some((e) => {
      if (e.modelId !== line.modelId) return false;
      if (e.scope === 'model') return true;
      if (!isSofa || !e.comboId) return false;
      const slots = comboModulesById.get(e.comboId);
      if (!slots) return false;                    // combo deleted / unknown → not covered
      return matchComboSubset(built, slots) !== null;
    });
    if (covered) out.push(c);
  }
  return out;
}
