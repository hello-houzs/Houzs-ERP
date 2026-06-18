import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env as HouzsEnv } from "../types";

// The ported 2990's SCM routes import { Env, Variables } from '../env'. Re-export
// Houzs's Env, and define the Hono context vars those routes read.
export type Env = HouzsEnv;

export interface Variables {
  // Houzs's global /api/* auth sets the authenticated user upstream. Most SCM
  // routes (e.g. suppliers) only use c.get('supabase'); `user` is loose so the
  // few that read it can, without coupling to either app's exact user shape.
  user?: unknown;
  // scm-scoped supabase-js client (service-role), attached by middleware/auth.
  supabase: SupabaseClient<any, any, any>;
}
