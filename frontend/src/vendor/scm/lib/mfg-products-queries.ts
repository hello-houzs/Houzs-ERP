// Vendored SLICE of apps/backend/src/lib/mfg-products-queries.ts — only the
// MaintenanceConfig read that SupplyCategoryPicker needs. The real module is
// ~900 lines (products CRUD, models, fabrics, special add-ons, …); none of
// that is pulled in by the Suppliers slice. `useMaintenanceConfig` is copied
// verbatim (same query key, same /maintenance-config/resolved endpoint — now
// served under /api/scm via the repointed authedFetch). The MaintenanceConfig
// type is reduced to the one field the picker reads (`supplierCategories`);
// extend it as later pages need more.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';
import { verifiedSave, readbackGet, friendlySaveMessage } from './verified-save';
import type { MaintPoolEntry } from '@2990s/shared';
import type {
  MaintenanceConfig as MfgMaintenanceConfig,
  MfgPricedOption,
  MfgFabricTier,
} from '@2990s/shared/mfg-pricing';

/* HOUZS VENDOR — Products wave. The Maintenance editor reads/writes priced
   pool options ({ value, priceSen, costSen?, sellingPriceSen?, active? }). The
   source module's `PricedOption` is byte-identical to mfg-pricing's
   `MfgPricedOption` (the type the rich MaintenanceConfig fields already use),
   so re-export it under the source name the page imports. */
export type PricedOption = MfgPricedOption;

/* HOUZS VENDOR — Products wave. Sofa price tier (PRICE_1/2/3); identical to
   mfg-pricing's MfgFabricTier. SeatHeightPrice already carries `tier?:
   MfgFabricTier` below; the page imports SofaPriceTier by name. */
export type SofaPriceTier = MfgFabricTier;

// HOUZS VENDOR NOTE: the Suppliers slice reduced MaintenanceConfig to just
// `supplierCategories` (all SupplyCategoryPicker reads). The PO New form feeds
// the SAME resolved config into computeMfgPoUnitCost (from @2990s/shared/
// mfg-pricing), which needs the RICH shape (divanHeights / legHeights / gaps /
// sofaSizes / …). So the vendored type now INTERSECTS the rich pricing-engine
// MaintenanceConfig with the supplier-categories field, keeping both consumers
// type-safe (and matching the source module, where the full shape carries
// supplierCategories too). An index signature was dropped — it would have
// widened every rich field back to `unknown` and broken the engine call.
export type MaintenanceConfig = MfgMaintenanceConfig & {
  supplierCategories?: MaintPoolEntry[]; // ['Sofa','Bedframe','Mattress',...]
  // HOUZS VENDOR — ProductModels wave. The Model list + detail pages read the
  // rich product-model maintenance pools (size/compartment pools, branding,
  // SKU code/name format templates, size-label overrides). Mirrored verbatim
  // from the source MaintenanceConfig (apps/backend/src/lib/mfg-products-
  // queries.ts), all optional on the wire.
  bedframeSizes?:    MaintPoolEntry[];
  sofaCompartments?: MaintPoolEntry[];
  mattressSizes?:    MaintPoolEntry[];
  brandings?:        MaintPoolEntry[];
  sofaCompartmentMeta?: Record<string, {
    imageKey?: string;
    description?: string;
    defaultPriceCenti?: number;
  }>;
  sofaQuickPresets?: {
    id: string;
    label: string;
    modules: string[];
    sortOrder?: number;
    active?: boolean;
    defaultTier?: SofaPriceTier;
  }[];
  sizeLabels?: Record<string, { label?: string; dimensions?: string }>;
  bedframeCodeFormat?: string;
  bedframeNameFormat?: string;
  sofaCodeFormat?:     string;
  sofaNameFormat?:     string;
  mattressCodeFormat?: string;
  mattressNameFormat?: string;
};

