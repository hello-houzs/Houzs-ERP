// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — ONLY the
// Delivery-Order (mfg) read / detail / status / item / payment hooks the
// vendored DO list / new / from-so / detail pages use. The SI / DR hooks that
// share the same source module are intentionally NOT vendored here.
//
// HOUZS VENDOR NOTES:
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The 409 short-stock "ship anyway?" prompt and
//     the sofa whole-set hard-block live inside authedFetch, so the DO create /
//     item mutations get them for free (mirrors the source).
//   - serviceNotify (the non-React error toast bridge) maps to the vendored
//     dialog-service serviceNotify.
//   - The source's releaseSoSideQueries cross-invalidation (SO list/detail +
//     the deliverable-so-lines picker) is preserved verbatim so a released qty
//     immediately re-appears in the SO-side menus.
//   - useMfgSalesOrderDetail + useSalesOrderPayments are NOT re-defined here:
//     the New-DO prefill imports them, but they already live in the vendored
//     sales-order-queries module — re-exported below so the page's single
//     import site keeps working.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { invalidateSoLists } from './sales-order-queries';

// Re-export the SO-side prefill hooks the New-DO page pulls from this module in
// the source (they live in the vendored SO slice — single source of truth).
export { useMfgSalesOrderDetail, useSalesOrderPayments } from './sales-order-queries';

/* ── Deliverable SO lines (line-level partial-delivery picker) ───────────── */
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
  variants: unknown;
  delivered: number;
  returned: number;
  remaining: number;
};

export const useDeliverableSoLines = () => useQuery({
  queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'],
  queryFn: () => authedFetch<{ lines: DeliverableSoLine[] }>(
    `/delivery-orders-mfg/deliverable-so-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: 1,
});

/* Remaining deliverable lines scoped to ONE Sales Order — feeds the SO-linked
   DO Detail "Add Line" picker so it can only add the SO's still-undelivered
   lines (qty capped to remaining), matching the line-level convert picker.
   Disabled when the DO has no parent SO (ad-hoc DO keeps the free add). */
export const useDeliverableSoLinesForDoc = (docNo: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', 'deliverable-so-lines', docNo],
  enabled: !!docNo,
  queryFn: () => authedFetch<{ lines: DeliverableSoLine[] }>(
    `/delivery-orders-mfg/deliverable-so-lines?docNos=${encodeURIComponent(docNo!)}`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: 1,
});

/* ── DO (mfg) ─────────────────────────────────────────────────────────── */

/* Any DO write that changes a delivered qty (create / cancel / add-line /
   qty-change / delete-line) moves the SO line's live remaining-to-deliver. The
   SO list's "still has undelivered" flag (which shows/hides the Issue-DO menu)
   and the SO-scoped convert pickers read off that number, so they must refetch
   too — otherwise a released qty looks stuck and the menu stays hidden until a
   hard refresh. Mirrors the explicit refetch useConvertSoLinesToDo already does. */
const releaseSoSideQueries = (qc: ReturnType<typeof useQueryClient>) => {
  // Both list keys: the "still has undelivered" flag above lives on the V2 paged
  // list, which is a sibling key of ['mfg-sales-orders'], not nested under it.
  invalidateSoLists(qc);
  qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail'] });
  qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'], refetchType: 'all' });
};

export const useMfgDeliveryOrders = (status?: string) => useQuery({
  queryKey: ['mfg-delivery-orders', status ?? 'all'],
  queryFn: () => authedFetch<{ deliveryOrders: any[] }>(`/delivery-orders-mfg${status ? `?status=${status}` : ''}`),
  staleTime: 30_000,
  retry: 1,
  retryDelay: 800,
});

// Opt-in server-side pagination + search + sort + status-counts (mirrors
// useMfgSalesOrdersPaged). Sending `page` switches the /delivery-orders-mfg
// endpoint into its paginated contract ({ deliveryOrders, total, page,
// pageSize, statusCounts }); the legacy useMfgDeliveryOrders above (no page)
// still returns the historical unpaginated list.
// `status` here is the RESOLVED delivery_orders.status DB value (UPPERCASE) —
// the caller maps its compressed filter-pill bucket to a DB status first, and
// passes undefined for multi-status buckets the single-status filter can't
// express (open/in_transit/delivered), so those show all rows still counted.
export function useMfgDeliveryOrdersPaged(params: { page: number; pageSize: number; status?: string; q?: string; sort?: string }) {
  const { page, pageSize, status, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    queryKey: ['mfg-delivery-orders-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    queryFn: () => authedFetch<{ deliveryOrders: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; open: number; in_transit: number; delivered: number; cancelled: number } }>(`/delivery-orders-mfg?${usp.toString()}`),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export const useMfgDeliveryOrderDetail = (id: string | null) => useQuery({
  queryKey: ['mfg-delivery-order-detail', id],
  queryFn: () => authedFetch<{ deliveryOrder: any; items: any[] }>(`/delivery-orders-mfg/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: 1, retryDelay: 800,
});

export const useCreateMfgDeliveryOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      authedFetch<{ id: string; doNumber: string }>(
        `/delivery-orders-mfg`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

export const useUpdateMfgDeliveryOrderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedFetch(`/delivery-orders-mfg/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      /* A status advance into a shipped state deducts inventory — refresh
         the inventory queries so the on-hand drilldown reflects the OUT. */
      qc.invalidateQueries({ queryKey: ['inventory'] });
      /* CANCEL releases the delivered qty back to the SO. */
      releaseSoSideQueries(qc);
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    },
  });
};

/* DO header PATCH — editable SO-style fields (debtor / salesperson / address /
   dates / driver / emergency contact / venue). Mirrors
   useUpdateMfgSalesOrderHeader. */
export const useUpdateMfgDeliveryOrderHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/delivery-orders-mfg/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
    },
  });
};

/* DO line-item CRUD — mirrors the SO item hooks. Each mutation recomputes the
   DO totals server-side, so we invalidate both the detail + list. */
export const useAddMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/delivery-orders-mfg/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

export const useUpdateMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/delivery-orders-mfg/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

export const useDeleteMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/delivery-orders-mfg/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

/* DO payments ledger — mirror of the SO payments hooks. The DO Create + Detail
   screens render the same Houzs PaymentsTable; these hooks back the persisted
   (Detail) path. */
export type DoPayment = {
  id: string;
  delivery_order_id: string;
  paid_at: string;
  method: 'merchant' | 'transfer' | 'cash';
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_centi: number;
  account_sheet: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
};

export const useDeliveryOrderPayments = (id: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', id, 'payments'],
  queryFn: () => authedFetch<{ payments: DoPayment[] }>(`/delivery-orders-mfg/${id}/payments`).then((r) => r.payments),
  enabled: Boolean(id),
  staleTime: 2 * 60_000,
  retry: 1,
  retryDelay: 800,
});

/* `idempotencyKey` — optional, destructured OUT of the body. See
   useAddSalesOrderPayment / lib/idempotency.ts for the one-key-per-intent rule. */
export const useAddDeliveryOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey, ...body }: { id: string; idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ payment: DoPayment }>(`/delivery-orders-mfg/${id}/payments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
    },
  });
};

export const useDeleteDeliveryOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paymentId }: { id: string; paymentId: string }) =>
      authedFetch<{ ok: boolean }>(`/delivery-orders-mfg/${id}/payments/${paymentId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
    },
  });
};
