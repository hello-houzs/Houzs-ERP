// ----------------------------------------------------------------------------
// PO line pricing — supplier-scoped maintenance config resolver.
//
// Commander 2026-05-27: "我开 PO 的时候, 我的 SKU 那边就会有它的 base price,
// 然后它又有 Maintenance 给我 set 它的价钱, 所以我们开的 PO 全部就会有
// 准的价钱了". The 3 surcharge types (divan / leg / specials) must read
// from the supplier's own maintenance_config_history row when one exists,
// and fall back to the master row when it doesn't.
//
// Read path:
//   1. Try scope = 'supplier:<id>' — newest effective_from <= today, limit 1
//   2. If empty → fall back to scope = 'master'
//   3. If both empty → return null (caller falls back to base price only)
//
// Write path is unchanged — `POST /maintenance-config/changes` already
// accepts any parsed scope (see routes/maintenance-config.ts §parseScope).
//
// ----------------------------------------------------------------------------

import type { MaintenanceConfig } from '../shared/mfg-pricing';
import { todayMyt } from './my-time';

const todayIso = () => todayMyt();

/** Internal: load the most-recent config row for a given scope at asOf. */
async function loadConfigForScope(
  sb: any,
  scope: string,
  asOf: string,
): Promise<MaintenanceConfig | null> {
  const { data } = await sb
    .from('maintenance_config_history')
    .select('config')
    .eq('scope', scope)
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const cfg = (data as { config?: unknown } | null)?.config;
  return (cfg as MaintenanceConfig | null) ?? null;
}

/**
 * Resolve the maintenance config to use for a PO line keyed by supplierId.
 *
 * Returns the supplier's own config when one exists at the asOf date, else
 * the master config. Returns null only when neither exists (commander hasn't
 * seeded the master baseline either).
 *
 * Used by the PO pricing path (both client-side preview and server-side
 * recompute). The shape returned matches what `computeMfgLinePrice` accepts
 * directly — no projection needed.
 */
export async function resolveMaintenanceConfigForSupplier(
  sb: any,
  supplierId: string | null | undefined,
  asOf: string = todayIso(),
): Promise<{ config: MaintenanceConfig | null; scope: 'supplier' | 'master' | null }> {
  if (supplierId) {
    const supplierCfg = await loadConfigForScope(sb, `supplier:${supplierId}`, asOf);
    if (supplierCfg) return { config: supplierCfg, scope: 'supplier' };
  }
  const masterCfg = await loadConfigForScope(sb, 'master', asOf);
  if (masterCfg) return { config: masterCfg, scope: 'master' };
  return { config: null, scope: null };
}
