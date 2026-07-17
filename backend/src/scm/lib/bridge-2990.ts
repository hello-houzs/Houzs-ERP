// ----------------------------------------------------------------------------
// bridge-2990 — direct writer for exactly ONE table in 2990's production
// database: public.maintenance_config_history.
//
// TRANSPORT CHANGE (owner, 2026-07-17). This module used to sign in to 2990 as a
// real bridge user and call 2990's own POST /maintenance-config/changes. The
// owner rejected that setup (it needs a Supabase auth user plus a public.staff
// row created inside 2990), and for THIS endpoint he is right that it is
// avoidable. 2990's handler (apps/api/src/routes/maintenance-config.ts:150-209)
// is an RBAC check followed by a plain INSERT of
// {id, scope, config, effective_from, notes, created_by} — verified line by
// line. There is no cascade, no derived write, no trigger on the table, and no
// NOTIFY. The INSERT is the whole endpoint, so we can perform it ourselves and
// lose nothing but the checks enumerated below.
//
// THIS REASONING IS SPECIFIC TO THIS ONE TABLE AND DOES NOT GENERALISE. The
// SO-amendment write-back (design §3.2, D2) still MUST call 2990's API:
// applySoAmendment is a snapshot + line diff + honest-pricing recompute +
// delivery-fee re-derive + revision bump. Writing that row directly would skip
// all of it and fork the pricing engine. Do not cite this file as precedent for
// it.
//
// WHAT GOING DIRECT GIVES UP — three things, all real, none hypothetical:
//
//  1. 2990's WRITE_ROLES check is GONE, and it was the ONLY gate.
//     maintenance-config.ts:68 restricts writes to admin / super_admin /
//     coordinator / sales_director via 2990's staff table. RLS is NOT enabled on
//     maintenance_config_history (verified against prod, 2026-07-17), so that
//     app-side check was the only thing standing in front of this table. We now
//     bypass it entirely, and nothing on 2990's side replaces it. What gates
//     this write is Houzs-side and Houzs-side only: hasHouzsPerm
//     ('scm.config.write') plus the DB kill switch. Accepted — we ARE the
//     system, and the owner ruled the audit trail lives in Houzs ("houzs erp
//     看得到誰改的就行了"). Written down because removing the only gate is not a
//     thing to do quietly.
//
//  2. 2990's validation of the payload is GONE. In full, it was: parseScope()
//     (scope must be 'master' | 'customer:<id>' | 'supplier:<id>'), an ISO
//     YYYY-MM-DD test on effectiveFrom, and a `config != null` check. That is
//     the entire list — 2990 never validated the config blob's shape at all, so
//     the naive-push hazard this feature exists to prevent was never going to be
//     caught over there either. All three checks are re-done on this side
//     (PUSH_SCOPE is the constant 'master', the route ISO-tests effectiveFrom,
//     and push2990Change re-checks config below). What we actually gave up is a
//     second opinion, not a check that no longer happens.
//
//  3. The service-role key bypasses ALL RLS on 2990's ENTIRE database. This is
//     the real cost, and it is a genuine widening of blast radius: to insert one
//     config row, this Worker now holds unrestricted read/write over the live
//     retail DB — every order, every customer, every price. Supabase has no way
//     to scope a service key down to one table, so the constraint has to be
//     built here instead:
//       · The client is NOT exported. Nothing outside this module can obtain one.
//       · There is no generic query/fetch helper. The only two operations that
//         exist are the two this feature needs, and both hardcode TABLE.
//       · The client is pinned to the public schema, so a typo cannot reach
//         another one.
//     That is a code convention, not a database permission. It holds exactly as
//     long as nobody exports the client. If this file ever needs a third
//     operation, that is the moment to re-ask whether this key belongs in this
//     Worker at all.
//
// created_by is now NULL, where it used to carry the bridge account's staff
// uuid. The column is nullable (2990 schema.ts:2553, FK to staff ON DELETE SET
// NULL), so NULL is legal — and it is more honest than the bridge was: a row
// 2990 did not author now says so, instead of naming a "Houzs Bridge" staff row
// that implies a 2990 actor. The real actor is recorded in Houzs and echoed into
// the row's `notes`.
// ----------------------------------------------------------------------------

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';

/** The ONLY table this module may touch. Both operations below hardcode it;
 *  see (3) in the header for why that constant is load-bearing. */
const TABLE = 'maintenance_config_history';

export interface Bridge2990Config {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export type BridgeConfigResult =
  | { ok: true; config: Bridge2990Config }
  | { ok: false; missing: string[] };

/** Read the bridge secrets. Both are required: a partially-configured bridge
 *  must not half-work. Absent secrets are how this feature ships dark — with
 *  nothing set, the push cannot reach 2990 at all. */
export function readBridgeConfig(env: Env): BridgeConfigResult {
  const raw = {
    BRIDGE_2990_SUPABASE_URL: env.BRIDGE_2990_SUPABASE_URL,
    BRIDGE_2990_SERVICE_ROLE_KEY: env.BRIDGE_2990_SERVICE_ROLE_KEY,
  };
  const missing = Object.entries(raw)
    .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
    .map(([k]) => k);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      supabaseUrl: raw.BRIDGE_2990_SUPABASE_URL!.replace(/\/+$/, ''),
      serviceRoleKey: raw.BRIDGE_2990_SERVICE_ROLE_KEY!,
    },
  };
}

export class Bridge2990Error extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'Bridge2990Error';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** Deliberately not exported — see (3) in the header. A client handed out of
 *  this module is unrestricted access to 2990's entire database. */
function client(cfg: Bridge2990Config): SupabaseClient {
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
}