// HOUZS VENDOR — Products wave. The Maintenance tab's effective-date drawer
// reads effectiveFrom / hasPendingPriceChange / pendingEffectiveFrom off the
// resolved row, so the shape now mirrors the source MaintenanceResolved
// (apps/backend/src/lib/mfg-products-queries.ts). No vendored consumer read the
// earlier guessed `scope`/`source` fields, so dropping them is safe.
export type MaintenanceResolved = {
  data: MaintenanceConfig | null;
  effectiveFrom: string | null;
  hasPendingPriceChange: boolean;
  pendingEffectiveFrom: string | null;
};

export type MaintenanceHistoryRow = {
  id: string;
  scope: string;
  config: MaintenanceConfig;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  createdBy: string | null;
  isPending: boolean;
};

/**
 * Maintenance config resolved at the given scope.
 *
 * PR #208 — accepts an `opts.enabled` flag so callers can defer the fetch
 * (e.g. PO pages waiting for the supplier id before scoping the query, or
 * the supplier-pricing tab fetching the master fallback only when the
 * supplier scope is empty). Defaults to enabled when `scope` is truthy.
 */
export function useMaintenanceConfig(
  scope = 'master',
  opts?: { enabled?: boolean },
) {
  const enabled = opts?.enabled ?? Boolean(scope);
  return useQuery({
    queryKey: ['maintenance-config', 'resolved', scope],
    queryFn: () =>
      authedFetch<MaintenanceResolved>(`/maintenance-config/resolved?scope=${encodeURIComponent(scope)}`),
    enabled,
    staleTime: 60_000,
    // See useMfgProducts comment — settle errors fast for the migration-pending case.
    retry: 1,
    retryDelay: 800,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   HOUZS VENDOR — PO-page additions. The PO New form needs the SKU catalogue
   (useMfgProducts) + the Special Add-ons pool (useSpecialAddons). Copied from
   apps/backend/src/lib/mfg-products-queries.ts; MfgProductRow is reduced to the
   fields the PO form reads (id/code/name/category). Both call the vendored
   authedFetch (→ /api/scm). The source module also pulls in verified-save /
   supabase / humanApiError for its CRUD mutations — none of that is needed for
   these two read hooks, so it is intentionally left out.
   ═══════════════════════════════════════════════════════════════════════════ */

export type MfgCategory = 'BEDFRAME' | 'SOFA' | 'ACCESSORY' | 'MATTRESS' | 'SERVICE';

/** MfgProductRow — the PO New form only reads id/code/name/category off each
    SKU. The ProductModels wave reads a few more SKU columns (size_code for the
    supplier-sku suffix, model_id to group SKUs under a Model, base_price_sen /
    branding for the Model list summary). All extras are OPTIONAL so the PO-page
    callers stay unaffected. The full source row carries ~30 columns the
    vendored pages never touch. */
export type MfgProductRow = {
  id: string;
  code: string;
  name: string;
  category: MfgCategory;
  size_code?: string | null;
  size_label?: string | null;
  // HOUZS VENDOR — Products wave. These four are REQUIRED in the source row and
  // the SKU Master grid treats them as non-optional (price math + status badge),
  // so they match the source shape. The /mfg-products endpoint always returns
  // them; no vendored caller constructs a partial MfgProductRow literal (the
  // ProductModels seeder uses a `Pick<…, 'code'|'category'|'size_code'>`), so
  // promoting them to required is safe for the PO / SO / ProductModels callers.
  base_price_sen: number | null;
  price1_sen: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  branding?: string | null;
  model_id?: string | null;
  // HOUZS VENDOR — SO line editor (SoLineCard) additions. The SKU picker
  // defaults the selling unit price from sell_price_sen, prices sofa seat
  // heights off seat_height_prices, and filters variant dropdowns by the
  // picked Model's allowed_options. All optional so the PO-page + ProductModels
  // callers stay unaffected.
  sell_price_sen?: number | null;
  seat_height_prices?: SeatHeightPrice[] | null;
  allowed_options?: ModelAllowedOptions | null;
  // HOUZS VENDOR — Products wave (SkuMasterTab). The SKU Master grid + New SKU
  // drawer + CSV round-trip read the rest of the source row. unit_m3_milli is
  // required in the source (the grid sorts on it); the rest are optional.
  description?: string | null;
  base_model?: string | null;
  pwp_price_sen?: number | null;
  unit_m3_milli: number;
  sku_code?: string | null;
  barcode?: string | null;
  sub_assemblies?: unknown;
  pieces?: unknown;
  default_variants?: unknown;
  updated_at?: string;
  one_shot?: boolean;
  source_doc_no?: string | null;
};

/** Sofa-only seat-height price row off the SKU's seat_height_prices JSONB.
 *  `tier` matches the source (optional; a missing tier means a legacy row,
 *  treated as PRICE_2 by the pricing engine). */
export type SeatHeightPrice = { height: string; priceSen: number; tier?: MfgFabricTier };

/** The Model's Modular (allowed_options) pools — single ON/OFF authority for
 *  what a SKU may sell with. `fabrics` holds fabric COLOUR codes. */
export type ModelAllowedOptions = {
  sizes?: string[] | null;
  compartments?: string[] | null;
  divan_heights?: string[] | null;
  total_heights?: string[] | null;
  leg_heights?: string[] | null;
  gaps?: string[] | null;
  fabrics?: string[] | null;
  specials?: string[] | null;
};

export function useMfgProducts(opts?: {
  category?: MfgCategory;
  search?: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['mfg-products', opts?.category ?? 'all', opts?.search ?? ''],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.category) params.set('category', opts.category);
      if (opts?.search) params.set('search', opts.search);
      const res = await authedFetch<{ products: MfgProductRow[] }>(
        `/mfg-products${params.toString() ? `?${params.toString()}` : ''}`,
      );
      return res.products;
    },
    enabled: opts?.enabled ?? true,
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

/* ─── Special Add-ons (migration 0134) — SO-parity read (Loo 2026-06-06).
   The SO/PO line editor's Specials accordion reads THESE (the same
   GET /special-addons the POS uses) instead of legacy maintenance_config
   string pools. Shapes mirror apps/pos/src/lib/queries.ts. */
export interface SpecialAddonChoice { label: string; extraSen: number; }
export interface SpecialAddonGroup { label: string; required: boolean; choices: SpecialAddonChoice[]; }
export interface SpecialAddonRow {
  id: string;
  code: string;
  label: string;
  soDescription: string;
  categories: string[];          // UPPERCASE mfg categories, e.g. ['BEDFRAME']
  sellingPriceSen: number;
  costPriceSen: number;
  optionGroups: SpecialAddonGroup[];
  active: boolean;
  sortOrder: number;
}

export const useSpecialAddons = () =>
  useQuery({
    queryKey: ['special-addons'],
    staleTime: 60_000,
    queryFn: async (): Promise<SpecialAddonRow[]> => {
      const body = await authedFetch<{ addons: SpecialAddonRow[] }>('/special-addons');
      return body.addons ?? [];
    },
  });

/* HOUZS VENDOR — ProductModels wave. The Model Detail page flips a SKU's
   ACTIVE/INACTIVE status from the SKU table. Copied verbatim from
   apps/backend/src/lib/mfg-products-queries.ts (PATCH /mfg-products/:id). */
export function useUpdateMfgProductStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; status: 'ACTIVE' | 'INACTIVE' }) => {
      const { id, status } = args;
      return authedFetch<{ ok: boolean; changed: number }>(`/mfg-products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
      qc.invalidateQueries({ queryKey: ['product-models'] });
    },
  });
}

/* HOUZS VENDOR — SO line editor (SoLineCard) read. The source
   useModelAllowedOptionsByCode resolves a saved line's allowed_options pools
   via a DIRECT supabase join (mfg_products → product_models.allowed_options),
   which the vendored layer has no supabase client for. It returns null here, so
   the SO variant dropdowns render UNRESTRICTED (no pool filter) for saved lines
   — the exact verbatim fallback the source already takes for legacy/unknown
   codes. Freshly-picked products still carry allowed_options inline off
   useMfgProducts, so that path is unaffected. When a Houzs /api/scm endpoint
   exposes a SKU's Model allowed_options, swap this to an authedFetch read. */
export const useModelAllowedOptionsByCode = (itemCode: string | undefined) =>
  useQuery({
    enabled: Boolean(itemCode),
    queryKey: ['model-allowed-options-by-code', itemCode],
    staleTime: 60_000,
    queryFn: async (): Promise<ModelAllowedOptions | null> => null,
  });

/* ════════════════════════════════════════════════════════════════════════════
   HOUZS VENDOR — Products wave. Everything below was copied verbatim from
   apps/backend/src/lib/mfg-products-queries.ts so the Products page (SKU Master
   + Maintenance) and SpecialAddonsTab compile + work. The only deviations:
     • useUpdateMfgProductPrices routes verified-save through the vendored
       verified-save (localStorage token, /api/scm base) — see verified-save.ts.
     • The `addons` (Order Add-ons) hooks in the source hit a supabase `addons`
       table directly; the vendor layer has no supabase client and there is no
       /api/scm addons endpoint, so they are STUBBED (read = empty, write =
       friendly "not enabled" notify). FLAG: to light up Order Add-ons, add an
       /api/scm/addons route + swap these stubs for authedFetch reads/writes.
   ════════════════════════════════════════════════════════════════════════════ */

export function useUpdateMfgProductPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      basePriceSen?: number | null;
      price1Sen?: number | null;
      costPriceSen?: number | null;
      seatHeightPrices?: SeatHeightPrice[];
      branding?: string | null;
      barcode?: string | null;
      subAssemblies?: string[];
      pieces?: { count: number; names: string[] } | null;
      defaultVariants?: Record<string, unknown>;
      notes?: string;
      code?: string;
      name?: string;
    }) => {
      const { id, ...body } = args;
      // verified-save: a price PATCH that returns 200 can still LIE (half-write /
      // stale cache), so read the row back (cache-bypassing) and confirm the
      // price actually changed before reporting success.
      const expect: Record<string, unknown> = {};
      if (body.basePriceSen !== undefined) expect.base_price_sen = body.basePriceSen;
      if (body.price1Sen    !== undefined) expect.price1_sen     = body.price1Sen;
      if (body.costPriceSen !== undefined) expect.cost_price_sen = body.costPriceSen;
      if (body.barcode      !== undefined) expect.barcode        = body.barcode;

      const result = await verifiedSave<{ product: Record<string, unknown> }>({
        endpoint: `/mfg-products/${id}`,
        method: 'PATCH',
        body,
        readback: () => readbackGet<{ product: Record<string, unknown> }>(`/mfg-products/${id}`),
        expect,
        accessor: (d, f) => d?.product?.[f],
      });

      if (!result.ok) {
        throw new Error(friendlySaveMessage(result, {
          noun: 'price',
          fieldNames: { base_price_sen: 'Base price', price1_sen: 'Price 1', cost_price_sen: 'Cost price' },
          fmt: (v) => (v == null ? '(blank)' : `RM${(Number(v) / 100).toFixed(2)}`),
        }));
      }
      return { ok: true as const, changed: 1 };
    },
    onError: (err) => {
      serviceNotify({ title: 'Save failed', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

export type MasterPriceHistoryRow = {
  id: string;
  product_code: string;
  field: string;
  old_value_sen: number | null;
  new_value_sen: number | null;
  reason: string | null;
  changed_at: string;
  changed_by: string | null;
};

export function useMfgProductPriceHistory(id: string | null) {
  return useQuery({
    queryKey: ['mfg-product-price-history', id],
    queryFn: () => authedFetch<{ history: MasterPriceHistoryRow[] }>(`/mfg-products/${id}/price-history`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/* PR #38 — Suppliers carrying a given product (via supplier_material_bindings). */
export type ProductSupplierRow = {
  id: string;
  supplier_id: string;
  supplier_sku: string;
  unit_price_centi: number;
  currency: string;
  lead_time_days: number;
  moq: number;
  is_main_supplier: boolean;
  notes: string | null;
  suppliers: {
    code: string;
    name: string;
    phone: string | null;
  } | null;
};
export function useMfgProductSuppliers(id: string | null) {
  return useQuery({
    queryKey: ['mfg-product-suppliers', id],
    queryFn: () => authedFetch<{
      product: { code: string; name: string; category: string };
      suppliers: ProductSupplierRow[];
    }>(`/mfg-products/${id}/suppliers`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** Body shape for POST /mfg-products. id + status default server-side. */
export type NewMfgProductInput = {
  code: string;
  name: string;
  category: MfgCategory;
  description?: string;
  baseModel?: string;
  sizeCode?: string;
  sizeLabel?: string;
  basePriceSen?: number | null;
  price1Sen?: number | null;
  costPriceSen?: number | null;
  unitM3Milli?: number;
  fabricUsageCenti?: number;
  productionTimeMinutes?: number;
  branding?: string;
  fabricColor?: string;
  barcode?: string;
};

export function useCreateMfgProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewMfgProductInput) =>
      authedFetch<{ id: string; code: string }>(`/mfg-products`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

/* CSV round-trip import — bulk upsert by code. */
export type BatchImportRow = {
  code: string;
  name: string;
  category: string;
  description?: string;
  base_model?: string;
  size_label?: string;
  status?: string;
  branding?: string;
  base_price_sen?: number;
  price1_sen?: number;
  unit_m3_milli?: number;
  seatHeightPrices?: SeatHeightPrice[];
};

export type BatchImportResult = {
  upserted: number;
  failed: number;
  failures: Array<{ code: string; reason: string }>;
};

export function useBatchImportMfgProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: BatchImportRow[]) =>
      authedFetch<BatchImportResult>(`/mfg-products/batch-import`, {
        method: 'POST',
        body: JSON.stringify({ rows }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

export function useDeleteMfgProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: string | { id: string; force?: boolean }) => {
      const id    = typeof args === 'string' ? args : args.id;
      const force = typeof args === 'string' ? false : !!args.force;
      const qs    = force ? '?force=true' : '';
      return authedFetch<void>(`/mfg-products/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

export function useMaintenanceConfigHistory(scope = 'master') {
  return useQuery({
    queryKey: ['maintenance-config', 'history', scope],
    queryFn: () =>
      authedFetch<{ history: MaintenanceHistoryRow[] }>(
        `/maintenance-config/history?scope=${encodeURIComponent(scope)}`,
      ),
    staleTime: 30_000,
  });
}

/* ─── Special Add-ons CRUD — same /special-addons Worker routes the read hook
   above uses, so POS and Backend write the one shared table. */
export interface SpecialAddonInput {
  code: string;
  label: string;
  soDescription: string;
  categories: string[];
  sellingPriceSen: number;
  costPriceSen: number;
  optionGroups: SpecialAddonGroup[];
  active: boolean;
  sortOrder: number;
}

export const useCreateSpecialAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SpecialAddonInput) =>
      authedFetch<{ id: string }>('/special-addons', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['special-addons'] }); },
  });
};

