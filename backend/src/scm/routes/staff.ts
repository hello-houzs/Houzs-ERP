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
import { requireHouzsPerm } from "../lib/houzs-perms";
import type { Env, Variables } from "../env";

export const staff = new Hono<{ Bindings: Env; Variables: Variables }>();

staff.use("*", supabaseAuth);

// GET / — list all staff rows ordered by staff_code (mirrors 2990's useStaff
// .order('staff_code')). Degrades to [] when the relation is missing.
staff.get("/", async (c) => {
  const supabase = c.get("supabase");
  const { data, error } = await supabase
    .from("staff")
    .select("id, staff_code, name, role, showroom_id, venue_id, showroom_warehouse_id, user_id, initials, color, active, email, phone")
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
    /* SHOWROOM PARKING (migration 0148) — the warehouse this person is parked
       under. Distinct from the legacy `showroomId`, which points at the vendored
       2990 scm.showrooms table (empty in Houzs). userId is exposed so the
       Members page, which is keyed by Houzs user id, can join to this row
       without a second lookup. */
    showroomWarehouseId: r.showroomWarehouseId ?? r.showroom_warehouse_id ?? null,
    userId: r.userId ?? r.user_id ?? null,
    initials: r.initials ?? "",
    color: r.color ?? "#888888",
    active: r.active,
    email: r.email ?? null,
    phone: r.phone ?? null,
  }));
  return c.json({ staff: staffRows });
});

/* ── SHOWROOM PARKING (owner 2026-07-19, migration 0148) ────────────────────
   The PRIMARY venue binding. A salesperson is parked under a Showroom ONCE, by
   HR/admin, on the Members page — and from then on every order they raise
   attributes to that showroom's venue with no further data entry, no per-event
   work, and no dependence on anyone maintaining a project team. That is the
   whole reason it outranks the PMS binding in practice: an exhibition
   assignment still WINS when one exists (see lib/venue-binding.ts), but the
   system has to produce a correct venue when none ever does.

   A "Showroom" is a scm.warehouses row with is_showroom = true. It is NOT the
   vendored 2990 scm.showrooms table, which is empty in Houzs and POS-specific;
   one showroom vocabulary, anchored to the warehouse that physically exists. */

// GET /staff/showrooms — the parking picker's options: every warehouse flagged
// as a Showroom. venueName is surfaced (not hidden behind the id) so whoever
// parks a person can SEE which venue they are about to attribute that person's
// orders to, and can tell a showroom with no venue set yet from one that is
// ready — a flagged showroom with a blank venue resolves to nothing.
staff.get("/showrooms", async (c) => {
  const supabase = c.get("supabase");
  const { data, error } = await supabase
    .from("warehouses")
    .select("id, code, name, venue_name, is_active")
    .eq("is_showroom", true)
    .order("name", { ascending: true });
  if (error) {
    if (/relation .* does not exist|column .* does not exist/i.test(error.message)) {
      return c.json({ showrooms: [] });
    }
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }
  const showrooms = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    code: r.code ?? "",
    name: r.name ?? "",
    venueName: (r.venueName ?? r.venue_name ?? null) as string | null,
    active: (r.isActive ?? r.is_active ?? true) as boolean,
  }));
  return c.json({ showrooms });
});

// PATCH /staff/by-user/:userId/showroom — park (or unpark) one person.
//
// Keyed by HOUZS USER ID, not scm.staff.id: the Members page is a list of Houzs
// users, and migration 0066 syncs every non-disabled user into scm.staff with
// user_id as the deterministic link. Making the caller resolve the staff uuid
// first would put the SCM's internal identity into a Workspace page's contract.
//
// Gated on `users.manage` — parking someone under a showroom decides which venue
// their sales attribute to, and therefore which fair's P&L and whose commission
// they land in. That is the same class of authority as editing the person's
// record, so it uses the same key rather than inventing a new one.
staff.patch("/by-user/:userId/showroom", requireHouzsPerm("users.manage"), async (c) => {
  const supabase = c.get("supabase");
  const userId = Number(c.req.param("userId"));
  if (!Number.isFinite(userId)) return c.json({ error: "invalid_user_id" }, 400);

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: "invalid_json" }, 400); }

  /* null / "" / absent all mean UNPARK. An explicit unpark is a real decision
     ("this person is not attached to a showroom"), and it resolves to an empty
     venue rather than to some fallback — so it must be expressible. */
  const raw = body.showroomWarehouseId;
  const showroomWarehouseId =
    typeof raw === "string" && raw.trim() ? raw.trim() : null;

  /* Verify the target is actually a flagged Showroom BEFORE parking anyone
     under it. Without this check a plain stock warehouse could be parked
     against, and it would resolve to nothing forever with no visible reason —
     the person's orders would just silently carry no venue. Fail loudly here
     instead, where someone is looking at the screen. */
  if (showroomWarehouseId) {
    const { data: wh, error: whErr } = await supabase
      .from("warehouses")
      .select("id, is_showroom")
      .eq("id", showroomWarehouseId)
      .maybeSingle();
    if (whErr) return c.json({ error: "load_failed", reason: whErr.message }, 500);
    const row = wh as Record<string, unknown> | null;
    const isShowroom = (row?.isShowroom ?? row?.is_showroom) as boolean | undefined;
    if (!row || isShowroom !== true) {
      return c.json({
        error: "not_a_showroom",
        message:
          "That location is not marked as a Showroom. Mark it as a Showroom in Warehouses first, then park the salesperson under it.",
      }, 409);
    }
  }

  const { data, error } = await supabase
    .from("staff")
    .update({ showroom_warehouse_id: showroomWarehouseId })
    .eq("user_id", userId)
    .select("id, user_id, showroom_warehouse_id");
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);

  /* No staff row = this user was never synced into scm.staff (disabled, or
     created before migration 0066 ran). Say so plainly rather than reporting a
     success that stored nothing — a parking that silently did not happen is the
     exact failure this feature cannot afford. */
  if (!data || (data as unknown[]).length === 0) {
    return c.json({
      error: "staff_unlinked",
      message:
        "This member has no sales profile yet, so they cannot be parked under a showroom. Ask IT to link their account.",
    }, 409);
  }
  return c.json({ ok: true, showroomWarehouseId });
});

export default staff;
