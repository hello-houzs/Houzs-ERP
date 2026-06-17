// ----------------------------------------------------------------------------
// SALES-consignment query hooks + types — ported from 2990s Consignment* data
// calls. Mirrors the sales-orders / delivery-billing query-hook playbook of the
// done slices: the wire SHAPES match the cloned routes (rule #7); only the SEAMS
// change — 2990s authedFetch + Supabase JS -> Houzs `api` client + react-query;
// endpoint bases -> Houzs mounts (/api/consignment-orders|notes|returns).
//
// Three pipelines: Consignment Order (order only, audit) -> Consignment Note
// (inventory OUT, CS_DO) -> Consignment Return (inventory IN, CS_DR).
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

/* ════════════════════════════════════════════════════════════════════════
   Consignment Orders (CO)
   ════════════════════════════════════════════════════════════════════════ */

export type CoStatus = "CONFIRMED" | "IN_PRODUCTION" | "READY_TO_SHIP" | "SHIPPED" | "DELIVERED" | "INVOICED" | "CLOSED" | "ON_HOLD" | "CANCELLED";

export type CoRow = {
  doc_no: string;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  phone: string | null;
  so_date: string | null;
  status: CoStatus;
  currency: string;
  local_total_centi: number;
  total_revenue_centi: number;
  line_count: number;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  note: string | null;
  created_at: string | null;
  item_categories?: string[];
  has_children?: boolean;
  first_item_category?: string | null;
  first_item_branding?: string | null;
  payment_methods_summary?: string;
};

export type CoItemRow = {
  id: string;
  doc_no: string;
  item_group: string | null;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  total_centi: number;
  unit_cost_centi: number;
  line_cost_centi: number;
  line_margin_centi: number;
  cancelled: boolean;
  variants: Record<string, unknown> | null;
  line_delivery_date: string | null;
  deliveries?: Array<{ noNumber: string; qty: number; status: string }>;
};

export type CoDetail = { salesOrder: CoRow & Record<string, unknown>; items: CoItemRow[] };

export type NewCoItem = {
  itemGroup: string;
  itemCode: string;
  description?: string | null;
  qty: number;
  unitPriceCenti: number;
  unitCostCenti?: number;
};

export type NewCoBody = {
  debtorName: string;
  phone: string;
  debtorCode?: string | null;
  email?: string | null;
  customerType?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  postcode?: string | null;
  customerState?: string | null;
  buildingType?: string | null;
  poDocNo?: string | null;
  ref?: string | null;
  agent?: string | null;
  branding?: string | null;
  transferTo?: string | null;
  customerDeliveryDate?: string | null;
  internalExpectedDd?: string | null;
  note?: string | null;
  items: NewCoItem[];
};

export function useConsignmentOrders(opts?: { status?: CoStatus; debtor?: string }) {
  return useQuery({
    queryKey: ["consignment-orders", opts?.status ?? "all", opts?.debtor ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.debtor) params.set("debtor", opts.debtor);
      const res = await api.get<{ salesOrders: CoRow[] }>(`/api/consignment-orders${params.toString() ? `?${params.toString()}` : ""}`);
      return res.salesOrders;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useConsignmentOrderDetail(docNo: string | null) {
  return useQuery({
    queryKey: ["consignment-order-detail", docNo],
    queryFn: () => api.get<CoDetail>(`/api/consignment-orders/${docNo}`),
    enabled: Boolean(docNo),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreateConsignmentOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewCoBody) => api.post<{ docNo: string }>(`/api/consignment-orders`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["consignment-orders"] }),
  });
}

export function useUpdateConsignmentOrderStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, status, notes }: { docNo: string; status: CoStatus; notes?: string }) =>
      api.patch<{ salesOrder: { doc_no: string; status: string } }>(`/api/consignment-orders/${docNo}/status`, { status, notes }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-orders"] });
      qc.invalidateQueries({ queryKey: ["consignment-order-detail", vars.docNo] });
    },
  });
}

export function useUpdateConsignmentOrderHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, ...body }: Record<string, unknown> & { docNo: string }) =>
      api.patch<{ ok: true; docNo: string }>(`/api/consignment-orders/${docNo}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-orders"] });
      qc.invalidateQueries({ queryKey: ["consignment-order-detail", vars.docNo] });
    },
  });
}

export function useAddConsignmentOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, ...body }: Record<string, unknown> & { docNo: string }) =>
      api.post<{ item: CoItemRow }>(`/api/consignment-orders/${docNo}/items`, body),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["consignment-order-detail", vars.docNo] }),
  });
}

export function useUpdateConsignmentOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, ...body }: Record<string, unknown> & { docNo: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/consignment-orders/${docNo}/items/${itemId}`, body),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["consignment-order-detail", vars.docNo] }),
  });
}

