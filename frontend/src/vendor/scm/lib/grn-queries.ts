// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — the GRN (Goods
// Received Note) query/mutation surface the vendored GRN pages call.
//
// The full source flow-queries.ts is ~1996 lines (the entire SO/DO/SI/PO/GRN/PI
// /return query surface + verified-save + supabase + serviceNotify). Only the
// GRN hooks are pulled here, copied VERBATIM except for the boundary:
//   • import { authedFetch } from './authed-fetch' (the repointed vendored fetch
//     → /api/scm), instead of the source's relative './authed-fetch' that pulled
//     in supabase.
//   • the dropped `import { supabase }` / `verifiedSave` machinery — none of the
//     GRN hooks below reference it (they all go through authedFetch).
//   • serviceNotify (cancel onError toast) is the vendored dialog-service bridge.
//
// The picker hooks (useOutstandingPoItems / useCreateGrnsFromPoItems) already
// live in suppliers-queries.ts — NOT duplicated here; the from-PO page imports
// useOutstandingPoItems from there.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';

/* ── Batch conversions ──────────────────────────────────────────────── */
export const useGrnFromPos = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseOrderIds: string[]; deliveryNoteRef?: string; notes?: string }) =>
      authedFetch<{ id: string; grnNumber: string; poCount: number; lineCount: number }>(
        `/grns/from-pos`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      /* Force picker refetch so received PO lines drop off. */
      qc.invalidateQueries({ queryKey: ['grns', 'outstanding-po-items'], refetchType: 'all' });
    },
  });
};

export const usePurchaseReturnFromGrns = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { grnIds: string[]; reason?: string; notes?: string }) =>
      authedFetch<{ id: string; returnNumber: string; grnCount: number; lineCount: number }>(
        `/purchase-returns/from-grns`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      /* Force picker refetch so returned/invoiced GRN lines drop off. */
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
  });
};

/* ── GRN ─────────────────────────────────────────────────────────────── */
export const useGrns = (status?: string) =>
  useQuery({
    queryKey: ['grns', status ?? 'all'],
    queryFn: () => authedFetch<{ grns: any[] }>(`/grns${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
export const useGrnDetail = (id: string | null) => useQuery({
  queryKey: ['grn-detail', id],
  queryFn: () => authedFetch<{ grn: any; items: any[] }>(`/grns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: 1, retryDelay: 800,
});
export const useCreateGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => authedFetch<{ id: string; grnNumber: string }>(`/grns`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['grns'] }),
  });
};
/* Confirm a DRAFT GRN → POSTED (PATCH /grns/:id/post). This is the commit
   chokepoint: the server runs postGrnAndRollup here (inventory IN + PO
   received-rollup). Also used right after a non-draft create as an idempotent
   no-op (the row is already POSTED). Invalidates the GRN detail + list +
   inventory so the page + on-hand reflect the just-committed receipt. */
export const usePostGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/grns/${id}/post`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

/* ── GRN PO-clone CRUD (mirror the PO header + line item hooks) ─────────────
   PATCH /grns/:id (header), POST/PATCH/DELETE /grns/:id/items[/:itemId].
   Each invalidates the GRN detail (['grn-detail', id]) + list (['grns']) —
   the same query keys useGrnDetail + useGrns read. */
export const useUpdateGrnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; receivedAt?: string; deliveryNoteRef?: string;
      warehouseId?: string; notes?: string; currency?: string;
    }) => authedFetch<{ grn: any }>(`/grns/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
    },
  });
};

export const useAddGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, ...body }: { grnId: string } & Record<string, unknown>) =>
      authedFetch<{ item: any }>(`/grns/${grnId}/items`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
    },
  });
};

export const useUpdateGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId, ...body }: { grnId: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true }>(`/grns/${grnId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
    },
  });
};

export const useDeleteGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId }: { grnId: string; itemId: string }) =>
      authedFetch<void>(`/grns/${grnId}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
    },
  });
};

/* ── Cancel a GRN (mirror useCancelPurchaseOrder) ──────────────────────────
   PATCH /grns/:id/cancel — server flips status → CANCELLED and reverses the
   receipt (inventory OUT + PO received_qty decrement). Invalidates the GRN
   detail + list + inventory so the on-hand drilldown reflects the reversal. */
export const useCancelGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ grn: any }>(`/grns/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel GRN failed', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    },
  });
};

/* ── Single-GRN conversions (GRN list right-click) ─────────────────────────
   POST /purchase-invoices/from-grn + /purchase-returns/from-grn take { grnId }
   and return the created doc's { id } so the caller can navigate straight in. */
export const usePurchaseInvoiceFromGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grnId: string) =>
      authedFetch<{ id: string; invoiceNumber: string }>(`/purchase-invoices/from-grn`, {
        method: 'POST', body: JSON.stringify({ grnId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      /* Force picker refetch so already-invoiced GRN lines drop off. */
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
  });
};

export const usePurchaseReturnFromGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grnId: string) =>
      authedFetch<{ id: string; returnNumber: string }>(`/purchase-returns/from-grn`, {
        method: 'POST', body: JSON.stringify({ grnId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      /* Force picker refetch so returned GRN lines drop off. */
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
  });
};
