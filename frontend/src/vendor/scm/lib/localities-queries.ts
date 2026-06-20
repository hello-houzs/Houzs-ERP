// Vendored SLICE of apps/backend/src/lib/localities-queries.ts — only the
// pieces SupplierDetail's edit form reads: useLocalities (drives the Malaysia
// State <select>), distinctStates, COUNTRIES, PAYMENT_TERMS_OPTIONS.
//
// HOUZS VENDOR NOTE (supabase slice): the source useLocalities reads the
// `my_localities` reference table DIRECTLY via the Supabase JS client (paged
// 1000 rows at a time). There is NO `/localities` GET endpoint to route through
// authedFetch (the source localities route only exposes POST/PATCH/DELETE), and
// the vendor layer has no Supabase client. So this slice ships useLocalities as
// a hook that resolves to an EMPTY list — exactly the cold-start behaviour the
// source already handles: SupplierDetail's StateSelect falls back to a free-text
// State input when the Malaysia dataset is unavailable. The write mutations
// (useCreate/Update/DeleteLocality) and the other derivations
// (citiesInState/postcodesInCity/countryForState/BUILDING_TYPES) are NOT pulled
// in — SupplierDetail doesn't call them.
//
// FLAG: if a future page needs the real Malaysia postcode cascade, wire a
// `GET /api/scm/localities` endpoint on the Houzs SCM backend and repoint
// useLocalities at authedFetch.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export interface LocalityRow {
  id?: string;
  postcode: string;
  city: string;
  state: string;
  stateCode: string;
  country: string;
  warehouseId?: string | null;
}

/* HOUZS VENDOR — routes through GET /api/scm/localities (returns scm.my_localities
   camelCased). Same shape + query key as the source. When the table is empty the
   endpoint returns [], so distinctStates/citiesInState below collapse to [] and
   the StateSelect falls back to a free-text State input (the verbatim no-data
   behaviour). Seed real MY data with seed-my-localities.mjs. */
export const useLocalities = () =>
  useQuery({
    queryKey: ['my_localities'],
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async (): Promise<LocalityRow[]> => {
      const res = await authedFetch<{ localities: LocalityRow[] }>('/localities');
      return res.localities ?? [];
    },
  });

/* Derive distinct states — used by SupplierDetail's StateSelect for the
   Malaysia dropdown. With the empty dataset above this returns [], so the
   field renders the free-text fallback the source already ships. */
export const distinctStates = (rows: LocalityRow[]): string[] => {
  const s = new Set<string>();
  for (const r of rows) s.add(r.state);
  return Array.from(s).sort();
};

/* HOUZS VENDOR — SO Detail's DeliveryAddressCard drives a state→city→postcode
   cascade off these. With the empty locality dataset above they return [] /
   null, so the cascade renders empty selects + the country falls back to the
   header snapshot / 'Malaysia' — the verbatim no-data behaviour. Copied from
   apps/backend/src/lib/localities-queries.ts. */
export const citiesInState = (rows: LocalityRow[], state: string): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (r.state === state) s.add(r.city);
  return Array.from(s).sort();
};
export const postcodesInCity = (rows: LocalityRow[], state: string, city: string): string[] => {
  const s = new Set<string>();
  for (const r of rows) if (r.state === state && r.city === city) s.add(r.postcode);
  return Array.from(s).sort();
};
export const countryForState = (rows: LocalityRow[], state: string): string | null => {
  if (!state) return null;
  const hit = rows.find((r) => r.state === state);
  return hit?.country ?? null;
};

/* HOUZS VENDOR — SO Maintenance's Localities CRUD section. authedFetch-based in
   the source (→ /localities). Copied verbatim. */
export const useCreateLocality = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { state: string; stateCode: string; city: string; postcode: string; country?: string }) =>
      authedFetch<{ locality: { id: string } }>('/localities', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my_localities'] }); },
  });
};

export const useUpdateLocality = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: {
      id: string;
      state?: string; stateCode?: string; city?: string; postcode?: string;
      country?: string;
      warehouseId?: string | null;
    }) =>
      authedFetch(`/localities/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my_localities'] }); },
  });
};

export const useDeleteLocality = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch(`/localities/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my_localities'] }); },
  });
};

/* PR #47 — Country dropdown options. Only Malaysia today. */
export const COUNTRIES = ['Malaysia'] as const;
export type CountryName = typeof COUNTRIES[number];

/* PR #47 — Payment term presets. "Custom" lets user enter free text. */
export const PAYMENT_TERMS_OPTIONS = [
  'COD',
  'NET 7',
  'NET 14',
  'NET 30',
  'NET 45',
  'NET 60',
  'NET 90',
  '50/50',
  '30/70',
  'Advance Payment',
  'Custom',
] as const;
export type PaymentTermOption = typeof PAYMENT_TERMS_OPTIONS[number];