export const useUpdateSpecialAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<SpecialAddonInput> }) =>
      authedFetch<void>(`/special-addons/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['special-addons'] }); },
  });
};

export const useDeleteSpecialAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<void>(`/special-addons/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['special-addons'] }); },
  });
};

/**
 * Maintenance-is-master cascade rename — renames a sofa compartment code text
 * ATOMICALLY across the whole stack. Backed by the rename_sofa_compartment()
 * SECURITY DEFINER function; admin only.
 */
export function useRenameSofaCompartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { from: string; to: string }) => {
      return authedFetch<{ ok: boolean; result: unknown }>(
        `/maintenance-config/sofa-compartments/rename`,
        { method: 'POST', body: JSON.stringify(args) },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
      qc.invalidateQueries({ queryKey: ['product-models'] });
      qc.invalidateQueries({ queryKey: ['sofa-combos'] });
    },
  });
}

export function useSaveMaintenanceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      scope: string;
      config: MaintenanceConfig;
      effectiveFrom: string;
      notes?: string;
    }) => {
      return authedFetch<{
        id: string;
        scope: string;
        config: MaintenanceConfig;
        effectiveFrom: string;
        notes: string;
      }>(`/maintenance-config/changes`, {
        method: 'POST',
        body: JSON.stringify(args),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
    },
  });
}

