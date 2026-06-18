// ----------------------------------------------------------------------------
// Products & Maintenance query hooks + types — for the cloned routes
// (/api/products, /api/categories, /api/product-models, /api/mfg-products,
// /api/fabric-tracking, /api/fabric-library, /api/fabric-tier-addon,
// /api/maintenance-config, /api/pwp-rules, /api/sofa-combos).
//
// The wire SHAPES match the cloned routes exactly (rule #7). SEAMS: 2990s
// authedFetch + Supabase JS -> Houzs `api` client (frontend/src/api/client.ts)
// + @tanstack/react-query (rule #7).
//
// This is the FULL furniture catalogue (NOT Strategy-2-stripped) — the owner
// wants the whole module cloned; the pages surface the manufacturer SKU master,
// product Models, the Fabric Converter, and the Maintenance config editors.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

export type MfgCategory = "SOFA" | "BEDFRAME" | "ACCESSORY" | "MATTRESS" | "SERVICE";

// ── Categories ─────────────────────────────────────────────────────────
export type CategoryRow = {
  id: string;
  label: string;
  icon: string;
  tbc: boolean;
  hero_image_key: string | null;
  sort_order: number;
};
export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<{ categories: CategoryRow[] }>("/api/categories").then((r) => r.categories),
  });
}

// ── mfg_products (manufacturer SKU master) ─────────────────────────────
export type MfgProductRow = {
  id: string;
  code: string;
  name: string;
  category: MfgCategory;
  description: string | null;
  base_model: string | null;
  size_code: string | null;
  size_label: string | null;
  base_price_sen: number | null;
  price1_sen: number | null;
  sell_price_sen: number | null;
  pwp_price_sen: number | null;
  unit_m3_milli: number | null;
  status: "ACTIVE" | "INACTIVE";
  pos_active: boolean;
  one_shot: boolean;
  source_doc_no: string | null;
  sku_code: string | null;
  model_id: string | null;
  branding: string | null;
  barcode: string | null;
  updated_at: string | null;
  allowed_options: unknown;
};

export function useMfgProducts(opts: { category?: string; search?: string } = {}) {
  const qs = new URLSearchParams();
  if (opts.category) qs.set("category", opts.category);
  if (opts.search) qs.set("search", opts.search);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery({
    queryKey: ["mfg-products", opts.category ?? "", opts.search ?? ""],
    queryFn: () => api.get<{ products: MfgProductRow[] }>(`/api/mfg-products${suffix}`).then((r) => r.products),
  });
}

export type MfgProductPatch = {
  basePriceSen?: number | null;
  price1Sen?: number | null;
  costPriceSen?: number | null;
  sellPriceSen?: number | null;
  pwpPriceSen?: number | null;
  status?: "ACTIVE" | "INACTIVE";
  posActive?: boolean;
  code?: string;
  name?: string;
  barcode?: string | null;
  branding?: string | null;
  notes?: string;
};

export function usePatchMfgProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MfgProductPatch }) =>
      api.patch<{ ok: boolean; changed: number }>(`/api/mfg-products/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mfg-products"] }),
  });
}

export function useCreateMfgProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name: string; category: MfgCategory; description?: string; baseModel?: string; sizeCode?: string; sizeLabel?: string; basePriceSen?: number; price1Sen?: number; costPriceSen?: number; barcode?: string; branding?: string }) =>
      api.post<{ id: string; code: string }>("/api/mfg-products", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mfg-products"] }),
  });
}

export function useDeleteMfgProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.del<void>(`/api/mfg-products/${id}${force ? "?force=true" : ""}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mfg-products"] }),
  });
}

export type PriceHistoryRow = {
  id: string;
  product_code: string;
  field: string;
  old_value_sen: number | null;
  new_value_sen: number | null;
  reason: string | null;
  changed_at: string;
  changed_by: number | null;
};
export function useMfgPriceHistory(id: string | null) {
  return useQuery({
    queryKey: ["mfg-price-history", id],
    enabled: !!id,
    queryFn: () => api.get<{ history: PriceHistoryRow[] }>(`/api/mfg-products/${id}/price-history`).then((r) => r.history),
  });
}

