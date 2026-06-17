// ----------------------------------------------------------------------------
// Sales Order (SO) query hooks + types — ported from 2990s apps/backend/src/lib/
// flow-queries.ts (the SO slice). The wire SHAPES (SoRow / SoItemRow / SoDetail /
// the create + mutate bodies) match the cloned /api/mfg-sales-orders route
// exactly (rule #7). Only the SEAMS change (same playbook as every prior slice):
//   - Data layer: 2990s authedFetch + Supabase JS -> Houzs `api` client
//     (frontend/src/api/client.ts) + @tanstack/react-query.
//   - Endpoint base: /api/mfg-sales-orders/*.
//
// Strategy-2 note: the furniture pricing/variant/PWP fields exist on the wire
// (kept for fidelity) but the pages don't surface a configurator — SO lines are
// plain product_code/qty/price. DO/SI-dependent aggregates (delivery_state /
// lifecycle / deliveries) come back as faithful empties until those slices land.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

export type SoStatus =
  | "CONFIRMED"
  | "IN_PRODUCTION"
  | "READY_TO_SHIP"
  | "SHIPPED"
  | "DELIVERED"
  | "INVOICED"
  | "CLOSED"
  | "ON_HOLD"
  | "CANCELLED";

export type SoRow = {
  doc_no: string;
  so_date: string;
  branding: string | null;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  po_doc_no: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  venue: string | null;
  address1: string | null;
  address2: string | null;
  customer_state: string | null;
  city: string | null;
  postcode: string | null;
  currency: string;
  status: SoStatus;
  local_total_centi: number;
  total_revenue_centi: number;
  mattress_sofa_centi: number;
  bedframe_centi: number;
  accessories_centi: number;
  others_centi: number;
  service_centi: number;
  deposit_centi: number;
  paid_centi: number;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  proceeded_at: string | null;
  created_at: string | null;
  // List-only aggregates (server-computed).
  item_categories?: string[];
  has_children?: boolean;
  delivery_state?: "none" | "partial" | "full";
  lifecycle_state?: string;
  current_doc_no?: string | null;
  has_undelivered?: boolean;
  stock_remark?: string;
  is_main_ready?: boolean;
  first_item_category?: string | null;
  first_item_branding?: string | null;
  payment_methods_summary?: string;
  ready_categories?: string[];
  is_fully_ready?: boolean;
  // Detail-only.
  paid_centi_total?: number;
  balance_centi?: number;
  customer_credit_centi?: number;
};

export type SoItemRow = {
  id: string;
  doc_no: string;
  line_date: string;
  item_group: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  location: string | null;
  warehouse_id: string | null;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  total_centi: number;
  total_inc_centi: number;
  balance_centi: number;
  payment_status: string;
  remark: string | null;
  cancelled: boolean;
  variants: Record<string, unknown> | null;
  unit_cost_centi: number;
  line_cost_centi: number;
  line_margin_centi: number;
  po_qty_picked: number;
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean;
  stock_status: string;
  stock_qty_ready: number;
  line_no: number | null;
  created_at: string | null;
  // Detail-only (DO/MRP — empty until those slices land).
  deliveries?: unknown[];
  delivered_qty?: number;
  remaining_qty?: number;
  stock_state?: string | null;
  coverage_po?: string | null;
  coverage_eta?: string | null;
};

export type SoDetail = { salesOrder: SoRow; items: SoItemRow[]; pwpCodes: unknown[] };

export type SoPaymentRow = {
  id: string;
  so_doc_no: string;
  paid_at: string | null;
  method: string | null;
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_centi: number | null;
  account_sheet: string | null;
  is_deposit: boolean;
  collected_by: number | null;
  collected_by_name: string | null;
  created_at: string | null;
};

export type SoAuditEntry = {
  id: string;
  so_doc_no: string;
  action: string;
  actor_id: number | null;
  actor_name_snapshot: string | null;
  field_changes: Array<{ field: string; from?: unknown; to?: unknown }>;
  status_snapshot: string | null;
  source: string | null;
  note: string | null;
  created_at: string | null;
};

/* New SO line — the generic shape POST /mfg-sales-orders + /:docNo/items accept. */
export type NewSoItem = {
  itemGroup: string;
  itemCode: string;
  description?: string | null;
  description2?: string | null;
  uom?: string;
  qty: number;
  unitPriceCenti: number;
  discountCenti?: number;
  unitCostCenti?: number;
  warehouseId?: string | null;
  variants?: Record<string, unknown> | null;
  lineDeliveryDate?: string | null;
};

export type CreateSoBody = {
  debtorName: string;
  phone: string;
  debtorCode?: string | null;
  agent?: string | null;
  branding?: string | null;
  ref?: string | null;
  poDocNo?: string | null;
  venue?: string | null;
  email?: string | null;
  customerType?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  postcode?: string | null;
  customerState?: string | null;
  buildingType?: string | null;
  customerDeliveryDate?: string | null;
  internalExpectedDd?: string | null;
  note?: string | null;
  currency?: string;
  items?: NewSoItem[];
};

