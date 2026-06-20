// ----------------------------------------------------------------------------
// Consignment Return query hooks — a faithful clone of the Delivery Return
// hooks in flow-queries.ts, repointed at the parallel backend route mounted at
// `/consignment-returns` (which mirrors `/delivery-returns` 1:1: same create
// body, same detail shape, same line endpoints).
//
// Numbering on the backend is `CRN-YYMM-NNN`. The request/response types are
// intentionally kept identical to the DR hooks so the cloned ConsignmentReturnNew
// / ConsignmentReturnDetail / ConsignmentReturns pages can render exactly like
// the DR ones with only the endpoint + query key swapped.
//
// A consignment-note detail hook is re-exported here for the New page's
// ?fromNote prefill convenience (mirrors DeliveryReturnNew's ?fromDo). It points
// at the consignment-note detail route.
//
// Query key namespace: ['consignment-return'] (+ '-detail') so cache
// invalidation never collides with the DR cache.
//
// ── HOUZS VENDOR NOTES ──────────────────────────────────────────────────────
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The supabase import is dropped.
//   - serviceNotify maps to the vendored dialog-service serviceNotify (already
//     registered by <Scm2990Shell>).
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceNotify } from './dialog-service';
import { authedFetch } from './authed-fetch';

/* ── Consignment Note detail (for ?fromNote prefill on the New page) ───── */
export const useConsignmentNoteDetailForReturn = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-note-detail', id],
  queryFn: () => authedFetch<{ deliveryOrder: any; items: any[] }>(`/consignment-notes/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: 1, retryDelay: 800,
});

/* ── List ────────────────────────────────────────────────────────────── */
export const useConsignmentReturns = (status?: string) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-return', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ deliveryReturns: any[] }>(
    `/consignment-returns${status ? `?status=${status}` : ''}`,
  ),
  staleTime: 30_000,
  retry: 1,
});

/* ── Returnable Consignment Note lines (From-Note multi-picker) ────────── */
export type ReturnableNoteLine = {
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
  variants: unknown;
};

export const useReturnableNoteLines = () => useQuery({
  queryKey: ['consignment-return', 'returnable-note-lines'],
  queryFn: () => authedFetch<{ lines: ReturnableNoteLine[] }>(
    `/consignment-returns/returnable-note-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: 1,
});

/* ── Detail ──────────────────────────────────────────────────────────── */
export const useConsignmentReturnDetail = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-return-detail', id],
  queryFn: () => authedFetch<{ deliveryReturn: any; items: any[] }>(`/consignment-returns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: 1, retryDelay: 800,
});

/* ── Create ──────────────────────────────────────────────────────────── */
export const useCreateConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      authedFetch<{ id: string; returnNumber: string }>(`/consignment-returns`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consignment-return'] }),
  });
};

/* ── Header update ───────────────────────────────────────────────────── */
export const useUpdateConsignmentReturnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-returns/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
    },
  });
};

/* ── Status update ───────────────────────────────────────────────────── */
export const useUpdateConsignmentReturnStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedFetch<{ deliveryReturn: unknown }>(`/consignment-returns/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    },
  });
};

/* ── Line items ──────────────────────────────────────────────────────── */
export const useAddConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/consignment-returns/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
    },
  });
};

export const useUpdateConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
    },
  });
};

export const useDeleteConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/consignment-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
    },
  });
};
