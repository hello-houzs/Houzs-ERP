import { createMiddleware } from "hono/factory";
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
    c.set("supabase", getSupabaseService(c.env));
    await next();
  },
);
