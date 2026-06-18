import { createClient } from "@supabase/supabase-js";
import type { Env } from "../types";

/**
 * supabase-js / PostgREST client for the SCM modules ported from 2990's.
 *
 * The rest of Houzs talks to Postgres via Drizzle over Hyperdrive. The ported
 * 2990's SCM routes talk to the SAME Supabase database via its REST API
 * (PostgREST) using supabase-js — one database, two access paths. This mirrors
 * how 2990's itself runs (server-side, service-role key, RLS bypassed).
 *
 * Config (set on the Worker; never commit the keys):
 *   SUPABASE_URL               = https://<project-ref>.supabase.co
 *   wrangler secret put SUPABASE_SERVICE_ROLE_KEY
 *   wrangler secret put SUPABASE_ANON_KEY
 */

function requireConfig(env: Env): { url: string; serviceKey: string } {
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase REST not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY " +
        "(SUPABASE_URL var + `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`).",
    );
  }
  return { url, serviceKey };
}

/**
 * Service-role client (full access, RLS bypassed) for the server-side SCM route
 * handlers. Built per request — a Worker request boundary can't share a client.
 */
/** Service-role client scoped to the `scm` schema (see below). */
export function getSupabaseService(env: Env) {
  const { url, serviceKey } = requireConfig(env);
  return createClient(url, serviceKey, {
    // The ported 2990's SCM tables live in a dedicated `scm` Postgres schema
    // (kept apart from Houzs's own public.* tables, which carry different
    // AutoCount-named tables — warehouses / purchase_orders / etc.). Pointing
    // the default schema here means the ported route code's `sb.from('x')`
    // calls resolve to `scm.x` unchanged.
    db: { schema: "scm" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** True when the Supabase REST keys are present (used to gate the SCM routes). */
export function isSupabaseConfigured(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}