export function useDeleteConsignmentOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId }: { docNo: string; itemId: string }) =>
      api.del<void>(`/api/consignment-orders/${docNo}/items/${itemId}`),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["consignment-order-detail", vars.docNo] }),
  });
}

/* ════════════════════════════════════════════════════════════════════════
   Consignment Notes (CN) — server wraps list as { deliveryOrders } / detail as
   { deliveryOrder } (mirrors the DO route it was cloned from).
   ════════════════════════════════════════════════════════════════════════ */

export type CnStatus = "LOADED" | "DISPATCHED" | "IN_TRANSIT" | "SIGNED" | "DELIVERED" | "INVOICED" | "CANCELLED";

export type CnRow = {
  id: string;
  do_number: string;
  consignment_so_doc_no: string | null;
  debtor_code: string | null;
  debtor_name: string;
  do_date: string | null;
  status: CnStatus;
  currency: string;
  local_total_centi: number;
  line_count: number;
  warehouse_id: string | null;
  note: string | null;
  notes: string | null;
  created_at: string | null;
  has_children?: boolean;
};

export type CnItemRow = {
  id: string;
  consignment_delivery_order_id: string;
  consignment_so_item_id: string | null;
  item_code: string;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  line_total_centi: number;
  unit_cost_centi: number;
  variants: Record<string, unknown> | null;
  notes: string | null;
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  created_at: string | null;
};

export type CnDetail = { deliveryOrder: CnRow & Record<string, unknown>; items: CnItemRow[] };

export type DeliverableCoLine = {
  orderItemId: string;
  orderDocNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  ordered: number;
  delivered: number;
  outstanding: number;
  unitPriceCenti: number;
  discountCenti: number;
  unitCostCenti: number;
  variants: Record<string, unknown> | null;
};

export type NewCnItem = {
  consignmentSoItemId?: string | null;
  itemCode: string;
  itemGroup?: string | null;
  description?: string | null;
  qty: number;
  unitPriceCenti: number;
  unitCostCenti?: number;
};

