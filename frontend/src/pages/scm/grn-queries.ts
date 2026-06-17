// ----------------------------------------------------------------------------
// GRN (Goods Receipt) query hooks + types — ported from 2990s apps/backend/src/
// lib/flow-queries.ts (the GRN slice of it). The wire SHAPES (GrnRow / GrnItemRow
// / GrnDetail / the create + mutate bodies) are identical to 2990s (rule #7).
// Only the SEAMS change (same playbook as the Suppliers/PO/Inventory slices):
//   - Data layer: 2990s authedFetch + Supabase JS -> Houzs `api` client
//     (frontend/src/api/client.ts) + @tanstack/react-query.
//   - Endpoint base: 2990s `/grns/*` -> Houzs `/api/grns/*` (mount).
//   - Co-located here + re-exported for the 4 GRN pages (the slice ships its
//     files; no shared lib package).
//
// Strategy-2 note: convert-to-PI / convert-to-PR target the PI/PR slices, which
// are NOT cloned yet — those hooks are omitted (the pages drop those actions with
// a // TODO). The list/detail/create/cancel/line-CRUD that the GRN module needs
// to be fully usable are all here.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

export type GrnStatus = "POSTED" | "CLOSED" | "CANCELLED";

export type GrnSupplierLite = { id: string; code: string; name: string };

export type GrnRow = {
  id: string;
  grn_number: string;
  purchase_order_id: string | null;
  supplier_id: string;
  warehouse_id: string | null;
  received_at: string | null;
  delivery_note_ref: string | null;
  status: GrnStatus;
  notes: string | null;
  currency: string;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  posted_at: string | null;
  created_at: string | null;
  created_by: number | null;
  updated_at: string | null;
  supplier?: GrnSupplierLite | null;
  purchase_order?: { id: string; po_number: string } | null;
  /* Migration 0106 — convert-eligibility / lock flags from the list endpoint. */
  has_children?: boolean;
  fully_invoiced?: boolean;
  fully_returned?: boolean;
};

export type GrnItemRow = {
  id: string;
  grn_id: string;
  purchase_order_item_id: string | null;
  material_kind: "mfg_product" | "fabric" | "raw";
  material_code: string;
  material_name: string;
  supplier_sku: string | null;
  qty_received: number;
  qty_accepted: number;
  qty_rejected: number;
  rejection_reason: string | null;
  unit_price_centi: number;
  notes: string | null;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string;
  discount_centi: number;
  variants: Record<string, unknown> | null;
  gap_inches: number | null;
  divan_height_inches: number | null;
  divan_price_sen: number;
  leg_height_inches: number | null;
  leg_price_sen: number;
  custom_specials: unknown;
  line_suffix: string | null;
  special_order_price_sen: number;
  line_total_centi: number;
  delivery_date: string | null;
  unit_cost_centi: number;
  invoiced_qty: number;
  returned_qty: number;
  rack_id: string | null;
  created_at: string | null;
  /* Detail-route extras (server-resolved). */
  source_po_number?: string | null;
  received_at?: string | null;
  downstream?: { docNumber: string; docType: "PI" | "PR"; qty: number; status: string }[];
};

export type GrnDetail = {
  grn: GrnRow & { fully_invoiced?: boolean; fully_returned?: boolean };
  items: GrnItemRow[];
};

/** A PO line surfaced by /grns/outstanding-po-items for the From-PO picker. */
export type OutstandingPoItem = {
  poItemId: string;
  poId: string;
  poDocNo: string;
  itemCode: string;
  description: string | null;
  itemGroup: string;
  qty: number;
  receivedQty: number;
  remainingQty: number;
  unitPriceCenti: number;
  warehouseId: string | null;
  variants: Record<string, unknown> | null;
  deliveryDate: string | null;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  poDate: string;
  expectedAt: string | null;
  warehouseLocationId: string | null;
  warehouseLocationCode: string | null;
  warehouseLocationName: string | null;
};

/** Per-line draft sent to POST /grns (mirrors 2990s NewGrnItem). */
export type NewGrnItem = {
  purchaseOrderItemId?: string | null;
  materialKind: "mfg_product" | "fabric" | "raw";
  materialCode: string;
  materialName: string;
  supplierSku?: string;
  qtyReceived: number;
  qtyAccepted?: number;
  qtyRejected?: number;
  rejectionReason?: string;
  unitPriceCenti: number;
  discountCenti?: number;
  unitCostCenti?: number;
  deliveryDate?: string | null;
  itemGroup?: string;
  variants?: Record<string, unknown> | null;
  description?: string;
  description2?: string;
  notes?: string;
  rackId?: string | null;
};

/* ── List + detail ──────────────────────────────────────────────────── */

export function useGrns(opts?: { status?: GrnStatus; supplierId?: string }) {
  return useQuery({
    queryKey: ["grns", opts?.status ?? "all", opts?.supplierId ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.supplierId) params.set("supplierId", opts.supplierId);
      const res = await api.get<{ grns: GrnRow[] }>(`/api/grns${params.toString() ? `?${params.toString()}` : ""}`);
      return res.grns;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export async function fetchGrnDetail(id: string): Promise<GrnDetail> {
  return api.get<GrnDetail>(`/api/grns/${id}`);
}

export function useGrnDetail(id: string | null) {
  return useQuery({
    queryKey: ["grn-detail", id],
    queryFn: () => fetchGrnDetail(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useOutstandingPoItems() {
  return useQuery({
    queryKey: ["grn-outstanding-po-items"],
    queryFn: async () => {
      const res = await api.get<{ items: OutstandingPoItem[] }>(`/api/grns/outstanding-po-items`);
      return res.items;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

/* ── Create + mutate ────────────────────────────────────────────────── */

export function useCreateGrn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      supplierId: string;
      purchaseOrderId?: string | null;
      warehouseId?: string | null;
      receivedAt?: string;
      deliveryNoteRef?: string;
      notes?: string;
      items: NewGrnItem[];
    }) => api.post<{ id: string; grnNumber: string }>(`/api/grns`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
    },
  });
}

export function useCreateGrnFromPoItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { picks: Array<{ poItemId: string; qty: number }>; notes?: string; receivedDate?: string }) =>
      api.post<{ created: Array<{ id: string; grnNumber: string }>; total: number }>(`/api/grns/from-po-items`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["grn-outstanding-po-items"] });
    },
  });
}

export function useCancelGrn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ grn: GrnRow }>(`/api/grns/${id}/cancel`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["grn-detail", id] });
      qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
    },
  });
}

export function useUpdateGrnHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Record<string, unknown> & { id: string }) =>
      api.patch<{ grn: GrnRow }>(`/api/grns/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["grn-detail", vars.id] });
    },
  });
}

export function useUpdateGrnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId, ...body }: Record<string, unknown> & { grnId: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/grns/${grnId}/items/${itemId}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["grn-detail", vars.grnId] });
      qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
    },
  });
}

export function useDeleteGrnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId }: { grnId: string; itemId: string }) =>
      api.del<void>(`/api/grns/${grnId}/items/${itemId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["grn-detail", vars.grnId] });
      qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
    },
  });
}
