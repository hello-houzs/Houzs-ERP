import { createMiddleware } from "hono/factory";
import type { User } from "@supabase/supabase-js";
import type { Env, Variables } from "../env";
import { getSupabaseService } from "../../db/supabase";

// Auth bridge for the ported 2990's SCM routes.
//
// 2990's original `supabaseAuth` validated a Supabase Auth JWT and built a
// per-user RLS client. In Houzs the request is ALREADY authenticated by the
// global /api/* middleware (Houzs session auth, mounted in index.ts), so this
// just attaches the scm-scoped service-role supabase-js client the route
// handlers expect via `c.get('supabase')`. Same export name, so the ported
// route's `import { supabaseAuth } from '../middleware/auth'` is unchanged.
// The ported 2990's routes stamp `created_by` (uuid, FK -> scm.staff) and look up
// the caller's `staff.role` by `user.id` (also a scm.staff uuid). Houzs users are
// INTEGERS, so passing the raw Houzs id makes Postgres reject "1" as a uuid
// ("invalid input syntax for type uuid"). Since /api/scm/* is owner-gated
// (requirePermission("*")) at the Houzs layer, every caller here is an admin —
// so we map them all to ONE seeded super_admin system staff row. This gives a
// valid uuid identity that satisfies the FK + role lookups. Seed it with
// backend/scripts/scm-schema/seed-scm-staff.mjs. (Per-user attribution would need
// a Houzs-user -> scm.staff sync — a later enhancement.)
const SCM_SYSTEM_STAFF_ID = "00000000-0000-4000-8000-000000000001";

export const supabaseAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    // Adapt the Houzs session user (set by the global /api/* auth) into the
    // Supabase-User shape the ported routes read. user.id is the scm.staff uuid
    // (system staff); email stays the real Houzs user's for display.
    const hu = c.get("user") as unknown as { id?: number | string; email?: string } | undefined;
    c.set("user", {
      id: SCM_SYSTEM_STAFF_ID,
      email: hu?.email ?? "",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "",
    } as unknown as User);
    c.set("supabase", getSupabaseService(c.env));
    await next();
  },
);