export function useConsignmentNotes(opts?: { status?: CnStatus }) {
  return useQuery({
    queryKey: ["consignment-notes", opts?.status ?? "all"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      const res = await api.get<{ deliveryOrders: CnRow[] }>(`/api/consignment-notes${params.toString() ? `?${params.toString()}` : ""}`);
      return res.deliveryOrders;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useConsignmentNoteDetail(id: string | null) {
  return useQuery({
    queryKey: ["consignment-note-detail", id],
    queryFn: () => api.get<CnDetail>(`/api/consignment-notes/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useDeliverableCoLines() {
  return useQuery({
    queryKey: ["consignment-deliverable-order-lines"],
    queryFn: async () => {
      const res = await api.get<{ lines: DeliverableCoLine[] }>(`/api/consignment-notes/deliverable-order-lines`);
      return res.lines;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreateConsignmentNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { consignmentSoDocNo?: string | null; debtorName: string; warehouseId?: string | null; note?: string | null; items: NewCnItem[] } & Record<string, unknown>) =>
      api.post<{ id: string; doNumber: string }>(`/api/consignment-notes`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consignment-notes"] });
      qc.invalidateQueries({ queryKey: ["consignment-deliverable-order-lines"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCreateConsignmentNoteFromOrders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { picks: Array<{ orderItemId: string; qty: number }> }) =>
      api.post<{ id: string; doNumber: string }>(`/api/consignment-notes/from-orders`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consignment-notes"] });
      qc.invalidateQueries({ queryKey: ["consignment-deliverable-order-lines"] });
      qc.invalidateQueries({ queryKey: ["consignment-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdateConsignmentNoteStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: CnStatus }) =>
      api.patch<{ consignmentNote: { id: string; status: string } }>(`/api/consignment-notes/${id}/status`, { status }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-notes"] });
      qc.invalidateQueries({ queryKey: ["consignment-note-detail", vars.id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdateConsignmentNoteHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Record<string, unknown> & { id: string }) =>
      api.patch<{ ok: true; id: string }>(`/api/consignment-notes/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-notes"] });
      qc.invalidateQueries({ queryKey: ["consignment-note-detail", vars.id] });
    },
  });
}

export function useUpdateConsignmentNoteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...body }: Record<string, unknown> & { id: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/consignment-notes/${id}/items/${itemId}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-note-detail", vars.id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useDeleteConsignmentNoteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      api.del<void>(`/api/consignment-notes/${id}/items/${itemId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-note-detail", vars.id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

/* ════════════════════════════════════════════════════════════════════════
   Consignment Returns (CR) — server wraps list as { deliveryReturns } / detail
   as { deliveryReturn }.
   ════════════════════════════════════════════════════════════════════════ */

export type CrStatus = "PENDING" | "RECEIVED" | "INSPECTED" | "REFUNDED" | "CREDIT_NOTED" | "REJECTED" | "CANCELLED";

export type CrRow = {
  id: string;
  return_number: string;
  do_number: string | null;
  consignment_do_id: string | null;
  debtor_code: string | null;
  debtor_name: string;
  return_date: string | null;
  reason: string | null;
  status: CrStatus;
  refund_centi: number;
  currency: string;
  local_total_centi: number;
  line_count: number;
  warehouse_id: string | null;
  notes: string | null;
  created_at: string | null;
};

export type CrItemRow = {
  id: string;
  consignment_delivery_return_id: string;
  consignment_do_item_id: string | null;
  item_code: string;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string;
  qty_returned: number;
  condition: string | null;
  unit_price_centi: number;
  discount_centi: number;
  line_total_centi: number;
  unit_cost_centi: number;
  refund_centi: number;
  variants: Record<string, unknown> | null;
  notes: string | null;
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  created_at: string | null;
};

export type CrDetail = { deliveryReturn: CrRow & Record<string, unknown>; items: CrItemRow[] };

export type ReturnableCnLine = {
  noteItemId: string;
  consignmentDoId: string;
  noteNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  delivered: number;
  returned: number;
  remaining: number;
  unitPriceCenti: number;
  discountCenti: number;
  unitCostCenti: number;
  variants: Record<string, unknown> | null;
};

export type NewCrItem = {
  consignmentDoItemId?: string | null;
  itemCode: string;
  itemGroup?: string | null;
  description?: string | null;
  qtyReturned: number;
  condition?: string;
  unitPriceCenti: number;
  unitCostCenti?: number;
};

export function useConsignmentReturns(opts?: { status?: CrStatus }) {
  return useQuery({
    queryKey: ["consignment-returns", opts?.status ?? "all"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      const res = await api.get<{ deliveryReturns: CrRow[] }>(`/api/consignment-returns${params.toString() ? `?${params.toString()}` : ""}`);
      return res.deliveryReturns;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useConsignmentReturnDetail(id: string | null) {
  return useQuery({
    queryKey: ["consignment-return-detail", id],
    queryFn: () => api.get<CrDetail>(`/api/consignment-returns/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useReturnableCnLines() {
  return useQuery({
    queryKey: ["consignment-returnable-note-lines"],
    queryFn: async () => {
      const res = await api.get<{ lines: ReturnableCnLine[] }>(`/api/consignment-returns/returnable-note-lines`);
      return res.lines;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreateConsignmentReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { debtorName: string; consignmentDoId?: string | null; warehouseId?: string | null; reason?: string | null; notes?: string | null; items: NewCrItem[] } & Record<string, unknown>) =>
      api.post<{ id: string; returnNumber: string }>(`/api/consignment-returns`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consignment-returns"] });
      qc.invalidateQueries({ queryKey: ["consignment-returnable-note-lines"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCreateConsignmentReturnFromNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { picks: Array<{ noteItemId: string; qty: number; condition?: string }> }) =>
      api.post<{ id: string; returnNumber: string }>(`/api/consignment-returns/from-notes`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consignment-returns"] });
      qc.invalidateQueries({ queryKey: ["consignment-returnable-note-lines"] });
      qc.invalidateQueries({ queryKey: ["consignment-notes"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdateConsignmentReturnStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, inspectionNotes }: { id: string; status: CrStatus; inspectionNotes?: string }) =>
      api.patch<{ consignmentReturn: { id: string; status: string } }>(`/api/consignment-returns/${id}/status`, { status, inspectionNotes }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-returns"] });
      qc.invalidateQueries({ queryKey: ["consignment-return-detail", vars.id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdateConsignmentReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...body }: Record<string, unknown> & { id: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/consignment-returns/${id}/items/${itemId}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-return-detail", vars.id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useDeleteConsignmentReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      api.del<void>(`/api/consignment-returns/${id}/items/${itemId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["consignment-return-detail", vars.id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
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
