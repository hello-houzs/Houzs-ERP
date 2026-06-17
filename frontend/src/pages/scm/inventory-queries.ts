// ----------------------------------------------------------------------------
// Inventory query hooks + types — ported from 2990s apps/backend/src/lib/
// inventory-queries.ts. The wire SHAPES (Warehouse / InventoryBalance /
// InventoryMovement / InventoryLot / CogsEntry / InventoryValueRow /
// InventoryProductTotal / InventoryBatch / InventoryBucket / InventoryAnalytics)
// are identical to 2990s (rule #7). Only the SEAMS change (same playbook as the
// Suppliers/PO slices):
//   - Data layer: 2990s lib/inventory-queries (authedFetch + Supabase JS) ->
//     Houzs `api` client (frontend/src/api/client.ts) + @tanstack/react-query.
//   - Endpoint base: 2990s `/inventory/*` -> Houzs `/api/inventory/*` (mount).
//   - Co-located here + re-exported for the 5 inventory pages (the slice ships
//     its files; no shared lib package).
//
// Strategy-2 note: the catalogue-coupled endpoints (showAll balances, /products)
// return faithful EMPTY shapes from the backend until a Houzs product layer
// lands — the hooks are unchanged; the pages render their empty states.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

export type Warehouse = {
  id: string;
  code: string;
  name: string;
  location: string | null;
  is_active: boolean;
  is_default: boolean;
};

export type InventoryBalance = {
  warehouse_id: string;
  product_code: string;
  variant_key?: string;
  product_name: string | null;
  qty: number;
  last_movement_at: string | null;
  warehouse_code?: string;
  warehouse_name?: string;
  category?: "ACCESSORY" | "BEDFRAME" | "SOFA" | "MATTRESS" | "SERVICE";
  size_label?: string | null;
  value_sen?: number;
  main_supplier_code?: string | null;
  main_supplier_name?: string | null;
};

export type InventoryProductTotal = {
  product_code: string;
  product_name: string;
  category: "ACCESSORY" | "BEDFRAME" | "SOFA" | "MATTRESS" | "SERVICE";
  size_label: string | null;
  base_price_sen: number | null;
  price1_sen: number | null;
  branding: string | null;
  total_qty: number;
  total_value_sen: number;
  last_movement_at: string | null;
  main_supplier_code: string | null;
  main_supplier_name: string | null;
  main_supplier_price_centi: number | null;
  reserve_7d: number;
  reserve_14d: number;
  reserved_total: number;
  available_qty: number;
  incoming_qty: number;
  oldest_lot_at: string | null;
};

export type InventoryMovement = {
  id: string;
  movement_type: "IN" | "OUT" | "ADJUSTMENT" | "TRANSFER";
  warehouse_id: string;
  product_code: string;
  product_name: string | null;
  qty: number;
  unit_cost_sen?: number;
  total_cost_sen?: number;
  source_doc_type: string | null;
  source_doc_id: string | null;
  source_doc_no: string | null;
  reason_code: string | null;
  notes: string | null;
  performed_by: number | null;
  created_at: string;
};

export type InventoryLot = {
  id: string;
  warehouse_id: string;
  warehouse_code?: string;
  product_code: string;
  product_name: string | null;
  qty_received: number;
  qty_remaining: number;
  unit_cost_sen: number;
  remaining_value_sen?: number;
  received_at: string;
  source_doc_type: string | null;
  source_doc_no: string | null;
};

export type CogsEntry = {
  id: string;
  consumed_at: string;
  warehouse_id: string;
  warehouse_code: string;
  product_code: string;
  qty_consumed: number;
  unit_cost_sen: number;
  total_cost_sen: number;
  source_doc_type: string | null;
  source_doc_no: string | null;
  lot_received_at: string;
  lot_source_doc_no: string | null;
};

export type InventoryValueRow = {
  warehouse_id: string;
  warehouse_code: string;
  product_code: string;
  product_name: string | null;
  qty_on_hand: number;
  value_sen: number;
  avg_unit_cost_sen: number;
};

