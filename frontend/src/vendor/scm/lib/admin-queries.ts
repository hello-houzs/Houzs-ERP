// Vendored SLICE of apps/backend/src/lib/admin-queries.ts — only `useStaff`,
// the single export the SO list (Salesperson column) + PaymentsTable
// (Collected By picker + default) read.
//
// HOUZS VENDOR NOTE: 2990's useStaff reads its Supabase `staff` table directly
// (supabase.from('staff')). Houzs has no client-side supabase, so this routes
// through GET /api/scm/staff (backend/src/scm/routes/staff.ts), which lists
// scm.staff rows camelCased to the StaffRow shape below. Seed sample salesperson
// rows with backend/scripts/scm-schema/seed-scm-staff-samples.mjs. Empty table →
// the endpoint returns [], so the SO list Salesperson column shows "—" and
// PaymentsTable's Collected-By select shows only "—" (the verbatim no-data
// fallbacks already in the pages).

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

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
    queryFn: async (): Promise<StaffRow[]> => {
      const res = await authedFetch<{ staff: StaffRow[] }>('/staff');
      return res.staff ?? [];
    },
    staleTime: 10 * 60_000,
  });
