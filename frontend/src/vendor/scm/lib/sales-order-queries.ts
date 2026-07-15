// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — ONLY the Sales-Order
// read / detail / status / mutation hooks the vendored SO list + detail pages
// use. The full source module (~2000 lines) carries the entire SO/DO/SI/DR
// query surface; the DO/SI/DR hooks are intentionally NOT vendored here.
//
// HOUZS VENDOR NOTES:
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The one multipart photo POST that needed the
//     raw token + URL in the source is repointed through authedFetch's base URL
//     + the localStorage 'auth:token' the vendored layer uses.
//   - The source's verified-save (verifiedSave/readbackGet/friendlySaveMessage)
//     wrapper on the header + override mutations is DROPPED — the vendored layer
//     has no verified-save module. Those mutations fall back to the plain PATCH
//     the source already does when `__verify` is absent. Callers that passed
//     `__verify` still work: the extra key is simply stripped before the body
//     is sent (it never was a column).
//   - serviceNotify (the non-React 409/error toast bridge) maps to the vendored
//     dialog-service serviceNotify.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';

// The vendored authedFetch already handles FormData correctly (it omits the
// JSON content-type for non-string bodies so the multipart boundary survives),
// so the photo upload routes through it like every other call — no bespoke
// fetch with a hand-rolled base URL + token is needed in the Houzs layer.

/* ── SO list / detail reads ──────────────────────────────────────────────── */

export const useMfgSalesOrders = (status?: string) =>
  useQuery({
    queryKey: ['mfg-sales-orders', status ?? 'all'],
    queryFn: () => authedFetch<{ salesOrders: any[] }>(`/mfg-sales-orders${status ? `?status=${status}` : ''}`),
    // Switching the status tab keeps the current list visible while the next
    // status loads, instead of flashing an empty table (keepPreviousData).
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });

// Opt-in server-side pagination + search + sort + status-counts. Sending
// `page` switches the backend into its paginated contract (returns
// { salesOrders, total, page, pageSize, statusCounts }); the legacy
// useMfgSalesOrders above (no page) still returns all 500 for the dead V1 page.
// Status tab values in the UI are lowercase (draft/confirmed/cancelled) but the
// mfg_sales_orders.status column stores UPPERCASE — uppercase here to match.
export function useMfgSalesOrdersPaged(params: { page: number; pageSize: number; status?: string; q?: string; sort?: string }) {
  const { page, pageSize, status, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status && status !== 'all') usp.set('status', status.toUpperCase());
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    queryKey: ['mfg-sales-orders-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    queryFn: () => authedFetch<{ salesOrders: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; confirmed: number; cancelled: number }; aggregates?: { revenueCenti: number; outstandingCenti: number; paidCenti: number } }>(`/mfg-sales-orders?${usp.toString()}`),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

// Dashboard summary mode (`?summary=1`) — the backend returns only the 6 cols
// the lifecycle-bucket KPIs need (doc_no, status, proceeded_at, local_total_centi,
// created_at, so_date), non-DRAFT, company + sales-scope scoped, so the dashboard
// isn't paying for 500 fully-hydrated rows. Bucketing stays in the FE (single
// source of truth). Ported from 2990's useMfgSalesOrdersSummary.
export type SoSummaryRow = {
  doc_no: string;
  status: string;
  proceeded_at: string | null;
  local_total_centi: number;
  created_at: string | null;
  so_date: string | null;
};
export const useMfgSalesOrdersSummary = () =>
  useQuery({
    queryKey: ['mfg-sales-orders', 'summary'],
    queryFn: () => authedFetch<{ salesOrders: SoSummaryRow[] }>(`/mfg-sales-orders?summary=1`),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });

// Customer directory — server-side GROUP BY over Sales Orders (by phone/name),
// company + sales-scope scoped. Backend: GET /mfg-sales-orders/customers. Money
// is centi (divide by 100 in the UI). Ported from 2990's Customers page (which
// aggregated client-side); Houzs aggregates server-side so it scales past 500.
export type ScmCustomerOrder = {
  doc_no: string;
  status: string;
  so_date: string | null;
  created_at: string | null;
  local_total_centi: number;
  line_count: number;
};
export type ScmCustomer = {
  key: string;
  name: string;
  phone: string | null;
  order_count: number;
  lifetime_value_centi: number;
  last_order_at: string;
  orders: ScmCustomerOrder[];
};
export const useMfgCustomers = () =>
  useQuery({
    queryKey: ['mfg-sales-orders', 'customers'],
    queryFn: () => authedFetch<{ customers: ScmCustomer[] }>(`/mfg-sales-orders/customers`),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
    retry: 1,
    retryDelay: 800,
  });

export const useMfgSalesOrderDetail = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-order-detail', docNo],
  queryFn: () => authedFetch<{ salesOrder: any; items: any[] }>(`/mfg-sales-orders/${docNo}`),
  enabled: Boolean(docNo), staleTime: 30_000, retry: 1, retryDelay: 800,
});

