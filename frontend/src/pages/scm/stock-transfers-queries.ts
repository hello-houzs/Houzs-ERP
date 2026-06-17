// ----------------------------------------------------------------------------
// Stock Transfers query hooks + types — ported from 2990s apps/backend/src/lib/
// stock-transfers-queries.ts. The wire SHAPES (StockTransferRow /
// StockTransferLine / StockTransferDetail / filters / create input) are identical
// to 2990s (rule #7). Only the SEAMS change (same playbook as the Inventory/PO/GRN
// slices):
//   - Data layer: 2990s authedFetch + Supabase JS -> Houzs `api` client
//     (frontend/src/api/client.ts) + @tanstack/react-query.
//   - Endpoint base: 2990s `/stock-transfers/*` -> Houzs `/api/stock-transfers/*`.
//   - created_by is a Houzs users.id (number) string-rendered in the UI; the type
//     stays `string | null` for wire-shape fidelity (the backend returns the int).
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

// PR-DRAFT-removal — DRAFT dropped (migration 0078). Transfers post on create.
export type StockTransferStatus = "POSTED" | "CANCELLED";

export type StockTransferWarehouse = {
  id: string;
  code: string;
  name: string;
};

export type StockTransferRow = {
  id: string;
  transfer_no: string;
  status: StockTransferStatus;
  from_warehouse_id: string;
  to_warehouse_id: string;
  transfer_date: string;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: number | null;
  line_count?: number;
  from_warehouse?: StockTransferWarehouse | null;
  to_warehouse?: StockTransferWarehouse | null;
};

export type StockTransferLine = {
  id: string;
  stock_transfer_id: string;
  product_code: string;
  product_name: string | null;
  variant_key?: string;
  qty: number;
  notes: string | null;
  created_at: string;
};

export type StockTransferDetail = {
  transfer: StockTransferRow;
  lines: StockTransferLine[];
};

export type StockTransferListFilters = {
  status?: StockTransferStatus;
  fromWarehouseId?: string;
  toWarehouseId?: string;
  dateFrom?: string;
  dateTo?: string;
};

export function useStockTransfers(opts?: StockTransferListFilters) {
  return useQuery({
    queryKey: ["stock-transfers", opts ?? {}],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.fromWarehouseId) params.set("fromWarehouseId", opts.fromWarehouseId);
      if (opts?.toWarehouseId) params.set("toWarehouseId", opts.toWarehouseId);
      if (opts?.dateFrom) params.set("dateFrom", opts.dateFrom);
      if (opts?.dateTo) params.set("dateTo", opts.dateTo);
      const r = await api.get<{ transfers: StockTransferRow[] }>(
        `/api/stock-transfers${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return r.transfers;
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export function useStockTransferDetail(id: string | null) {
  return useQuery({
    queryKey: ["stock-transfers", id],
    queryFn: () => api.get<StockTransferDetail>(`/api/stock-transfers/${encodeURIComponent(id ?? "")}`),
    enabled: Boolean(id),
    staleTime: 15_000,
    retry: 1,
  });
}

export type StockTransferItemInput = {
  productCode: string;
  productName?: string;
  qty: number;
  notes?: string;
};

export type CreateStockTransferInput = {
  fromWarehouseId: string;
  toWarehouseId: string;
  transferDate?: string;
  notes?: string;
  items: StockTransferItemInput[];
};

export function useCreateStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateStockTransferInput) =>
      api.post<{ id: string; transferNo: string; movementErrors?: string[] }>(`/api/stock-transfers`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock-transfers"] });
      // Posting moves stock — invalidate inventory views too.
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCancelStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch<{ transfer: StockTransferRow }>(`/api/stock-transfers/${id}/cancel`, {}),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["stock-transfers"] });
      qc.invalidateQueries({ queryKey: ["stock-transfers", id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
