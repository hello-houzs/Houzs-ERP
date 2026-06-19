// Vendored SLICE of apps/backend/src/lib/warehouse-queries.ts — only the Rack
// type + useRacks() the GRN pages read (the optional per-line destination Rack
// picker on New GRN, and the GRN detail's rack-label resolution). The full
// source module (rack CRUD, movements, summary KPIs, stock-in/out) is not
// pulled in — the GRN pages never call it.
//
// HOUZS VENDOR NOTE: the source `import { supabase } from './supabase'` was
// imported but NEVER referenced (all reads go through authedFetch); DROPPED here
// exactly as in the vendored inventory-queries slice. useRacks is copied
// verbatim, routed through the vendored authedFetch (→ /api/scm/warehouse).

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type RackStatus = 'OCCUPIED' | 'EMPTY' | 'RESERVED';

export type RackItem = {
  id: string;
  rack_id: string;
  product_code: string;
  product_name: string | null;
  size_label: string | null;
  customer_name: string | null;
  source_doc_no: string | null;
  qty: number;
  stocked_in_date: string;
  notes: string | null;
};

export type Rack = {
  id: string;
  warehouse_id: string;
  rack: string;
  position: string | null;
  status: RackStatus;
  reserved: boolean;
  notes: string | null;
  items: RackItem[];
  created_at: string;
  updated_at: string;
};

export type RackSummary = {
  total: number;
  occupied: number;
  empty: number;
  reserved: number;
  occupancyRate: number;
};

export type WarehouseOption = { id: string; code: string; name: string };

/* ── Rack grid + KPI summary ──────────────────────────────────────────── */
export function useRacks(opts?: { warehouseId?: string }) {
  return useQuery({
    queryKey: ['warehouse', 'racks', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      return authedFetch<{ racks: Rack[]; warehouses: WarehouseOption[]; summary: RackSummary }>(
        `/warehouse${params.toString() ? `?${params.toString()}` : ''}`,
      );
    },
    staleTime: 30_000,
    retry: 1,
  });
}