// ── product_models ─────────────────────────────────────────────────────
export type ProductModelRow = {
  id: string;
  branding: string | null;
  model_code: string;
  name: string;
  category: MfgCategory;
  description: string | null;
  photo_url: string | null;
  allowed_options: Record<string, unknown>;
  active: boolean;
  created_at: string | null;
  updated_at: string | null;
};
export type ModelSku = {
  id: string;
  code: string;
  name: string;
  size_code: string | null;
  size_label: string | null;
  status: "ACTIVE" | "INACTIVE";
  base_price_sen: number | null;
  price1_sen: number | null;
  cost_price_sen: number | null;
  unit_m3_milli: number | null;
  pos_active: boolean;
  one_shot: boolean;
  source_doc_no: string | null;
};

export function useProductModels(category?: string) {
  const suffix = category ? `?category=${encodeURIComponent(category)}` : "";
  return useQuery({
    queryKey: ["product-models", category ?? ""],
    queryFn: () => api.get<{ models: ProductModelRow[] }>(`/api/product-models${suffix}`).then((r) => r.models),
  });
}

export function useProductModel(id: string | null) {
  return useQuery({
    queryKey: ["product-model", id],
    enabled: !!id,
    queryFn: () => api.get<{ model: ProductModelRow; skus: ModelSku[] }>(`/api/product-models/${id}`),
  });
}

export function useCreateProductModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { branding?: string | null; modelCode: string; name: string; category: MfgCategory; description?: string | null }) =>
      api.post<{ model: ProductModelRow }>("/api/product-models", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-models"] }),
  });
}

export function usePatchProductModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.patch<{ model: ProductModelRow; autoCreatedSkus: string[] }>(`/api/product-models/${id}`, patch),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      qc.invalidateQueries({ queryKey: ["product-model", v.id] });
    },
  });
}

export function useGenerateSkus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post<{ generated: number; skipped: number; codes?: string[] }>(`/api/product-models/${id}/generate-skus`, {}),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["product-model", v.id] });
      qc.invalidateQueries({ queryKey: ["mfg-products"] });
    },
  });
}

export function useDeleteProductModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.del<{ ok: boolean }>(`/api/product-models/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-models"] }),
  });
}

// ── fabric_trackings (Fabric Converter) ─────────────────────────────────
export type FabricTier = "PRICE_1" | "PRICE_2" | "PRICE_3";
export type FabricRow = {
  id: string;
  fabric_code: string;
  fabric_description: string | null;
  fabric_category: string | null;
  price_tier: FabricTier | null;
  sofa_price_tier: FabricTier | null;
  bedframe_price_tier: FabricTier | null;
  price_centi: number;
  supplier: string | null;
  supplier_code: string | null;
  lead_time_days: number;
  series: string | null;
  is_active: boolean;
};

export function useFabricTrackings(opts: { search?: string } = {}) {
  const suffix = opts.search ? `?search=${encodeURIComponent(opts.search)}` : "";
  return useQuery({
    queryKey: ["fabric-trackings", opts.search ?? ""],
    queryFn: () => api.get<{ fabrics: FabricRow[] }>(`/api/fabric-tracking${suffix}`).then((r) => r.fabrics),
  });
}

export function useCreateFabric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fabricCode: string; fabricDescription?: string; supplierCode?: string; series?: string; sofaPriceTier?: FabricTier; bedframePriceTier?: FabricTier }) =>
      api.post<{ fabric: FabricRow; fabricSeries: string }>("/api/fabric-tracking", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fabric-trackings"] }),
  });
}

export function usePatchFabricField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, field, body }: { id: string; field: "tier" | "supplier-code" | "description" | "series" | "active"; body: Record<string, unknown> }) =>
      api.patch<Record<string, unknown>>(`/api/fabric-tracking/${id}/${field}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fabric-trackings"] }),
  });
}

