// Vendored SLICE of apps/backend/src/lib/admin-queries.ts — only `useStaff`,
// the single export the SO list (Salesperson column) + PaymentsTable
// (Collected By picker + default) read.
//
// HOUZS VENDOR NOTE: 2990's useStaff reads its Supabase `staff` table directly
// (supabase.from('staff')). Houzs has no equivalent table behind /api/scm and
// the vendored layer carries no supabase client, so this slice returns an EMPTY
// staff list. Consequences (both graceful, verbatim fallbacks already in the
// pages): the SO list Salesperson column shows "—", and PaymentsTable's
// Collected-By select shows only "—" (no default collector). When a Houzs
// /api/scm/staff (or equivalent) endpoint is mounted, swap the queryFn to an
// authedFetch read returning the same StaffRow[] shape.

import { useQuery } from '@tanstack/react-query';

export type StaffRoleValue = 'sales' | 'showroom_lead' | 'coordinator' | 'finance' | 'admin';

export interface StaffRow {
  id: string;
  staffCode: string;
  name: string;
  role: StaffRoleValue;
  showroomId: string | null;
  venueId: string | null;
  initials: string;
  color: string;
  active: boolean;
  email: string | null;
  phone: string | null;
}

export const useStaff = () =>
  useQuery({
    queryKey: ['staff'],
    queryFn: async (): Promise<StaffRow[]> => [],
    staleTime: 10 * 60_000,
  });