export function useWarehouses(opts?: { includeInactive?: boolean }) {
  return useQuery({
    queryKey: ["warehouses", opts?.includeInactive ?? false],
    queryFn: async () => {
      const qs = opts?.includeInactive ? "?includeInactive=true" : "";
      const r = await api.get<{ warehouses: Warehouse[] }>(`/api/inventory/warehouses${qs}`);
      return r.warehouses;
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useInventoryBalances(opts?: {
  warehouseId?: string;
  search?: string;
  category?: string;
  showAll?: boolean;
}) {
  return useQuery({
    queryKey: ["inventory", "balances", opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set("warehouseId", opts.warehouseId);
      if (opts?.search) params.set("search", opts.search);
      if (opts?.category && opts.category !== "all") params.set("category", opts.category);
      if (opts?.showAll) params.set("showAll", "true");
      return api.get<{ balances: InventoryBalance[]; warehouses: Warehouse[] }>(
        `/api/inventory${params.toString() ? `?${params.toString()}` : ""}`,
      );
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export function useInventoryProductTotals(opts?: { search?: string; category?: string }) {
  return useQuery({
    queryKey: ["inventory", "product-totals", opts ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.search) params.set("search", opts.search);
      if (opts?.category && opts.category !== "all") params.set("category", opts.category);
      const r = await api.get<{ products: InventoryProductTotal[] }>(
        `/api/inventory/products${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.products;
    },
    staleTime: 30_000,
  });
}

export type InventoryAnalytics = {
  asOf: string;
  windowDays: number;
  totalValueSen: number;
  distinctSkus: number;
  aging: { key: string; label: string; qty: number; valueSen: number }[];
  turnover: { trailingCogsSen: number; annualizedTurns: number; daysOnHand: number | null };
  deadStock: { product_code: string; product_name: string; qty: number; valueSen: number; lastSoldAt: string | null }[];
  abc: {
    items: { product_code: string; product_name: string; cogsSen: number; onHandValueSen: number; cumPct: number; class: "A" | "B" | "C" }[];
    summary: Record<"A" | "B" | "C", { count: number; valueSen: number }>;
  };
};

export function useInventoryAnalytics(opts?: { days?: number; warehouseId?: string | null }) {
  return useQuery({
    queryKey: ["inventory", "analytics", opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.days) params.set("days", String(opts.days));
      if (opts?.warehouseId) params.set("warehouseId", opts.warehouseId);
      return api.get<InventoryAnalytics>(
        `/api/inventory/analytics${params.toString() ? `?${params.toString()}` : ""}`,
      );
    },
    staleTime: 60_000,
  });
}

export function useInventoryProductBreakdown(productCode: string | null) {
  return useQuery({
    queryKey: ["inventory", "breakdown", productCode],
    queryFn: () =>
      api.get<{ balances: InventoryBalance[] }>(
        `/api/inventory/breakdown/${encodeURIComponent(productCode ?? "")}`,
      ),
    enabled: Boolean(productCode),
    staleTime: 30_000,
  });
}

export function useInventoryLots(productCode: string | null, opts?: { warehouseId?: string; includeClosed?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "lots", productCode, opts ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set("warehouseId", opts.warehouseId);
      if (opts?.includeClosed) params.set("includeClosed", "true");
      const r = await api.get<{ lots: InventoryLot[] }>(
        `/api/inventory/lots/${encodeURIComponent(productCode ?? "")}${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.lots;
    },
    enabled: Boolean(productCode),
    staleTime: 30_000,
  });
}

export type BatchComponent = {
  productCode: string;
  variantKey: string | null;
  productName: string | null;
  qtyRemaining: number;
  unitCostSen: number;
  receivedAt: string | null;
};
export type InventoryBatch = {
  warehouseId: string;
  warehouseName: string | null;
  batchNo: string;
  supplierId: string | null;
  supplierName: string | null;
  receivedAt: string | null;
  totalRemaining: number;
  components: BatchComponent[];
};

export function useInventoryBatches(opts?: { warehouseId?: string; productCode?: string }) {
  return useQuery({
    queryKey: ["inventory", "batches", opts ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set("warehouseId", opts.warehouseId);
      if (opts?.productCode) params.set("productCode", opts.productCode);
      const r = await api.get<{ batches: InventoryBatch[] }>(
        `/api/inventory/batches${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.batches;
    },
    staleTime: 30_000,
  });
}

export function useCogsEntries(opts?: { warehouseId?: string; productCode?: string; from?: string; to?: string }) {
  return useQuery({
    queryKey: ["inventory", "cogs", opts ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set("warehouseId", opts.warehouseId);
      if (opts?.productCode) params.set("productCode", opts.productCode);
      if (opts?.from) params.set("from", opts.from);
      if (opts?.to) params.set("to", opts.to);
      const r = await api.get<{ cogs: CogsEntry[] }>(
        `/api/inventory/cogs${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.cogs;
    },
    staleTime: 30_000,
  });
}

export function useInventoryValue(opts?: { warehouseId?: string }) {
  return useQuery({
    queryKey: ["inventory", "value", opts ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set("warehouseId", opts.warehouseId);
      const r = await api.get<{ value: InventoryValueRow[] }>(
        `/api/inventory/value${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.value;
    },
    staleTime: 30_000,
  });
}

export function useCreateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name: string; location?: string; isDefault?: boolean }) =>
      api.post<{ warehouse: Warehouse }>(`/api/inventory/warehouses`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["warehouses"] }),
  });
}

export function useUpdateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; code?: string; name?: string; location?: string; isActive?: boolean; isDefault?: boolean }) =>
      api.patch<{ warehouse: Warehouse }>(`/api/inventory/warehouses/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["warehouses"] }),
  });
}

export function useDeleteWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/inventory/warehouses/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["warehouses"] }),
  });
}

export function useInventoryMovements(opts?: {
  warehouseId?: string;
  productCode?: string;
  docType?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  return useQuery({
    queryKey: ["inventory", "movements", opts ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set("warehouseId", opts.warehouseId);
      if (opts?.productCode) params.set("productCode", opts.productCode);
      if (opts?.docType) params.set("docType", opts.docType);
      if (opts?.dateFrom) params.set("dateFrom", opts.dateFrom);
      if (opts?.dateTo) params.set("dateTo", opts.dateTo);
      const r = await api.get<{ movements: InventoryMovement[] }>(
        `/api/inventory/movements${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.movements;
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export function useStockAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      warehouseId: string;
      productCode: string;
      productName?: string;
      qtyDelta: number;
      reasonCode: string;
      notes?: string;
      itemGroup?: string | null;
      variants?: Record<string, unknown> | null;
      batchNo?: string | null;
      variantKey?: string | null;
    }) => api.post<{ movement: { id: string } }>(`/api/inventory/adjustments`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export type InventoryBucket = {
  warehouse_id: string;
  variant_key: string;
  batch_no: string | null;
  product_name: string | null;
  qty: number;
};

export function useInventoryBuckets(productCode: string | null, warehouseId: string | null) {
  return useQuery({
    queryKey: ["inventory", "buckets", productCode, warehouseId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set("warehouseId", warehouseId);
      const r = await api.get<{ buckets: InventoryBucket[] }>(
        `/api/inventory/buckets/${encodeURIComponent(productCode ?? "")}${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.buckets;
    },
    enabled: Boolean(productCode && warehouseId),
    staleTime: 15_000,
    retry: 1,
  });
}
