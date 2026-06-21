// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — the Purchase Invoice
// (PI) query/mutation surface the vendored PI pages call.
//
// Copied VERBATIM from the source flow-queries.ts PI section except for the
// boundary:
//   • import { authedFetch } from './authed-fetch' (the repointed vendored fetch
//     → /api/scm).
//   • the dropped `import { supabase }` / `verified-save` machinery — none of the
//     PI hooks below reference it (they all go through authedFetch).
//   • serviceNotify (cancel onError toast) is the vendored dialog-service bridge.
//
// The picker hooks (useOutstandingGrnItems / useCreatePisFromGrnItems) already
// live in suppliers-queries.ts — NOT duplicated here; the from-GRN page imports
// useOutstandingGrnItems from there.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';

/* ── Purchase Invoice ────────────────────────────────────────────────── */
export const usePurchaseInvoices = (status?: string) =>
  useQuery({
    queryKey: ['purchase-invoices', status ?? 'all'],
    queryFn: () => authedFetch<{ purchaseInvoices: any[] }>(`/purchase-invoices${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
export const usePurchaseInvoiceDetail = (id: string | null) => useQuery({
  queryKey: ['purchase-invoice-detail', id],
  queryFn: () => authedFetch<{ purchaseInvoice: any; items: any[] }>(`/purchase-invoices/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: 1, retryDelay: 800,
});
export const usePostPurchaseInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-invoices/${id}/post`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', id] });
    },
  });
};
export const useRecordPiPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amountCenti, notes }: { id: string; amountCenti: number; notes?: string }) =>
      authedFetch(`/purchase-invoices/${id}/payment`, {
        method: 'PATCH', body: JSON.stringify({ amountCenti, notes }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
    },
  });
};
export const useCancelPurchaseInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-invoices/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel invoice failed', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    },
  });
};

export const useCreatePurchaseInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => authedFetch<{ id: string; invoiceNumber: string }>(`/purchase-invoices`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase-invoices'] }),
  });
};

/* ── PI PO-clone CRUD (mirror the GRN/PR header + line item hooks) ──────────
   PATCH /purchase-invoices/:id (header), POST/PATCH/DELETE
   /purchase-invoices/:id/items[/:itemId]. Each invalidates the PI detail
   (['purchase-invoice-detail', id]) + list (['purchase-invoices']) — the same
   query keys usePurchaseInvoiceDetail + usePurchaseInvoices read. */
export const useUpdatePurchaseInvoiceHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; supplierInvoiceRef?: string; invoiceDate?: string;
      dueDate?: string; currency?: string; notes?: string;
    }) => authedFetch<{ purchaseInvoice: any }>(`/purchase-invoices/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

export const useUpdatePurchaseInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...body }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true }>(`/purchase-invoices/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

export const useDeletePurchaseInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/purchase-invoices/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

/* T12 — free-add a NEW line to an existing PI (PI is free-entry, grnId:null is
   first-class). POST /purchase-invoices/:id/items already accepts the full line
   payload (materialCode/materialName/itemGroup/variants + qty/price) and
   server-recomputes description2. Mirrors useAddGrnItem; invalidates the same
   keys usePurchaseInvoiceDetail + usePurchaseInvoices read. */
export const useAddPurchaseInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/purchase-invoices/${id}/items`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};
