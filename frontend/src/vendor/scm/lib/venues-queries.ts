// Vendored SLICE of apps/backend/src/lib/venues-queries.ts — the SO list/detail
// + SO Maintenance venue reads/CRUD.
//
// ── HOUZS RE-SOURCING (2026-06-21) ──────────────────────────────────────────
// Venues are maintained CENTRALLY in Houzs's Project Maintenance / PMS, not in
// the SCM. The old `/api/scm/venues` route never existed in the cutover (it
// 404'd), so these hooks now source from the Houzs-native Project Maintenance
// API: GET/POST/PATCH/DELETE /api/projects/venues.
//
// That endpoint lives OUTSIDE the /api/scm mount, so `authedFetch` (which
// prepends /api/scm) cannot reach it. We use the Houzs-native `api` client
// (../../../api/client) which carries the same bearer token but targets the
// Worker root.
//
// Shape adaptation — the projects VenueRow is { id:number, name, state, notes,
// active } and the GET only returns active venues. We map it onto the SCM
// `VenueRow` contract the SO/CO consumers already expect:
//   • id    → String(id)   — the SO pickers match `venue.id === staff.venueId`
//                            with `===`, and staff.venueId is a STRING. Keeping
//                            id a string preserves that comparison.
//   • notes → address      — projects venues have no `address`; `notes` is the
//                            nearest free-text column (read-only display only).
//   • state                — carried through so the SO venue picker can read it.
//   • active → true        — the projects GET only returns active rows.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';

export type VenueRow = {
  id: string;
  name: string;
  address: string | null;
  /** Houzs Project Maintenance tags each venue with a Malaysian state; the SO
   *  venue picker reads it to pre-fill the customer state. */
  state: string | null;
  active: boolean;
  created_at: string;
};

export type NewVenue = {
  name: string;
  address?: string | null;
  active?: boolean;
};

// Raw row as returned by GET /api/projects/venues.
type ProjectVenueRow = {
  id: number;
  name: string;
  state: string | null;
  notes: string | null;
  active: number | boolean;
};

function mapVenue(r: ProjectVenueRow): VenueRow {
  return {
    id: String(r.id),
    name: r.name,
    address: r.notes ?? null,
    state: r.state ?? null,
    active: r.active === 1 || r.active === true,
    created_at: '',
  };
}

export function useVenues(_opts?: { includeInactive?: boolean }) {
  // The projects GET only returns active venues; `includeInactive` is accepted
  // for call-site compatibility but has no effect (central maintenance lives in
  // Project Maintenance, which is the source of truth for inactive venues).
  return useQuery({
    queryKey: ['venues'],
    queryFn: () =>
      api
        .get<{ data: ProjectVenueRow[] }>('/api/projects/venues')
        .then((r) => (r.data ?? []).map(mapVenue)),
    staleTime: 60_000,
  });
}

export function useCreateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewVenue) =>
      // Projects venues carry name + state + notes (no `address`); map the
      // editor's free-text address onto `notes`.
      api.post<{ id: number; name: string; state: string | null }>(
        '/api/projects/venues',
        { name: body.name, notes: body.address ?? null },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });
}

export function useUpdateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, address }: Partial<NewVenue> & { id: string }) =>
      api.patch<{ ok: true }>(`/api/projects/venues/${id}`, {
        ...(name !== undefined ? { name } : {}),
        ...(address !== undefined ? { notes: address } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });
}

export function useDeactivateVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/projects/venues/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });
}
