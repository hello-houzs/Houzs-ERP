// Vendored SLICE of apps/backend/src/lib/venues-queries.ts — the SO list/detail
// + SO Maintenance venue reads/CRUD. authedFetch-based already; the unused
// supabase import is dropped (the source never read it here).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type VenueRow = {
  id: string;
  name: string;
  address: string | null;
  active: boolean;
  created_at: string;
};

export type NewVenue = {
  name: string;
  address?: string | null;
  active?: boolean;
};

export function useVenues(opts?: { includeInactive?: boolean }) {
  return useQuery({
    queryKey: ['venues', opts?.includeInactive ?? false],
    queryFn: () => authedFetch<{ venues: VenueRow[] }>(
      `/venues${opts?.includeInactive ? '?active=false' : ''}`,
    ).then((r) => r.venues),
    staleTime: 60_000,
  });
}

export function useCreateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewVenue) =>
      authedFetch<{ venue: VenueRow }>(`/venues`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });
}

export function useUpdateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewVenue> & { id: string }) =>
      authedFetch<{ venue: VenueRow }>(`/venues/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });
}

export function useDeactivateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ venue: VenueRow }>(`/venues/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });
}
