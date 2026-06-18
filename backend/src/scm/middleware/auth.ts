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
export const supabaseAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    // Adapt the Houzs session user (set by the global /api/* auth) into the
    // Supabase-User shape the ported routes read (they use user.id / user.email).
    const hu = c.get("user") as unknown as { id?: number | string; email?: string } | undefined;
    c.set("user", {
      id: hu?.id != null ? String(hu.id) : "scm-service",
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
