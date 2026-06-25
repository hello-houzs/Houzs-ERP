import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Env as HouzsEnv } from "../types";

// The ported 2990's SCM routes import { Env, Variables } from '../env'. Re-export
// Houzs's Env, and define the Hono context vars those routes read.
export type Env = HouzsEnv;

export interface Variables {
  // The ported routes read user.id / user.email etc. (originally a Supabase
  // auth user). middleware/auth.ts adapts Houzs's session user into this shape.
  user: User;
  // scm-scoped supabase-js client (service-role), attached by middleware/auth.
  supabase: SupabaseClient<any, any, any>;
  // The REAL Houzs session user (integer id), stashed by middleware/auth BEFORE
  // `user` is overwritten with the scm.staff system identity. Lets handlers do
  // per-user lookups into the PUBLIC schema (e.g. the salesperson's active
  // exhibition project) without the (unbuilt) scm.staff identity bridge.
  houzsUser: { id: number; email?: string } | undefined;
}