export type DebtorSuggestion = {
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
};

export const useDebtorSearch = (q: string) => useQuery({
  queryKey: ['mfg-sales-orders', 'debtors', q],
  queryFn: () => authedFetch<{ debtors: DebtorSuggestion[] }>(
    `/mfg-sales-orders/debtors/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  ),
  enabled: q.trim().length >= 2,
  staleTime: 5 * 60_000,
  retry: 1,
});

export type SoAuditFieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
};
export type SoAuditEntry = {
  id: string;
  so_doc_no: string;
  action: string;
  actor_id: string | null;
  actor_name_snapshot: string | null;
  field_changes: SoAuditFieldChange[];
  status_snapshot: string | null;
  source: string | null;
  note: string | null;
  created_at: string;
};

export const useSalesOrderAuditLog = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-order-audit-log', docNo],
  queryFn: () => authedFetch<{ entries: SoAuditEntry[] }>(`/mfg-sales-orders/${docNo}/audit-log`).then((r) => r.entries),
  enabled: Boolean(docNo),
  staleTime: 5 * 60_000,
  retry: 1,
});

export type SoPayment = {
  id: string;
  so_doc_no: string;
  paid_at: string;
  method: 'merchant' | 'transfer' | 'cash' | 'installment';
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_centi: number;
  account_sheet: string | null;
  slip_key?: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
};

export const useSalesOrderPayments = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-orders', docNo, 'payments'],
  queryFn: () => authedFetch<{ payments: SoPayment[] }>(`/mfg-sales-orders/${docNo}/payments`).then((r) => r.payments),
  enabled: Boolean(docNo),
  staleTime: 2 * 60_000,
  retry: 1,
  retryDelay: 800,
});

/* ── SO mutations ────────────────────────────────────────────────────────── */

export const useCreateMfgSalesOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => authedFetch<{ docNo: string }>(`/mfg-sales-orders`, { method: 'POST', body: JSON.stringify(body) }),
    // Invalidate BOTH the legacy list key AND the paged key the live V2 list
    // (useMfgSalesOrdersPaged, ['mfg-sales-orders-paged', …]) reads — the
    // latter is NOT a prefix of ['mfg-sales-orders'], so without it a freshly
    // created SO didn't appear until staleTime/refocus.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders-paged'] });
    },
  });
};

export const useUpdateMfgSalesOrderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, status }: { docNo: string; status: string }) =>
      authedFetch<{ salesOrder: unknown }>(`/mfg-sales-orders/${docNo}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onMutate: async ({ docNo, status }) => {
      const detailKey = ['mfg-sales-order-detail', docNo];
      await qc.cancelQueries({ queryKey: ['mfg-sales-orders'] });
      await qc.cancelQueries({ queryKey: detailKey });
      const prevDetail = qc.getQueryData(detailKey);
      const prevLists = qc.getQueriesData<{ salesOrders?: Array<Record<string, unknown>> }>({ queryKey: ['mfg-sales-orders'] });
      qc.setQueryData(detailKey, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const o = old as { salesOrder?: Record<string, unknown> };
        if (!o.salesOrder) return old;
        return { ...o, salesOrder: { ...o.salesOrder, status } };
      });
      for (const [key, data] of prevLists) {
        if (!data?.salesOrders) continue;
        qc.setQueryData(key, {
          ...data,
          salesOrders: data.salesOrders.map((r) => (r.doc_no === docNo ? { ...r, status } : r)),
        });
      }
      return { detailKey, prevDetail, prevLists };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData(ctx.detailKey, ctx.prevDetail);
      for (const [key, data] of ctx.prevLists) qc.setQueryData(key, data);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-status-changes', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useUpdateMfgSalesOrderHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    // HOUZS VENDOR: verified-save dropped — strip the client-only `__verify`
    // map and fall through to the plain PATCH the source already used when no
    // verification was requested.
    mutationFn: async ({ docNo, __verify: _v, ...body }: { docNo: string; __verify?: Record<string, unknown> } & Record<string, unknown>) => {
      void _v;
      return authedFetch<{ ok: boolean }>(`/mfg-sales-orders/${docNo}`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useAddMfgSalesOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, ...item }: { docNo: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/mfg-sales-orders/${docNo}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useUpdateMfgSalesOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, ...item }: { docNo: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/mfg-sales-orders/${docNo}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useDeleteMfgSalesOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId }: { docNo: string; itemId: string }) =>
      authedFetch<void>(`/mfg-sales-orders/${docNo}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useOverrideMfgSoLinePrice = () => {
  const qc = useQueryClient();
  return useMutation({
    // HOUZS VENDOR: verified-save dropped — plain POST to the override route.
    mutationFn: async ({ docNo, itemId, overridePriceSen, reason }: {
      docNo: string; itemId: string; overridePriceSen: number; reason?: string;
    }) => {
      await authedFetch<{ items: Array<{ id: string; unit_price_centi: number }> }>(
        `/mfg-sales-orders/${docNo}/items/${itemId}/override`,
        { method: 'POST', body: JSON.stringify({ overridePriceSen, reason }) },
      );
      return { ok: true as const, itemId, newPrice: overridePriceSen };
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-price-overrides', vars.docNo] });
    },
  });
};

export const useUpdateSoItemStockStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, status }: { docNo: string; itemId: string; status: 'PENDING' | 'READY' }) =>
      authedFetch<{ ok: boolean; advancedTo?: string | null; unchanged?: boolean }>(
        `/mfg-sales-orders/${docNo}/items/${itemId}/stock-status`,
        { method: 'PATCH', body: JSON.stringify({ status }) },
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Stock status update failed', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    },
  });
};

export type UploadSoItemPhotoResult = {
  photoKey: string;
  photoUrl: string;
  expiresAt?: string;
};

export const useUploadSoItemPhoto = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, itemId, file }: {
      docNo: string; itemId: string; file: File;
    }): Promise<UploadSoItemPhotoResult> => {
      const fd = new FormData();
      fd.append('file', file);
      return authedFetch<UploadSoItemPhotoResult>(
        `/mfg-sales-orders/${docNo}/items/${itemId}/photos`,
        { method: 'POST', body: fd },
      );
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useDeleteSoItemPhoto = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, photoKey }: {
      docNo: string; itemId: string; photoKey: string;
    }) =>
      authedFetch<{ ok: boolean }>(
        `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useAddSalesOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, ...body }: { docNo: string } & Record<string, unknown>) =>
      authedFetch<{ payment: SoPayment }>(`/mfg-sales-orders/${docNo}/payments`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo, 'payments'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo] });
    },
  });
};

/* Owner 2026-07-13 — SAME-DAY payment edit. PATCH /:docNo/payments/:id with the
   editable fields (amount / method + sub-fields / date / account sheet /
   approval code / collected-by). The backend 409s when the payment wasn't
   created on the current MYT calendar day. */
export const useEditSalesOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, id, ...body }: { docNo: string; id: string } & Record<string, unknown>) =>
      authedFetch<{ payment: SoPayment }>(`/mfg-sales-orders/${docNo}/payments/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo, 'payments'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo] });
    },
  });
};

export const useDeleteSalesOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, id }: { docNo: string; id: string }) =>
      authedFetch<{ ok: boolean }>(`/mfg-sales-orders/${docNo}/payments/${id}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo, 'payments'] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo] });
    },
  });
};

/* ── Photo signed-URL helper (plain async fn, not a hook) ─────────────────── */

export type SignedPhotoUrlResponse = { signedUrl: string; expiresAt: string };

export async function fetchSoItemPhotoSignedUrl(
  docNo: string,
  itemId: string,
  photoKey: string,
): Promise<SignedPhotoUrlResponse> {
  return authedFetch<SignedPhotoUrlResponse>(
    `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}/signed`,
  );
}