const SO_KEY = "mfg-sales-orders";

export function useSalesOrders(filters?: { status?: string; debtor?: string }) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set("status", filters.status);
  if (filters?.debtor) qs.set("debtor", filters.debtor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery({
    queryKey: [SO_KEY, "list", filters ?? {}],
    queryFn: async () => {
      const res = await api.get<{ salesOrders: SoRow[] }>(`/api/mfg-sales-orders${suffix}`);
      return res.salesOrders;
    },
    staleTime: 15_000,
  });
}

export function useSalesOrderDetail(docNo: string | null | undefined) {
  return useQuery({
    queryKey: [SO_KEY, "detail", docNo],
    queryFn: async () => api.get<SoDetail>(`/api/mfg-sales-orders/${docNo}`),
    enabled: Boolean(docNo),
    staleTime: 10_000,
  });
}

export function useSalesOrderPayments(docNo: string | null | undefined) {
  return useQuery({
    queryKey: [SO_KEY, "payments", docNo],
    queryFn: async () => {
      const res = await api.get<{ payments: SoPaymentRow[] }>(`/api/mfg-sales-orders/${docNo}/payments`);
      return res.payments;
    },
    enabled: Boolean(docNo),
    staleTime: 15_000,
  });
}

export function useSalesOrderAuditLog(docNo: string | null | undefined) {
  return useQuery({
    queryKey: [SO_KEY, "audit-log", docNo],
    queryFn: async () => {
      const res = await api.get<{ entries: SoAuditEntry[] }>(`/api/mfg-sales-orders/${docNo}/audit-log`);
      return res.entries;
    },
    enabled: Boolean(docNo),
    staleTime: 15_000,
  });
}

export function useCreateSalesOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateSoBody) => api.post<{ docNo: string; doc_no: string }>(`/api/mfg-sales-orders`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [SO_KEY, "list"] }),
  });
}

export function useUpdateSalesOrderStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { docNo: string; status: SoStatus; notes?: string }) =>
      api.patch(`/api/mfg-sales-orders/${args.docNo}/status`, { status: args.status, notes: args.notes }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [SO_KEY, "list"] });
      qc.invalidateQueries({ queryKey: [SO_KEY, "detail", v.docNo] });
      qc.invalidateQueries({ queryKey: [SO_KEY, "audit-log", v.docNo] });
    },
  });
}

export function useUpdateSalesOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { docNo: string; patch: Record<string, unknown> }) =>
      api.patch(`/api/mfg-sales-orders/${args.docNo}`, args.patch),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [SO_KEY, "list"] });
      qc.invalidateQueries({ queryKey: [SO_KEY, "detail", v.docNo] });
    },
  });
}

export function useAddSalesOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { docNo: string; item: NewSoItem }) => api.post(`/api/mfg-sales-orders/${args.docNo}/items`, args.item),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: [SO_KEY, "detail", v.docNo] }),
  });
}

export function useUpdateSalesOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { docNo: string; itemId: string; patch: Record<string, unknown> }) =>
      api.patch(`/api/mfg-sales-orders/${args.docNo}/items/${args.itemId}`, args.patch),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: [SO_KEY, "detail", v.docNo] }),
  });
}

export function useDeleteSalesOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { docNo: string; itemId: string }) => api.del(`/api/mfg-sales-orders/${args.docNo}/items/${args.itemId}`),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: [SO_KEY, "detail", v.docNo] }),
  });
}

export function useRecordSalesOrderPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      docNo: string;
      paidAt: string;
      method: "merchant" | "transfer" | "cash" | "installment";
      amountCenti: number;
      merchantProvider?: string | null;
      installmentMonths?: number | null;
      onlineType?: string | null;
      approvalCode?: string | null;
      accountSheet?: string | null;
      note?: string | null;
    }) => {
      const { docNo, ...body } = args;
      return api.post(`/api/mfg-sales-orders/${docNo}/payments`, body);
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [SO_KEY, "payments", v.docNo] });
      qc.invalidateQueries({ queryKey: [SO_KEY, "detail", v.docNo] });
    },
  });
}

export function useDeleteSalesOrderPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { docNo: string; id: string }) => api.del(`/api/mfg-sales-orders/${args.docNo}/payments/${args.id}`),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [SO_KEY, "payments", v.docNo] });
      qc.invalidateQueries({ queryKey: [SO_KEY, "detail", v.docNo] });
    },
  });
}

export function useSetSalesOrderItemStockStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { docNo: string; itemId: string; status: "PENDING" | "READY" }) =>
      api.patch(`/api/mfg-sales-orders/${args.docNo}/items/${args.itemId}/stock-status`, { status: args.status }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [SO_KEY, "detail", v.docNo] });
      qc.invalidateQueries({ queryKey: [SO_KEY, "list"] });
    },
  });
}
