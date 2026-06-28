// Vendored from apps/backend/src/lib/lorries-queries.ts — Lorries CRUD hooks.
// TMS fleet master (scm.lorries). is_internal is the In-house / Outsource
// marker; the list hook accepts a fleet filter (all / internal / outsourced).
//
// HOUZS VENDOR NOTE: the source has no `import { supabase } from './supabase'`
// to drop (it only imports authedFetch + react-query). Everything else is
// copied verbatim from 2990.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

// Matches the lorry_type enum in migration 0195 / Houzs scm 0053.
export const LORRY_TYPES = [
  'LORRY_10FT', 'LORRY_14FT', 'LORRY_17FT', 'LORRY_21FT', 'VAN', 'OUTSOURCE', 'OTHER',
] as const;
export type LorryType = (typeof LORRY_TYPES)[number];

export const LORRY_TYPE_LABEL: Record<LorryType, string> = {
  LORRY_10FT: '10ft Lorry',
  LORRY_14FT: '14ft Lorry',
  LORRY_17FT: '17ft Lorry',
  LORRY_21FT: '21ft Lorry',
  VAN: 'Van',
  OUTSOURCE: 'Outsource',
  OTHER: 'Other',
};

export type LorryRow = {
  id: string;
  plate: string;
  type: LorryType;
  // Migration 0195 — true = in-house fleet, false = outsourced. The pg driver
  // camelCases result cols, so consumers dual-read `isInternal ?? is_internal`.
  is_internal?: boolean;
  isInternal?: boolean;
  warehouse_id?: string | null;
  warehouseId?: string | null;
  capacity_m3?: number | string | null;
  capacityM3?: number | string | null;
  capacity_kg?: number | string | null;
  capacityKg?: number | string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
};

export type NewLorry = {
  plate: string;
  type: LorryType;
  isInternal?: boolean;
  warehouseId?: string | null;
  capacityM3?: number | null;
  capacityKg?: number | null;
  notes?: string;
  active?: boolean;
};

export type FleetFilter = 'all' | 'internal' | 'outsourced';

export function useLorries(opts?: { includeInactive?: boolean; fleet?: FleetFilter }) {
  const fleet = opts?.fleet ?? 'all';
  return useQuery({
    queryKey: ['lorries', opts?.includeInactive ?? false, fleet],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.includeInactive) params.set('active', 'false');
      if (fleet !== 'all') params.set('fleet', fleet);
      const qs = params.toString();
      return authedFetch<{ lorries: LorryRow[] }>(
        `/lorries${qs ? `?${qs}` : ''}`,
      ).then((r) => r.lorries);
    },
    staleTime: 60_000,
  });
}

export function useCreateLorry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewLorry) =>
      authedFetch<{ lorry: LorryRow }>(`/lorries`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorries'] }),
  });
}

export function useUpdateLorry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewLorry> & { id: string }) =>
      authedFetch<{ lorry: LorryRow }>(`/lorries/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorries'] }),
  });
}
