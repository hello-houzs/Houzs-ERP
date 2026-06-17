// ----------------------------------------------------------------------------
// Delivery Order (DO) + Sales Invoice (SI) + Delivery Return (DR) query hooks +
// types — ported from 2990s apps/backend/src/lib/flow-queries.ts (the DO/SI/DR
// slices). The wire SHAPES match the cloned /api/mfg-delivery-orders +
// /api/sales-invoices + /api/delivery-returns routes (rule #7). Only the SEAMS
// change (same playbook as every prior slice):
//   - Data layer: 2990s authedFetch + Supabase JS -> Houzs `api` client
//     (frontend/src/api/client.ts) + @tanstack/react-query.
//   - Endpoint bases: /api/mfg-delivery-orders/*, /api/sales-invoices/*,
//     /api/delivery-returns/*.
//
// Strategy-2 note: furniture variant/pricing fields exist on the wire (kept for
// fidelity) but the pages use plain product_code/qty/price. GL/AR posting (the
// SI `revenue` field) is out of SCM-clone scope -> the server returns
// { posted:false, status:"out_of_scope" }.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

/* ════════════════════════════════════════════════════════════════════════
   Delivery Orders
   ════════════════════════════════════════════════════════════════════════ */

export type DoStatus = "LOADED" | "DISPATCHED" | "IN_TRANSIT" | "SIGNED" | "DELIVERED" | "INVOICED" | "CANCELLED";

export type DoRow = {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  debtor_code: string | null;
  debtor_name: string;
  do_date: string | null;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  driver_name: string | null;
  vehicle: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  branding: string | null;
  ref: string | null;
  po_doc_no: string | null;
  sales_location: string | null;
  currency: string;
  warehouse_id: string | null;
  local_total_centi: number;
  total_cost_centi: number;
  total_margin_centi: number;
  line_count: number;
  status: DoStatus;
  notes: string | null;
  created_at: string | null;
  has_children?: boolean;
  lifecycle_state?: "shipped" | "invoiced" | "returned";
};

export type DoItemRow = {
  id: string;
  delivery_order_id: string;
  so_item_id: string | null;
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
  line_cost_centi: number;
  line_margin_centi: number;
  variants: Record<string, unknown> | null;
  notes: string | null;
  line_delivery_date: string | null;
  line_no: number | null;
  created_at: string | null;
  // Detail-route extras (server-resolved).
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  downstream?: Array<{ docNumber: string; docType: "SI" | "DR"; qty: number; status: string }>;
};

export type DoDetail = { deliveryOrder: DoRow; items: DoItemRow[] };

/** A SO line surfaced by /mfg-delivery-orders/deliverable-so-lines. */
export type DeliverableSoLine = {
  soItemId: string;
  docNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unitPriceCenti: number;
  unitCostCenti: number;
  discountCenti: number;
  delivered: number;
  returned: number;
  remaining: number;
  lineSeq: number;
};

export type DoPaymentRow = {
  id: string;
  delivery_order_id: string;
  paid_at: string | null;
  method: string | null;
  merchant_provider: string | null;
  amount_centi: number | null;
  account_sheet: string | null;
  collected_by: number | null;
  collected_by_name: string | null;
  note: string | null;
  created_at: string | null;
};

const DO_KEY = "mfg-delivery-orders";

export function useDeliveryOrders(filters?: { status?: string }) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set("status", filters.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery({
    queryKey: [DO_KEY, "list", filters ?? {}],
    queryFn: async () => (await api.get<{ deliveryOrders: DoRow[] }>(`/api/mfg-delivery-orders${suffix}`)).deliveryOrders,
    staleTime: 15_000,
  });
}