/* ─── Sofa Compartment photo upload / delete. Multipart POST — never set
   content-type by hand (fetch picks the FormData boundary; authedFetch only
   stamps content-type for string bodies, so FormData slips past correctly). */
export function useUploadSofaCompartmentPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, file }: { code: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      return authedFetch<{ photoUrl: string; photoKey: string }>(
        `/maintenance-config/sofa-compartments/${encodeURIComponent(code)}/photo`,
        { method: 'POST', body: fd },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
    },
  });
}

export function useDeleteSofaCompartmentPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      return authedFetch<{ ok: true }>(
        `/maintenance-config/sofa-compartments/${encodeURIComponent(code)}/photo`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
    },
  });
}

/* ─── Order Add-ons (whole-order one-time fees: Dispose, Lift) — STUBBED.
   The source reads/writes the supabase `addons` table directly under RLS; the
   vendor layer has no supabase client and there is no /api/scm addons endpoint.
   The read hook returns an empty list (the Order Add-ons grid shows its empty
   state) and the write hooks raise a friendly in-app notify instead of a 裸奔
   error. FLAG: add /api/scm/addons + swap these for authedFetch to enable. */
export interface AdminAddonRow {
  id: string;
  label: string;
  description: string | null;
  icon: string;
  kind: 'qty' | 'floors_items' | 'flat';
  category: string | null;
  price: number;
  perFloorItem: number | null;
  unit: string | null;
  defaultQty: number;
  stock: number | null;
  enabled: boolean;
  showAtHandover: boolean;
  serviceSku: string | null;
  sortOrder: number;
}

