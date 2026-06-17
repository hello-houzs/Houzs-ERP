// ----------------------------------------------------------------------------
// Purchase Invoice (PI) + Purchase Return (PR) query hooks + types — ported from
// 2990s apps/backend/src/lib/flow-queries.ts + suppliers-queries.ts (the PI/PR
// slices of them). The wire SHAPES (PiRow / PiItemRow / PrRow / PrItemRow / the
// create + mutate bodies) are identical to 2990s (rule #7). Only the SEAMS change
// (same playbook as the Suppliers/PO/Inventory/GRN slices):
//   - Data layer: 2990s authedFetch + Supabase JS -> Houzs `api` client
//     (frontend/src/api/client.ts) + @tanstack/react-query.
//   - Endpoint base: 2990s `/purchase-invoices/*` + `/purchase-returns/*` ->
//     Houzs `/api/purchase-invoices/*` + `/api/purchase-returns/*` (mounts).
//   - Co-located here + re-exported for the PI/PR pages (the slice ships its
//     files; no shared lib package).
//
// Strategy-2 note: GL/accounting AP-posting is out of SCM clone scope (Houzs GL
// differs); the PI payment-status endpoint IS wired (useRecordPiPayment). The
// 2990s recost / DO-SI chain is not cloned — no hook here.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

/* ════════════════════════════════════════════════════════════════════════
   Purchase Invoices
   ════════════════════════════════════════════════════════════════════════ */

export type PiStatus = "POSTED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";

export type PiRow = {
  id: string;
  invoice_number: string;
  supplier_invoice_ref: string | null;
  supplier_id: string;
  purchase_order_id: string | null;
  grn_id: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  paid_centi: number;
  status: PiStatus;
  notes: string | null;
  posted_at: string | null;
  created_at: string | null;
  created_by: number | null;
  updated_at: string | null;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_order?: { id: string; po_number: string } | null;
  grn?: { id: string; grn_number: string } | null;
};

export type PiItemRow = {
  id: string;
  purchase_invoice_id: string;
  grn_item_id: string | null;
  material_kind: "mfg_product" | "fabric" | "raw";
  material_code: string;
  material_name: string;
  qty: number;
  unit_price_centi: number;
  line_total_centi: number;
  notes: string | null;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string;
  discount_centi: number;
  variants: Record<string, unknown> | null;
  unit_cost_centi: number;
  created_at: string | null;
};

export type PiDetail = { purchaseInvoice: PiRow; items: PiItemRow[] };

/** A GRN line surfaced by /purchase-invoices/outstanding-grn-items. */
export type OutstandingGrnItem = {
  grnItemId: string;
  grnId: string;
  grnDocNo: string;
  receivedAt: string | null;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  purchaseOrderId: string | null;
  poDocNo: string | null;
  itemCode: string;
  description: string | null;
  itemGroup: string;
  qtyAccepted: number;
  invoicedQty: number;
  remaining: number;
  unitPriceCenti: number;
  variants: Record<string, unknown> | null;
};

/** Per-line draft sent to POST /purchase-invoices. */
export type NewPiItem = {
  grnItemId?: string | null;
  materialKind: "mfg_product" | "fabric" | "raw";
  materialCode: string;
  materialName: string;
  qty: number;
  unitPriceCenti: number;
  discountCenti?: number;
  notes?: string;
  itemGroup?: string | null;
  variants?: Record<string, unknown> | null;
};

export function usePurchaseInvoices(opts?: { status?: PiStatus }) {
  return useQuery({
    queryKey: ["purchase-invoices", opts?.status ?? "all"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      const res = await api.get<{ purchaseInvoices: PiRow[] }>(`/api/purchase-invoices${params.toString() ? `?${params.toString()}` : ""}`);
      return res.purchaseInvoices;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function usePurchaseInvoiceDetail(id: string | null) {
  return useQuery({
    queryKey: ["purchase-invoice-detail", id],
    queryFn: () => api.get<PiDetail>(`/api/purchase-invoices/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useOutstandingGrnItems() {
  return useQuery({
    queryKey: ["pi-outstanding-grn-items"],
    queryFn: async () => {
      const res = await api.get<{ items: OutstandingGrnItem[] }>(`/api/purchase-invoices/outstanding-grn-items`);
      return res.items;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreatePurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      supplierId: string;
      purchaseOrderId?: string | null;
      grnId?: string | null;
      supplierInvoiceRef?: string;
      invoiceDate?: string;
      dueDate?: string;
      notes?: string;
      items: NewPiItem[];
    }) => api.post<{ id: string; invoiceNumber: string }>(`/api/purchase-invoices`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["pi-outstanding-grn-items"] });
    },
  });
}

export function usePostPurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ purchaseInvoice: { id: string; status: string } }>(`/api/purchase-invoices/${id}/post`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-invoices"] }),
  });
}

export function useRecordPiPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amountCenti, notes }: { id: string; amountCenti: number; notes?: string }) =>
      api.patch<{ purchaseInvoice: { id: string; paid_centi: number; status: string } }>(`/api/purchase-invoices/${id}/payment`, { amountCenti, notes }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase-invoice-detail", vars.id] });
    },
  });
}

export function useCancelPurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ purchaseInvoice: { id: string; status: string } }>(`/api/purchase-invoices/${id}/cancel`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase-invoice-detail", id] });
      qc.invalidateQueries({ queryKey: ["grns"] });
    },
  });
}

export function useUpdatePurchaseInvoiceHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Record<string, unknown> & { id: string }) =>
      api.patch<{ purchaseInvoice: PiRow }>(`/api/purchase-invoices/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase-invoice-detail", vars.id] });
    },
  });
}

export function useUpdatePurchaseInvoiceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ piId, itemId, ...body }: Record<string, unknown> & { piId: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/purchase-invoices/${piId}/items/${itemId}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase-invoice-detail", vars.piId] });
      qc.invalidateQueries({ queryKey: ["grns"] });
    },
  });
}

export function useDeletePurchaseInvoiceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ piId, itemId }: { piId: string; itemId: string }) =>
      api.del<void>(`/api/purchase-invoices/${piId}/items/${itemId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase-invoice-detail", vars.piId] });
      qc.invalidateQueries({ queryKey: ["grns"] });
    },
  });
}

/* ════════════════════════════════════════════════════════════════════════
   Purchase Returns
   ════════════════════════════════════════════════════════════════════════ */

export type PrStatus = "POSTED" | "COMPLETED" | "CANCELLED";

export type PrRow = {
  id: string;
  return_number: string;
  purchase_order_id: string | null;
  grn_id: string | null;
  supplier_id: string;
  return_date: string | null;
  reason: string | null;
  status: PrStatus;
  posted_at: string | null;
  completed_at: string | null;
  credit_note_ref: string | null;
  refund_centi: number;
  notes: string | null;
  created_at: string | null;
  created_by: number | null;
  updated_at: string | null;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_order?: { id: string; po_number: string } | null;
  grn?: { id: string; grn_number: string } | null;
};

export type PrItemRow = {
  id: string;
  purchase_return_id: string;
  grn_item_id: string | null;
  material_kind: "mfg_product" | "fabric" | "raw";
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
  /* Detail-route extra (server-resolved per-line warehouse). */
  warehouse_id?: string | null;
  warehouse_code?: string | null;
};

export type PrDetail = { purchaseReturn: PrRow; items: PrItemRow[] };

/** Per-line draft sent to POST /purchase-returns. */
export type NewPrItem = {
  grnItemId?: string | null;
  materialKind: "mfg_product" | "fabric" | "raw";
  materialCode: string;
  materialName: string;
  qtyReturned: number;
  unitPriceCenti: number;
  reason?: string;
  notes?: string;
  itemGroup?: string | null;
  variants?: Record<string, unknown> | null;
};

export function usePurchaseReturns(opts?: { status?: PrStatus; supplierId?: string }) {
  return useQuery({
    queryKey: ["purchase-returns", opts?.status ?? "all", opts?.supplierId ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.supplierId) params.set("supplierId", opts.supplierId);
      const res = await api.get<{ purchaseReturns: PrRow[] }>(`/api/purchase-returns${params.toString() ? `?${params.toString()}` : ""}`);
      return res.purchaseReturns;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function usePurchaseReturnDetail(id: string | null) {
  return useQuery({
    queryKey: ["purchase-return-detail", id],
    queryFn: () => api.get<PrDetail>(`/api/purchase-returns/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreatePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      supplierId: string;
      purchaseOrderId?: string | null;
      grnId?: string | null;
      returnDate?: string;
      reason?: string;
      notes?: string;
      items: NewPrItem[];
    }) => api.post<{ id: string; returnNumber: string }>(`/api/purchase-returns`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-returns"] });
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCompletePurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, creditNoteRef }: { id: string; creditNoteRef?: string }) =>
      api.patch<{ purchaseReturn: { id: string; status: string } }>(`/api/purchase-returns/${id}/complete`, { creditNoteRef }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase-returns"] });
      qc.invalidateQueries({ queryKey: ["purchase-return-detail", vars.id] });
    },
  });
}

export function useCancelPurchaseReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ purchaseReturn: { id: string; status: string } }>(`/api/purchase-returns/${id}/cancel`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["purchase-returns"] });
      qc.invalidateQueries({ queryKey: ["purchase-return-detail", id] });
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useUpdatePurchaseReturnHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Record<string, unknown> & { id: string }) =>
      api.patch<{ purchaseReturn: PrRow }>(`/api/purchase-returns/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase-returns"] });
      qc.invalidateQueries({ queryKey: ["purchase-return-detail", vars.id] });
    },
  });
}

export function useUpdatePurchaseReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prId, itemId, ...body }: Record<string, unknown> & { prId: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/purchase-returns/${prId}/items/${itemId}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase-return-detail", vars.prId] });
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useDeletePurchaseReturnItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prId, itemId }: { prId: string; itemId: string }) =>
      api.del<void>(`/api/purchase-returns/${prId}/items/${itemId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase-return-detail", vars.prId] });
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