export function useDeliveryOrderDetail(id: string | null | undefined) {
  return useQuery({
    queryKey: [DO_KEY, "detail", id],
    queryFn: () => api.get<DoDetail>(`/api/mfg-delivery-orders/${id}`),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useDeliverableSoLines(docNos?: string) {
  const qs = docNos ? `?docNos=${encodeURIComponent(docNos)}` : "";
  return useQuery({
    queryKey: [DO_KEY, "deliverable-so-lines", docNos ?? ""],
    queryFn: async () => (await api.get<{ lines: DeliverableSoLine[] }>(`/api/mfg-delivery-orders/deliverable-so-lines${qs}`)).lines,
    staleTime: 10_000,
  });
}

export function useDeliveryOrderPayments(id: string | null | undefined) {
  return useQuery({
    queryKey: [DO_KEY, "payments", id],
    queryFn: async () => (await api.get<{ payments: DoPaymentRow[] }>(`/api/mfg-delivery-orders/${id}/payments`)).payments,
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

export function useCreateDeliveryOrderFromSos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { picks: Array<{ soItemId: string; qty: number }> }) => api.post<{ id: string; doNumber: string }>(`/api/mfg-delivery-orders/from-sos`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [DO_KEY, "list"] });
      qc.invalidateQueries({ queryKey: [DO_KEY, "deliverable-so-lines"] });
      qc.invalidateQueries({ queryKey: ["mfg-sales-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdateDeliveryOrderStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; status: DoStatus }) => api.patch(`/api/mfg-delivery-orders/${args.id}/status`, { status: args.status }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [DO_KEY, "list"] });
      qc.invalidateQueries({ queryKey: [DO_KEY, "detail", v.id] });
      qc.invalidateQueries({ queryKey: ["mfg-sales-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdateDeliveryOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...patch }: Record<string, unknown> & { id: string; itemId: string }) => api.patch(`/api/mfg-delivery-orders/${id}/items/${itemId}`, patch),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: [DO_KEY, "detail", v.id] }); qc.invalidateQueries({ queryKey: ["inventory"] }); },
  });
}

export function useDeleteDeliveryOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) => api.del(`/api/mfg-delivery-orders/${id}/items/${itemId}`),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: [DO_KEY, "detail", v.id] }); qc.invalidateQueries({ queryKey: ["inventory"] }); },
  });
}

/* ════════════════════════════════════════════════════════════════════════
   Sales Invoices
   ════════════════════════════════════════════════════════════════════════ */

export type SiStatus = "SENT" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "CANCELLED";

export type SiRow = {
  id: string;
  invoice_number: string;
  so_doc_no: string | null;
  delivery_order_id: string | null;
  debtor_code: string | null;
  debtor_name: string;
  invoice_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal_centi: number;
  total_centi: number;
  paid_centi: number;
  local_total_centi: number;
  ref: string | null;
  status: SiStatus;
  notes: string | null;
  created_at: string | null;
};

export type SiItemRow = {
  id: string;
  sales_invoice_id: string;
  do_item_id: string | null;
  item_code: string;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  tax_centi: number;
  line_total_centi: number;
  unit_cost_centi: number;
  variants: Record<string, unknown> | null;
  notes: string | null;
  line_no: number | null;
  created_at: string | null;
};

export type SiDetail = { salesInvoice: SiRow; items: SiItemRow[] };

/** A DO line surfaced by /sales-invoices/invoiceable-do-lines. */
export type InvoiceableDoLine = {
  doItemId: string;
  deliveryOrderId: string;
  doNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  unitPriceCenti: number;
  discountCenti: number;
  unitCostCenti: number;
  delivered: number;
  invoiced: number;
  returned: number;
  remaining: number;
  lineSeq: number;
};

export type SiPaymentRow = DoPaymentRow & { sales_invoice_id: string };

const SI_KEY = "sales-invoices";

export function useSalesInvoices(filters?: { status?: string }) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set("status", filters.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery({
    queryKey: [SI_KEY, "list", filters ?? {}],
    queryFn: async () => (await api.get<{ salesInvoices: SiRow[] }>(`/api/sales-invoices${suffix}`)).salesInvoices,
    staleTime: 15_000,
  });
}

export function useSalesInvoiceDetail(id: string | null | undefined) {
  return useQuery({
    queryKey: [SI_KEY, "detail", id],
    queryFn: () => api.get<SiDetail>(`/api/sales-invoices/${id}`),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useInvoiceableDoLines(doIds?: string) {
  const qs = doIds ? `?doIds=${encodeURIComponent(doIds)}` : "";
  return useQuery({
    queryKey: [SI_KEY, "invoiceable-do-lines", doIds ?? ""],
    queryFn: async () => (await api.get<{ lines: InvoiceableDoLine[] }>(`/api/sales-invoices/invoiceable-do-lines${qs}`)).lines,
    staleTime: 10_000,
  });
}

export function useSalesInvoicePayments(id: string | null | undefined) {
  return useQuery({
    queryKey: [SI_KEY, "payments", id],
    queryFn: async () => (await api.get<{ payments: SiPaymentRow[] }>(`/api/sales-invoices/${id}/payments`)).payments,
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

export function useCreateSalesInvoiceFromDos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { picks: Array<{ doItemId: string; qty: number }> }) => api.post<{ id: string; invoiceNumber: string }>(`/api/sales-invoices/from-dos`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [SI_KEY, "list"] });
      qc.invalidateQueries({ queryKey: [SI_KEY, "invoiceable-do-lines"] });
      qc.invalidateQueries({ queryKey: [DO_KEY, "list"] });
    },
  });
}

export function useUpdateSalesInvoiceStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; status: SiStatus | "ISSUED" }) => api.patch(`/api/sales-invoices/${args.id}/status`, { status: args.status }),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: [SI_KEY, "list"] }); qc.invalidateQueries({ queryKey: [SI_KEY, "detail", v.id] }); },
  });
}

