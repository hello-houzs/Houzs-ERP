// ----------------------------------------------------------------------------
// MRP · Stock Status query hooks + types — ported from 2990s apps/backend/src/
// lib/mrp-queries.ts. The wire SHAPES (MrpResponse / MrpSku / MrpLine) match the
// cloned /api/mrp route exactly (rule #7). Only the SEAMS change:
//   - Data layer: 2990s authedFetch + Supabase JS -> Houzs `api` client
//     (frontend/src/api/client.ts) + @tanstack/react-query (rule #7).
//   - Endpoint base: /api/mrp + /api/mrp-lead-times.
//
// STRATEGY-2: the backend drops the furniture sofa-SETS path, so `sofaSets` comes
// back as an empty array (the SofaSet type is kept for wire fidelity). The page
// groups demand generically by (warehouse, product_code, variant).
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

export type MrpAllocSource = "stock" | "po" | "shortage";

export type MrpLine = {
  soItemId: string;
  soDocNo: string;
  debtorName: string | null;
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  /* order-by date = delivery - category lead days. */
  orderByDate: string | null;
  qty: number;
  source: MrpAllocSource;
  poNumber: string | null;
  poEta: string | null;
  shortageQty: number;
  /* When source==='po', the covering PO's supplier so a covered line shows it
     READ-ONLY (a raised PO's supplier can't change). NULL on stock / shortage. */
  poSupplierId: string | null;
  poSupplierName: string | null;
};

export type MrpSupplierOpt = { supplierId: string; code: string; name: string; isMain: boolean };

export type MrpSku = {
  /* Each row is scoped to ONE warehouse (per-WH MRP). NULL when the demand line
     has no warehouse bound yet. */
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  variantKey: string;
  variantLabel: string | null;
  description: string | null;
  category: string | null;
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  suppliers: MrpSupplierOpt[];
  lines: MrpLine[];
};

export type MrpWarehouse = { id: string; code: string; name: string };

/* STRATEGY-2: the furniture sofa-SET shape — kept for wire fidelity; the cloned
   backend always returns sofaSets: []. */
export type SofaSet = {
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  soItemId: string;
  soDocNo: string;
  debtorName: string | null;
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  orderByDate: string | null;
  itemCode: string;
  description: string | null;
  variantLabel: string | null;
  modules: string[];
  colour: string | null;
  qty: number;
  orderedQty: number;
  shortageQty: number;
  poNumber: string | null;
  poEta: string | null;
  poSupplierId: string | null;
  poSupplierName: string | null;
  suppliers: MrpSupplierOpt[];
};

export type MrpResponse = {
  asOf: string;
  categories: string[];
  warehouses: MrpWarehouse[];
  skus: MrpSku[];
  sofaSets: SofaSet[];
  totals: {
    skuCount: number;
    shortageSkuCount: number;
    shortageUnits: number;
    sofaSetCount: number;
    sofaSetShortageCount: number;
  };
};

/** Stock Status Report / MRP — recomputed server-side on every call. */
export function useMrp(params: { category?: string; warehouseId: string; includeUndated?: boolean }) {
  const { category, warehouseId, includeUndated } = params;
  return useQuery({
    queryKey: ["mrp", category ?? "all", warehouseId, includeUndated ?? false],
    queryFn: () => {
      const q = new URLSearchParams();
      if (category && category !== "all") q.set("category", category);
      if (warehouseId && warehouseId !== "all") q.set("warehouseId", warehouseId);
      if (includeUndated) q.set("includeUndated", "true");
      const qs = q.toString();
      return api.get<MrpResponse>(`/api/mrp${qs ? `?${qs}` : ""}`);
    },
    staleTime: 30_000,
  });
}

/* ── Per-category lead times ───────────────────────────────────────────── */
export type LeadCategory = "sofa" | "bedframe" | "mattress" | "accessory" | "service";
export type CategoryLeadTimes = Record<LeadCategory, number>;
export const LEAD_CATEGORIES: LeadCategory[] = ["sofa", "bedframe", "mattress", "accessory", "service"];

export function useCategoryLeadTimes() {
  return useQuery({
    queryKey: ["mrp-lead-times"],
    queryFn: () => api.get<{ leadTimes: CategoryLeadTimes }>(`/api/mrp-lead-times`),
    staleTime: 60_000,
  });
}

export function useUpdateCategoryLeadTime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { category: LeadCategory; leadDays: number }) =>
      api.put<{ ok: true; category: LeadCategory; leadDays: number }>(`/api/mrp-lead-times`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mrp-lead-times"] });
      qc.invalidateQueries({ queryKey: ["mrp"] }); // order-by dates recompute
    },
  });
}

/* ── Proceed PO from MRP shortage lines ──────────────────────────────────────
   Mirrors 2990s useCreatePosFromSoItems: posts the selected shortage SO lines
   (each carrying a chosen supplier) to the PO route's /from-sos convert path.
   fromMrp tags every PO line reference-only (no SO-line lock; infinite-convert).
   NOTE: the Houzs /api/purchase-orders/from-sos endpoint is currently a guarded
   stub (it returns { created: [], total: 0 } / 409 until the PO from-SO write
   path is ported). The MRP page surfaces that guarded message in its result
   dialog. See docs/scm-clone/PLAN.md (MRP slice). */
export type CreatePosFromSoBody = {
  picks: Array<{ soItemId: string; qty: number; supplierId?: string | null }>;
  mode?: "combined" | "per-so";
  fromMrp?: boolean;
  expectedAt?: string;
};
export type CreatePosFromSoResult = {
  created?: Array<{ id: string; poNumber: string; supplierId: string; lineCount: number }>;
  total?: number;
  error?: string;
  message?: string;
};

export function useCreatePosFromSoItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePosFromSoBody) =>
      api.post<CreatePosFromSoResult>(`/api/purchase-orders/from-sos`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mrp"] });
      qc.invalidateQueries({ queryKey: ["scm-purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["mfg-sales-orders"] });
    },
  });
}