const ORDER_ADDONS_UNAVAILABLE =
  'Order Add-ons are not enabled in this build yet. (No /api/scm addons endpoint is wired for the SCM module.)';

export const useAllAddons = () =>
  useQuery({
    queryKey: ['addons-all'],
    staleTime: 60_000,
    queryFn: async (): Promise<AdminAddonRow[]> => [],
  });

export const useUpdateAddon = () =>
  useMutation({
    mutationFn: async (_args: { id: string; patch: { price?: number; perFloorItem?: number | null; enabled?: boolean; showAtHandover?: boolean; serviceSku?: string | null } }): Promise<void> => {
      await serviceNotify({ title: 'Not available', body: ORDER_ADDONS_UNAVAILABLE, tone: 'error' });
      throw new Error(ORDER_ADDONS_UNAVAILABLE);
    },
  });

export const useCreateAddon = () =>
  useMutation({
    mutationFn: async (_row: {
      id: string; label: string; description: string | null; icon: string;
      kind: 'qty' | 'floors_items' | 'flat'; category: string | null;
      price: number; perFloorItem: number | null; unit: string | null;
      stock: number | null; enabled: boolean; showAtHandover: boolean;
      serviceSku: string | null; sortOrder: number;
    }): Promise<void> => {
      await serviceNotify({ title: 'Not available', body: ORDER_ADDONS_UNAVAILABLE, tone: 'error' });
      throw new Error(ORDER_ADDONS_UNAVAILABLE);
    },
  });

export const useDeleteAddon = () =>
  useMutation({
    mutationFn: async (_id: string): Promise<void> => {
      await serviceNotify({ title: 'Not available', body: ORDER_ADDONS_UNAVAILABLE, tone: 'error' });
      throw new Error(ORDER_ADDONS_UNAVAILABLE);
    },
  });
