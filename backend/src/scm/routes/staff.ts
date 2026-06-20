// ----------------------------------------------------------------------------
// staff — SCM staff / salesperson directory (scm.staff).
// Ported READ from 2990's apps/backend/src/lib/admin-queries.ts (useStaff), which
// in 2990's reads the `staff` table DIRECTLY via the supabase client. Houzs has
// no client-side supabase, so the vendored useStaff routes through this GET.
//
// GET /staff — list scm.staff rows (the SO Salesperson dropdown + PaymentsTable
//              Collected-By picker source). Degrades to [] when the table is
//              missing. Response is camelCased to the StaffRow shape the frontend
//              expects (admin-queries.ts).
//
// HOUZS VENDOR: the whole /api/scm tree is owner-gated at the Houzs layer and the
// auth bridge maps every caller to ONE seeded super_admin system staff row
// (middleware/auth.ts), so this list is for picker population only — it is not a
// per-user identity surface.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import type { Env, Variables } from "../env";

export const staff = new Hono<{ Bindings: Env; Variables: Variables }>();

staff.use("*", supabaseAuth);

// GET / — list all staff rows ordered by staff_code (mirrors 2990's useStaff
// .order('staff_code')). Degrades to [] when the relation is missing.
staff.get("/", async (c) => {
  const supabase = c.get("supabase");
  const { data, error } = await supabase
    .from("staff")
    .select("id, staff_code, name, role, showroom_id, venue_id, initials, color, active, email, phone")
    .order("staff_code", { ascending: true });
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return c.json({ staff: [] });
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }
  // Dual-read camelCase ?? snake_case — the PostgREST driver may camelCase result
  // columns; cover both so we never read undefined.
  const staffRows = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    staffCode: r.staffCode ?? r.staff_code ?? "",
    name: r.name,
    role: r.role,
    showroomId: r.showroomId ?? r.showroom_id ?? null,
    venueId: r.venueId ?? r.venue_id ?? null,
    initials: r.initials ?? "",
    color: r.color ?? "#888888",
    active: r.active,
    email: r.email ?? null,
    phone: r.phone ?? null,
  }));
  return c.json({ staff: staffRows });
});

export default staff;
