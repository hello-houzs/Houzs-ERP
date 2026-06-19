// Vendored SLICE of apps/backend/src/lib/queries.ts — only useFabricLibrary,
// the sole export the ProductModelDetail page reads (for the SOFA fabric-picker
// checklist that drives allowed_options.fabrics).
//
// ⚠️ HOUZS VENDOR STUB (flagged) — the source hook read the `fabric_library`
// table DIRECTLY via the supabase client (a POS-side colour-library read). The
// /api/scm mount has NO GET endpoint for the fabric library (only
// /fabric-library/:id/tier PATCH exists), and no backend changes are in scope
// for this wave, so this hook resolves to an EMPTY list. Effect on the page:
// the SOFA "fabrics offered" checklist renders with no options; everything else
// on ProductModelDetail works. Wire a GET /api/scm/fabric-library on the Worker
// to make this live (mirror the supabase shape: id/label/tier/default_surcharge/
// active/sort_order).

import { useQuery } from '@tanstack/react-query';

export interface FabricLibrary {
  id: string;
  label: string;
  tier: string;
  defaultSurcharge: number;
  active: boolean;
  sortOrder: number;
}

const LIBRARY_OPTS = { staleTime: Infinity, gcTime: Infinity };

// All fabrics (incl. inactive) so admin can re-enable.
export const useFabricLibrary = () =>
  useQuery({
    queryKey: ['library', 'fabrics'],
    queryFn: async (): Promise<FabricLibrary[]> => {
      // No /api/scm/fabric-library GET — see file header. Resolve empty.
      return [];
    },
    ...LIBRARY_OPTS,
  });
