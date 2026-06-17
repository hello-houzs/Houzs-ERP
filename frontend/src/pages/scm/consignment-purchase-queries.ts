// ----------------------------------------------------------------------------
// PURCHASE-consignment query hooks + types — ported from 2990s
// apps/backend/src/pages/PurchaseConsignment* data calls. Mirrors the PO + GRN +
// PR query-hook playbook of the done slices: the wire SHAPES match 2990s exactly
// (rule #7); only the SEAMS change — 2990s authedFetch + Supabase JS -> Houzs
// `api` client (frontend/src/api/client.ts) + @tanstack/react-query; endpoint
// bases -> Houzs mounts (/api/purchase-consignment-orders|receives|returns).
//
// Three pipelines: PC Order (order only) -> PC Receive (inventory IN) -> PC Return
// (inventory OUT). Co-located here + re-exported for the PurchaseConsignment* pages.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

type MaterialKind = "mfg_product" | "fabric" | "raw";

/* ════════════════════════════════════════════════════════════════════════
   PC Orders
   ════════════════════════════════════════════════════════════════════════ */

export type PcoStatus = "SUBMITTED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED";

export type PcoRow = {
  id: string;
  pc_number: string;
  supplier_id: string;
  status: PcoStatus;
  po_date: string | null;
  expected_at: string | null;
  currency: string;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  notes: string | null;
  purchase_location_id: string | null;
  submitted_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
  created_by: number | null;
  updated_at: string | null;
  supplier?: { id: string; code: string; name: string } | null;
  items?: Array<{ material_code: string; material_name: string; qty: number }>;
  has_children?: boolean;
};

export type PcoItemRow = {
  id: string;
  purchase_consignment_order_id: string;
  binding_id: string | null;
  material_kind: MaterialKind;
  material_code: string;
  material_name: string;
  supplier_sku: string | null;
  qty: number;
  unit_price_centi: number;
  line_total_centi: number;
  received_qty: number;
  notes: string | null;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string;
  discount_centi: number;
  unit_cost_centi: number;
  variants: Record<string, unknown> | null;
  delivery_date: string | null;
  warehouse_id: string | null;
  receipts?: Array<{ receiveNumber: string; qty: number; status: string }>;
};

export type PcoDetail = { purchaseOrder: PcoRow; items: PcoItemRow[] };

export type NewPcoItem = {
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  supplierSku?: string;
  qty: number;
  unitPriceCenti: number;
  discountCenti?: number;
  itemGroup?: string | null;
  description?: string | null;
  notes?: string;
};

export function usePcOrders(opts?: { status?: PcoStatus; supplierId?: string }) {
  return useQuery({
    queryKey: ["pc-orders", opts?.status ?? "all", opts?.supplierId ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.supplierId) params.set("supplierId", opts.supplierId);
      const res = await api.get<{ purchaseOrders: PcoRow[] }>(`/api/purchase-consignment-orders${params.toString() ? `?${params.toString()}` : ""}`);
      return res.purchaseOrders;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function usePcOrderDetail(id: string | null) {
  return useQuery({
    queryKey: ["pc-order-detail", id],
    queryFn: () => api.get<PcoDetail>(`/api/purchase-consignment-orders/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreatePcOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { supplierId: string; currency?: string; expectedAt: string; purchaseLocationId: string; notes?: string; items: NewPcoItem[] }) =>
      api.post<{ id: string; pcNumber: string }>(`/api/purchase-consignment-orders`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pc-orders"] }),
  });
}

export function useCancelPcOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ purchaseConsignmentOrder: { id: string; status: string } }>(`/api/purchase-consignment-orders/${id}/cancel`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["pc-orders"] });
      qc.invalidateQueries({ queryKey: ["pc-order-detail", id] });
    },
  });
}

export function useDeletePcOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true; deleted: string }>(`/api/purchase-consignment-orders/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pc-orders"] }),
  });
}

export function useUpdatePcOrderHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Record<string, unknown> & { id: string }) =>
      api.patch<{ purchaseConsignmentOrder: PcoRow }>(`/api/purchase-consignment-orders/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-orders"] });
      qc.invalidateQueries({ queryKey: ["pc-order-detail", vars.id] });
    },
  });
}

export function useAddPcOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pcoId, ...body }: Record<string, unknown> & { pcoId: string }) =>
      api.post<{ item: PcoItemRow }>(`/api/purchase-consignment-orders/${pcoId}/items`, body),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["pc-order-detail", vars.pcoId] }),
  });
}

export function useUpdatePcOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pcoId, itemId, ...body }: Record<string, unknown> & { pcoId: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/purchase-consignment-orders/${pcoId}/items/${itemId}`, body),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["pc-order-detail", vars.pcoId] }),
  });
}