export function useRecordSalesInvoicePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; paidAt: string; method: "merchant" | "transfer" | "cash" | "installment"; amountCenti: number; note?: string | null }) => {
      const { id, ...body } = args;
      return api.post(`/api/sales-invoices/${id}/payments`, body);
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: [SI_KEY, "payments", v.id] }); qc.invalidateQueries({ queryKey: [SI_KEY, "detail", v.id] }); qc.invalidateQueries({ queryKey: [SI_KEY, "list"] }); },
  });
}

export function useUpdateSalesInvoiceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...patch }: Record<string, unknown> & { id: string; itemId: string }) => api.patch(`/api/sales-invoices/${id}/items/${itemId}`, patch),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: [SI_KEY, "detail", v.id] }),
  });
}

export function useDeleteSalesInvoiceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) => api.del(`/api/sales-invoices/${id}/items/${itemId}`),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: [SI_KEY, "detail", v.id] }),
  });
}

/* ════════════════════════════════════════════════════════════════════════
   Delivery Returns
   ════════════════════════════════════════════════════════════════════════ */

export type DrStatus = "PENDING" | "RECEIVED" | "INSPECTED" | "REFUNDED" | "CREDIT_NOTED" | "REJECTED" | "CANCELLED";

export type DrRow = {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  delivery_order_id: string | null;
  debtor_code: string | null;
  debtor_name: string;
  return_date: string | null;
  reason: string | null;
  status: DrStatus;
  refund_centi: number;
  local_total_centi: number;
  line_count: number;
  currency: string;
  warehouse_id: string | null;
  notes: string | null;
  created_at: string | null;
};

export type DrItemRow = {
  id: string;
  delivery_return_id: string;
  do_item_id: string | null;
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
  created_at: string | null;
  warehouse_id?: string | null;
  warehouse_code?: string | null;
};

export type DrDetail = { deliveryReturn: DrRow; items: DrItemRow[] };

/** A DO line surfaced by /delivery-returns/returnable-do-lines. */
export type ReturnableDoLine = InvoiceableDoLine;

const DR_KEY = "delivery-returns";

export function useDeliveryReturns(filters?: { status?: string }) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set("status", filters.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery({
    queryKey: [DR_KEY, "list", filters ?? {}],
    queryFn: async () => (await api.get<{ deliveryReturns: DrRow[] }>(`/api/delivery-returns${suffix}`)).deliveryReturns,
    staleTime: 15_000,
  });
}

export function useDeliveryReturnDetail(id: string | null | undefined) {
  return useQuery({
    queryKey: [DR_KEY, "detail", id],
    queryFn: () => api.get<DrDetail>(`/api/delivery-returns/${id}`),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useReturnableDoLines(doIds?: string) {
  const qs = doIds ? `?doIds=${encodeURIComponent(doIds)}` : "";
  return useQuery({
    queryKey: [DR_KEY, "returnable-do-lines", doIds ?? ""],
    queryFn: async () => (await api.get<{ lines: ReturnableDoLine[] }>(`/api/delivery-returns/returnable-do-lines${qs}`)).lines,
    staleTime: 10_000,
  });
}

export function useCreateDeliveryReturnFromDos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { picks: Array<{ doItemId: string; qty: number; condition?: string }> }) => api.post<{ id: string; returnNumber: string }>(`/api/delivery-returns/from-dos`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [DR_KEY, "list"] });
      qc.invalidateQueries({ queryKey: [DR_KEY, "returnable-do-lines"] });
      qc.invalidateQueries({ queryKey: [DO_KEY, "list"] });
      qc.invalidateQueries({ queryKey: ["mfg-sales-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdateDeliveryReturnStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; status: DrStatus; inspectionNotes?: string }) => api.patch(`/api/delivery-returns/${args.id}/status`, { status: args.status, inspectionNotes: args.inspectionNotes }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [DR_KEY, "list"] });
      qc.invalidateQueries({ queryKey: [DR_KEY, "detail", v.id] });
      qc.invalidateQueries({ queryKey: ["mfg-sales-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdateDeliveryReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...patch }: Record<string, unknown> & { id: string; itemId: string }) => api.patch(`/api/delivery-returns/${id}/items/${itemId}`, patch),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: [DR_KEY, "detail", v.id] }); qc.invalidateQueries({ queryKey: ["inventory"] }); },
  });
}

export function useDeleteDeliveryReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) => api.del(`/api/delivery-returns/${id}/items/${itemId}`),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: [DR_KEY, "detail", v.id] }); qc.invalidateQueries({ queryKey: ["inventory"] }); },
  });
}