/**
 * 2990's notion of "today", which is the UTC calendar date: maintenance-config
 * .ts:41 `todayIso()` is `new Date().toISOString().slice(0, 10)` and :78 defaults
 * asOf to it.
 *
 * Deliberately NOT todayMyt(). Houzs treats a UTC-based document date as a bug
 * and fixed it (lib/my-time.ts), but 2990 has not, and this read is not the
 * place to correct 2990's clock. Between 00:00 and 08:00 MYT the two disagree by
 * a day, and resolving with MYT would hand the merge a row 2990's own POS is not
 * serving yet — breaking the one property every safety mechanism here rests on:
 * that the blob we preserve byte-for-byte is the blob actually on the tablets.
 * Read what 2990 reads.
 */
function today2990Iso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface Resolved2990Config {
  data: Record<string, unknown> | null;
  effectiveFrom: string | null;
  hasPendingPriceChange: boolean;
  pendingEffectiveFrom: string | null;
}

/**
 * Read 2990's currently-effective config for a scope. This is the READ half of
 * read-modify-write, and it is the ONLY acceptable source for the base blob: a
 * cached or reconstructed copy would be a guess about live prices.
 *
 * The query reproduces 2990's own resolver (maintenance-config.ts:82-104) —
 * same filter, same `effective_from DESC, created_at DESC` tie-break, same
 * limit, same pending-lookahead — so this resolves the row 2990's /resolved
 * would return. It selects only the two columns the merge needs; the row's
 * created_by is 2990's business, not ours.
 */
export async function fetch2990Resolved(cfg: Bridge2990Config, scope: string): Promise<Resolved2990Config> {
  const sb = client(cfg);
  const asOf = today2990Iso();

  const { data: rows, error } = await sb
    .from(TABLE)
    .select('config, effective_from')
    .eq('scope', scope)
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    throw new Bridge2990Error('bridge_read_failed', "Could not read 2990's maintenance config.", 502, error.message);
  }
  if (!rows || rows.length === 0) {
    return { data: null, effectiveFrom: null, hasPendingPriceChange: false, pendingEffectiveFrom: null };
  }

  const row = rows[0] as { config: unknown; effective_from: string };
  const blob = row.config;
  // The column is jsonb, which also permits an array, a string or a number. The
  // merge assumes an object of pools. Refusing an unexpected shape is the same
  // rule the local reader already applies to Houzs's own row, and the same rule
  // the merge applies per-pool: a shape we do not understand is a refusal, never
  // a coercion.
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    throw new Bridge2990Error(
      'bridge_bad_config_shape',
      "2990's master maintenance config is not a set of option pools, so nothing can be merged into it. This needs a look before anything is sent.",
      502,
      { type: Array.isArray(blob) ? 'array' : typeof blob },
    );
  }

  // Lookahead for a future-dated row, mirroring maintenance-config.ts:98-104.
  // Unlike 2990's own handler, a failure here THROWS rather than being dropped:
  // reporting "no pending change" because the query broke would state a fact we
  // do not have.
  const { data: pending, error: pendingErr } = await sb
    .from(TABLE)
    .select('effective_from')
    .eq('scope', scope)
    .gt('effective_from', asOf)
    .order('effective_from', { ascending: true })
    .limit(1);
  if (pendingErr) {
    throw new Bridge2990Error(
      'bridge_read_failed',
      "Could not check whether 2990 has a pending config change.",
      502,
      pendingErr.message,
    );
  }
  const hasPending = Boolean(pending && pending.length > 0);

  return {
    data: blob as Record<string, unknown>,
    effectiveFrom: row.effective_from,
    hasPendingPriceChange: hasPending,
    pendingEffectiveFrom: hasPending ? (pending![0] as { effective_from: string }).effective_from : null,
  };
}

/** Mint the row id the way 2990 does (maintenance-config.ts:61-64). The column
 *  is TEXT PRIMARY KEY with no default, so the id is the writer's to supply, and
 *  a row whose id does not look like 2990's own would stand out wrongly in its
 *  own history UI. */
function newChangeId(): string {
  const rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `mch-${rnd}`;
}

/**
 * Append a new effective-dated config row to 2990. This is the write 2990's
 * POST /maintenance-config/changes would have performed, performed directly —
 * see the header for exactly what that skips and why it is equivalent.
 *
 * The POS picks the row up unchanged: it subscribes to postgres_changes on this
 * table (apps/pos/src/lib/queries.ts:1474), which is WAL-based and so fires
 * identically whether the INSERT came from 2990's API or from here.
 */
export async function push2990Change(
  cfg: Bridge2990Config,
  input: { scope: string; config: unknown; effectiveFrom: string; notes?: string },
): Promise<{ id: string; effectiveFrom: string }> {
  // 2990's config_required check (maintenance-config.ts:171), re-done here now
  // that we no longer get its second opinion. The column is NOT NULL, so this is
  // a clear refusal instead of a raw constraint violation.
  if (input.config == null) {
    throw new Bridge2990Error('bridge_config_required', 'Refusing to send an empty config to 2990.', 500);
  }

  const sb = client(cfg);
  const id = newChangeId();

  const { data, error } = await sb
    .from(TABLE)
    .insert({
      id,
      scope: input.scope,
      config: input.config,
      effective_from: input.effectiveFrom,
      notes: input.notes === undefined ? null : input.notes,
      // NULL, not a bridge account — see the header. Houzs is not a 2990 staff
      // member and this column will not pretend otherwise.
      created_by: null,
    })
    .select('id, effective_from')
    .single();

  if (error) {
    throw new Bridge2990Error('bridge_write_failed', 'The change was not accepted by 2990.', 502, {
      code: error.code,
      message: error.message,
    });
  }

  const stored = data as { id: string; effective_from: string };
  return { id: stored.id, effectiveFrom: stored.effective_from };
}
