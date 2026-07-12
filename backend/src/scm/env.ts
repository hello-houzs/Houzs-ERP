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
  // `permissions` / `permissions_set` are mirrored from the AuthUser so SCM
  // route handlers can gate on flat-key permissions (e.g. scm.config.write)
  // against the REAL caller — never against scm.staff.role which the bridge
  // hardcodes to one super_admin row.
  houzsUser: {
    id: number;
    email?: string;
    /** Real display name from public.users — used for audit-trail actor
     *  snapshots (mfg_so_audit_log.actor_name_snapshot). */
    name?: string | null;
    permissions?: string[];
    permissions_set?: Set<string>;
  } | undefined;
  // Multi-company context (Phase 0b) — resolved by middleware/companyContext.ts
  // and consumed by scm/lib/companyScope.ts. companyId is the ACTIVE company for
  // this request; allowedCompanyIds is what the caller may see (Phase 0b = all).
  // Optional: undefined pre-migration / on DB cold-start, so the scoping helpers
  // no-op and single-company Houzs keeps working.
  companyId?: number;
  companyCode?: string;
  allowedCompanyIds?: number[];
  companies?: Array<{ id: number; code: string; name: string }>;
}