export function useDeleteFabric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.del<void>(`/api/fabric-tracking/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fabric-trackings"] }),
  });
}

// ── fabric_tier_addon (Maintenance — fabric tier deltas) ────────────────
export type FabricTierAddon = {
  sofaTier2Delta: number;
  sofaTier3Delta: number;
  bedframeTier2Delta: number;
  bedframeTier3Delta: number;
  updatedAt: string | null;
  updatedBy: number | null;
};
export function useFabricTierAddon() {
  return useQuery({
    queryKey: ["fabric-tier-addon"],
    queryFn: () => api.get<FabricTierAddon>("/api/fabric-tier-addon"),
  });
}
export function usePatchFabricTierAddon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<FabricTierAddon, "sofaTier2Delta" | "sofaTier3Delta" | "bedframeTier2Delta" | "bedframeTier3Delta">>) =>
      api.patch<{ ok: boolean }>("/api/fabric-tier-addon", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fabric-tier-addon"] }),
  });
}

// ── maintenance_config (effective-dated variant config) ─────────────────
export type MaintenanceResolved = {
  data: unknown;
  effectiveFrom: string | null;
  hasPendingPriceChange: boolean;
  pendingEffectiveFrom: string | null;
};
export type MaintenanceHistoryRow = {
  id: string;
  scope: string;
  config: unknown;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  createdBy: number | null;
  isPending: boolean;
};
export function useMaintenanceResolved(scope: string, asOf?: string) {
  const qs = new URLSearchParams({ scope });
  if (asOf) qs.set("asOf", asOf);
  return useQuery({
    queryKey: ["maintenance-config", "resolved", scope, asOf ?? ""],
    queryFn: () => api.get<MaintenanceResolved>(`/api/maintenance-config/resolved?${qs.toString()}`),
  });
}
export function useMaintenanceHistory(scope: string) {
  return useQuery({
    queryKey: ["maintenance-config", "history", scope],
    queryFn: () => api.get<{ history: MaintenanceHistoryRow[] }>(`/api/maintenance-config/history?scope=${encodeURIComponent(scope)}`).then((r) => r.history),
  });
}
export function useSaveMaintenanceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { scope: string; config: unknown; effectiveFrom: string; notes?: string }) =>
      api.post<{ id: string }>("/api/maintenance-config/changes", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["maintenance-config"] }),
  });
}

// ── pwp_rules ───────────────────────────────────────────────────────────
export type PwpRule = {
  id: string;
  triggerCategory: MfgCategory;
  triggerEligibleModelIds: string[];
  triggerComboIds: string[];
  rewardCategory: MfgCategory;
  eligibleRewardModelIds: string[];
  rewardComboIds: string[];
  qtyPerTrigger: number;
  type: "pwp" | "promo";
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};
export function usePwpRules() {
  return useQuery({
    queryKey: ["pwp-rules"],
    queryFn: () => api.get<{ rules: PwpRule[] }>("/api/pwp-rules").then((r) => r.rules),
  });
}
export function useTogglePwpRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.patch<{ rule: PwpRule }>(`/api/pwp-rules/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pwp-rules"] }),
  });
}
export function useDeletePwpRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.del<{ ok: boolean }>(`/api/pwp-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pwp-rules"] }),
  });
}

// ── sofa_combos (combo pricing) ─────────────────────────────────────────
export type SofaComboRow = {
  id: string;
  baseModel: string;
  modules: string[][];
  tier: FabricTier | null;
  customerId: string | null;
  supplierId: string | null;
  pricesByHeight: Record<string, number | null>;
  sellingPricesByHeight: Record<string, number | null>;
  pwpPricesByHeight: Record<string, number | null>;
  label: string | null;
  effectiveFrom: string;
  deletedAt: string | null;
  notes: string;
};
export function useSofaCombos(baseModel?: string) {
  const suffix = baseModel ? `?baseModel=${encodeURIComponent(baseModel)}` : "";
  return useQuery({
    queryKey: ["sofa-combos", baseModel ?? ""],
    queryFn: () => api.get<{ rules: SofaComboRow[] }>(`/api/sofa-combos${suffix}`).then((r) => r.rules),
  });
}
export function useDeleteSofaCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.del<void>(`/api/sofa-combos/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sofa-combos"] }),
  });
}
