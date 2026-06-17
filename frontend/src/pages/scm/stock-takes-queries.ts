// ----------------------------------------------------------------------------
// Stock Takes query hooks + types — ported from 2990s apps/backend/src/lib/
// stock-takes-queries.ts. The wire SHAPES (StockTakeRow / StockTakeLine /
// StockTakeDetail / filters / create + line-update inputs) are identical to
// 2990s (rule #7). Only the SEAMS change (same playbook as stock-transfers-
// queries.ts):
//   - Data layer: 2990s authedFetch + Supabase JS -> Houzs `api` client +
//     @tanstack/react-query.
//   - Endpoint base: 2990s `/stock-takes/*` -> Houzs `/api/stock-takes/*`.
//   - created_by is a Houzs users.id (number).
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

// PR-DRAFT-removal — DRAFT renamed to OPEN (migration 0078). Stock takes keep an
// editable working state (commander enters counted_qty per line BEFORE posting).
export type StockTakeStatus = "OPEN" | "POSTED" | "CANCELLED";
export type StockTakeScopeType = "ALL" | "CATEGORY" | "CODE_PREFIX";

export type StockTakeWarehouse = {
  id: string;
  code: string;
  name: string;
};

export type StockTakeRow = {
  id: string;
  take_no: string;
  status: StockTakeStatus;
  warehouse_id: string;
  scope_type: StockTakeScopeType;
  scope_value: string | null;
  take_date: string;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: number | null;
  line_count?: number;
  variance_total?: number;
  warehouse?: StockTakeWarehouse | null;
};

export type StockTakeLine = {
  id: string;
  stock_take_id: string;
  product_code: string;
  product_name: string | null;
  system_qty: number;
  counted_qty: number | null;
  variance: number | null;
  notes: string | null;
  created_at: string;
};

export type StockTakeDetail = {
  take: StockTakeRow;
  lines: StockTakeLine[];
};

export type StockTakeListFilters = {
  status?: StockTakeStatus;
  warehouseId?: string;
  dateFrom?: string;
  dateTo?: string;
};

export function useStockTakes(opts?: StockTakeListFilters) {
  return useQuery({
    queryKey: ["stock-takes", opts ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.warehouseId) params.set("warehouseId", opts.warehouseId);
      if (opts?.dateFrom) params.set("dateFrom", opts.dateFrom);
      if (opts?.dateTo) params.set("dateTo", opts.dateTo);
      const r = await api.get<{ takes: StockTakeRow[] }>(
        `/api/stock-takes${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.takes;
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export function useStockTakeDetail(id: string | null) {
  return useQuery({
    queryKey: ["stock-takes", id],
    queryFn: () => api.get<StockTakeDetail>(`/api/stock-takes/${encodeURIComponent(id ?? "")}`),
    enabled: Boolean(id),
    staleTime: 15_000,
    retry: 1,
  });
}

export type CreateStockTakeInput = {
  warehouseId: string;
  takeDate?: string;
  scopeType: StockTakeScopeType;
  scopeValue?: string | null;
  notes?: string;
};

export function useCreateStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateStockTakeInput) =>
      api.post<{ id: string; takeNo: string; lineCount: number }>(`/api/stock-takes`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock-takes"] });
    },
  });
}

export type StockTakeLineUpdate = {
  id: string;
  countedQty?: number | null;
  notes?: string | null;
};

export function useUpdateStockTakeLines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lines }: { id: string; lines: StockTakeLineUpdate[] }) =>
      api.patch<{ ok: true; updated: number }>(`/api/stock-takes/${id}/lines`, { lines }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["stock-takes"] });
      qc.invalidateQueries({ queryKey: ["stock-takes", vars.id] });
    },
  });
}

export function usePostStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch<{ take: StockTakeRow; movementsWritten: number; movementErrors?: string[] }>(
        `/api/stock-takes/${id}/post`,
        {},
      ),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["stock-takes"] });
      qc.invalidateQueries({ queryKey: ["stock-takes", id] });
      // Posting writes ADJUSTMENT movements — invalidate inventory views.
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

// Undo a POSTED take: reverses every ADJUSTMENT it wrote (stock returns to
// pre-post) and marks the take CANCELLED + locked.
export function useReverseStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch<{ take: StockTakeRow; movementsReversed: number; movementErrors?: string[] }>(
        `/api/stock-takes/${id}/reverse`,
        {},
      ),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["stock-takes"] });
      qc.invalidateQueries({ queryKey: ["stock-takes", id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCancelStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ take: StockTakeRow }>(`/api/stock-takes/${id}/cancel`, {}),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["stock-takes"] });
      qc.invalidateQueries({ queryKey: ["stock-takes", id] });
    },
  });
}

export function useDeleteStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/stock-takes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stock-takes"] }),
  });
}