export function useDeletePcOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pcoId, itemId }: { pcoId: string; itemId: string }) =>
      api.del<void>(`/api/purchase-consignment-orders/${pcoId}/items/${itemId}`),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["pc-order-detail", vars.pcoId] }),
  });
}

/* ════════════════════════════════════════════════════════════════════════
   PC Receives (server wraps the list as { grns } / detail as { grn }, mirroring
   the GRN route it was cloned from — the wire shape is preserved verbatim).
   ════════════════════════════════════════════════════════════════════════ */

export type PcrStatus = "POSTED" | "CLOSED" | "CANCELLED";

export type PcrRow = {
  id: string;
  receive_number: string;
  purchase_consignment_order_id: string | null;
  pc_order_no: string | null;
  supplier_id: string;
  received_at: string | null;
  delivery_note_ref: string | null;
  status: PcrStatus;
  notes: string | null;
  warehouse_id: string | null;
  currency: string;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  posted_at: string | null;
  created_at: string | null;
  created_by: number | null;
  updated_at: string | null;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_consignment_order?: { id: string; pc_number: string } | null;
  has_children?: boolean;
  fully_returned?: boolean;
};

export type PcrItemRow = {
  id: string;
  pc_receive_id: string;
  pc_order_item_id: string | null;
  material_kind: MaterialKind;
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
  line_total_centi: number;
  delivery_date: string | null;
  unit_cost_centi: number;
  invoiced_qty: number;
  returned_qty: number;
  created_at: string | null;
  source_pco_number?: string | null;
  received_at?: string | null;
  downstream?: Array<{ docNumber: string; docType: "PR"; qty: number; status: string }>;
};

export type PcrDetail = { grn: PcrRow; items: PcrItemRow[] };

export type OutstandingPcoItem = {
  pcoItemId: string;
  pcoId: string;
  pcoDocNo: string;
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
};

export type NewPcrItem = {
  pcOrderItemId?: string | null;
  materialKind: MaterialKind;
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
  itemGroup?: string | null;
  description?: string | null;
  notes?: string;
  variants?: Record<string, unknown> | null;
};

export function usePcReceives(opts?: { status?: PcrStatus; supplierId?: string }) {
  return useQuery({
    queryKey: ["pc-receives", opts?.status ?? "all", opts?.supplierId ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.supplierId) params.set("supplierId", opts.supplierId);
      const res = await api.get<{ grns: PcrRow[] }>(`/api/purchase-consignment-receives${params.toString() ? `?${params.toString()}` : ""}`);
      return res.grns;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function usePcReceiveDetail(id: string | null) {
  return useQuery({
    queryKey: ["pc-receive-detail", id],
    queryFn: () => api.get<PcrDetail>(`/api/purchase-consignment-receives/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useOutstandingPcoLines() {
  return useQuery({
    queryKey: ["pc-outstanding-pco-items"],
    queryFn: async () => {
      const res = await api.get<{ items: OutstandingPcoItem[] }>(`/api/purchase-consignment-receives/outstanding-pco-items`);
      return res.items;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreatePcReceive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { supplierId: string; purchaseConsignmentOrderId?: string | null; receivedAt?: string; deliveryNoteRef?: string; warehouseId?: string | null; notes?: string; items: NewPcrItem[] }) =>
      api.post<{ id: string; grnNumber: string }>(`/api/purchase-consignment-receives`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pc-receives"] });
      qc.invalidateQueries({ queryKey: ["pc-orders"] });
      qc.invalidateQueries({ queryKey: ["pc-outstanding-pco-items"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCreatePcReceiveFromPcos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseConsignmentOrderIds: string[]; deliveryNoteRef?: string; warehouseId?: string; notes?: string }) =>
      api.post<{ id: string; grnNumber: string }>(`/api/purchase-consignment-receives/from-pcos`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pc-receives"] });
      qc.invalidateQueries({ queryKey: ["pc-orders"] });
      qc.invalidateQueries({ queryKey: ["pc-outstanding-pco-items"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCancelPcReceive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ receive: { id: string; status: string } }>(`/api/purchase-consignment-receives/${id}/cancel`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["pc-receives"] });
      qc.invalidateQueries({ queryKey: ["pc-receive-detail", id] });
      qc.invalidateQueries({ queryKey: ["pc-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdatePcReceiveHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Record<string, unknown> & { id: string }) =>
      api.patch<{ receive: PcrRow }>(`/api/purchase-consignment-receives/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-receives"] });
      qc.invalidateQueries({ queryKey: ["pc-receive-detail", vars.id] });
    },
  });
}

export function useAddPcReceiveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ receiveId, ...body }: Record<string, unknown> & { receiveId: string }) =>
      api.post<{ item: PcrItemRow }>(`/api/purchase-consignment-receives/${receiveId}/items`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-receive-detail", vars.receiveId] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdatePcReceiveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ receiveId, itemId, ...body }: Record<string, unknown> & { receiveId: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/purchase-consignment-receives/${receiveId}/items/${itemId}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-receive-detail", vars.receiveId] });
      qc.invalidateQueries({ queryKey: ["pc-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useDeletePcReceiveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ receiveId, itemId }: { receiveId: string; itemId: string }) =>
      api.del<void>(`/api/purchase-consignment-receives/${receiveId}/items/${itemId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-receive-detail", vars.receiveId] });
      qc.invalidateQueries({ queryKey: ["pc-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

/* ════════════════════════════════════════════════════════════════════════
   PC Returns
   ════════════════════════════════════════════════════════════════════════ */

export type PctStatus = "POSTED" | "COMPLETED" | "CANCELLED";

export type PctRow = {
  id: string;
  return_number: string;
  pc_order_id: string | null;
  pc_receive_id: string | null;
  supplier_id: string;
  return_date: string | null;
  reason: string | null;
  status: PctStatus;
  posted_at: string | null;
  completed_at: string | null;
  credit_note_ref: string | null;
  refund_centi: number;
  notes: string | null;
  created_at: string | null;
  created_by: number | null;
  updated_at: string | null;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_consignment_order?: { id: string; pc_number: string } | null;
  pc_receive?: { id: string; receive_number: string } | null;
};

export type PctItemRow = {
  id: string;
  purchase_consignment_return_id: string;
  pc_receive_item_id: string | null;
  material_kind: MaterialKind;
  material_code: string;
  material_name: string;
  qty_returned: number;
  unit_price_centi: number;
  line_refund_centi: number;
  reason: string | null;
  notes: string | null;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string;
  variants: Record<string, unknown> | null;
  created_at: string | null;
};

export type PctDetail = { purchaseReturn: PctRow; items: PctItemRow[] };

export type ReturnablePcrLine = {
  receiveItemId: string;
  pcReceiveId: string;
  receiveNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  itemGroup: string | null;
  description: string | null;
  uom: string | null;
  accepted: number;
  returned: number;
  remaining: number;
  unitPriceCenti: number;
  variants: Record<string, unknown> | null;
};

export type NewPctItem = {
  pcReceiveItemId?: string | null;
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  qtyReturned: number;
  unitPriceCenti: number;
  reason?: string;
  notes?: string;
  itemGroup?: string | null;
  variants?: Record<string, unknown> | null;
};

export function usePcReturns(opts?: { status?: PctStatus; supplierId?: string }) {
  return useQuery({
    queryKey: ["pc-returns", opts?.status ?? "all", opts?.supplierId ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.supplierId) params.set("supplierId", opts.supplierId);
      const res = await api.get<{ purchaseReturns: PctRow[] }>(`/api/purchase-consignment-returns${params.toString() ? `?${params.toString()}` : ""}`);
      return res.purchaseReturns;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function usePcReturnDetail(id: string | null) {
  return useQuery({
    queryKey: ["pc-return-detail", id],
    queryFn: () => api.get<PctDetail>(`/api/purchase-consignment-returns/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useReturnablePcrLines() {
  return useQuery({
    queryKey: ["pc-returnable-receive-lines"],
    queryFn: async () => {
      const res = await api.get<{ lines: ReturnablePcrLine[] }>(`/api/purchase-consignment-returns/returnable-receive-lines`);
      return res.lines;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreatePcReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { supplierId: string; pcOrderId?: string | null; pcReceiveId?: string | null; returnDate?: string; reason?: string; notes?: string; items: NewPctItem[] }) =>
      api.post<{ id: string; returnNumber: string }>(`/api/purchase-consignment-returns`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pc-returns"] });
      qc.invalidateQueries({ queryKey: ["pc-receives"] });
      qc.invalidateQueries({ queryKey: ["pc-returnable-receive-lines"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCompletePcReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, creditNoteRef }: { id: string; creditNoteRef?: string }) =>
      api.patch<{ purchaseConsignmentReturn: { id: string; status: string } }>(`/api/purchase-consignment-returns/${id}/complete`, { creditNoteRef }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-returns"] });
      qc.invalidateQueries({ queryKey: ["pc-return-detail", vars.id] });
    },
  });
}

export function useCancelPcReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ purchaseConsignmentReturn: { id: string; status: string } }>(`/api/purchase-consignment-returns/${id}/cancel`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["pc-returns"] });
      qc.invalidateQueries({ queryKey: ["pc-return-detail", id] });
      qc.invalidateQueries({ queryKey: ["pc-receives"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdatePcReturnHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Record<string, unknown> & { id: string }) =>
      api.patch<{ purchaseConsignmentReturn: PctRow }>(`/api/purchase-consignment-returns/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-returns"] });
      qc.invalidateQueries({ queryKey: ["pc-return-detail", vars.id] });
    },
  });
}

export function useAddPcReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prId, ...body }: Record<string, unknown> & { prId: string }) =>
      api.post<{ item: PctItemRow }>(`/api/purchase-consignment-returns/${prId}/items`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-return-detail", vars.prId] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdatePcReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prId, itemId, ...body }: Record<string, unknown> & { prId: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/purchase-consignment-returns/${prId}/items/${itemId}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-return-detail", vars.prId] });
      qc.invalidateQueries({ queryKey: ["pc-receives"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useDeletePcReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prId, itemId }: { prId: string; itemId: string }) =>
      api.del<void>(`/api/purchase-consignment-returns/${prId}/items/${itemId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["pc-return-detail", vars.prId] });
      qc.invalidateQueries({ queryKey: ["pc-receives"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

/* Shared supplier-picker source (reuses the existing /api/suppliers list). */
export type SupplierLite = { id: string; code: string; name: string };
export function useSupplierOptions() {
  return useQuery({
    queryKey: ["supplier-options"],
    queryFn: async () => {
      const res = await api.get<{ suppliers: SupplierLite[] }>(`/api/suppliers`);
      return res.suppliers ?? [];
    },
    staleTime: 60_000,
    retry: 1,
    retryDelay: 800,
  });
}

/* Shared warehouse-picker source (reuses the existing /api/inventory/warehouses). */
export type WarehouseLite = { id: string; code: string; name: string };
export function useWarehouseOptions() {
  return useQuery({
    queryKey: ["warehouse-options"],
    queryFn: async () => {
      const res = await api.get<{ warehouses: WarehouseLite[] }>(`/api/inventory/warehouses`);
      return res.warehouses ?? [];
    },
    staleTime: 5 * 60_000,
    retry: 1,
    retryDelay: 800,
  });
}
