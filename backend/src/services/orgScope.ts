// ─────────────────────────────────────────────────────────────────────────
// orgScope.ts — full-chain reporting-line visibility (owner spec, 2026-07).
//
// "A reports to B, B reports to C → C sees B's AND A's records": the caller
// plus their ENTIRE subtree in the public.users.manager_id tree, any depth.
// This deliberately goes DEEPER than the existing one-hop projectAcl rule
// (getProjectScope = [self, manager]) — the owner's spec for SO / Service
// Case scoping is the full downline chain. projectAcl is left untouched;
// aligning it is a separate decision.
//
// Implementation: iterative breadth-first expansion over users.manager_id
// (works identically on the D1 shim and Postgres — no WITH RECURSIVE
// portability concerns), with a visited-set cycle guard and a hard depth
// cap so a manager_id loop in the data can never hang a request.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";

/** Hard ceiling on reporting-chain depth. Real org charts are < 10 deep;
 *  the cap only exists to bound a pathological manager_id cycle. */
const MAX_CHAIN_DEPTH = 10;

/**
 * The caller's own id plus every user under them in the manager_id tree
 * (direct reports, their reports, … any depth up to MAX_CHAIN_DEPTH).
 * Includes disabled/archived users so their historical records stay
 * visible to their (former) manager.
 */
export async function subtreeUserIds(
  env: Env,
  rootUserId: number,
  maxDepth: number = MAX_CHAIN_DEPTH,
): Promise<number[]> {
  const seen = new Set<number>([Number(rootUserId)]);
  let frontier: number[] = [Number(rootUserId)];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const placeholders = frontier.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id FROM users WHERE manager_id IN (${placeholders})`,
    )
      .bind(...frontier)
      .all<{ id: number }>();
    const next: number[] = [];
    for (const r of rows.results ?? []) {
      const id = Number(r.id);
      if (!Number.isFinite(id)) continue;
      if (!seen.has(id)) {
        seen.add(id); // visited-set doubles as the cycle guard
        next.push(id);
      }
    }
    frontier = next;
  }
  return [...seen];
}

/**
 * The lowercased, trimmed display NAMES of the caller's reporting subtree
 * (self + full manager_id downline). Used to reach LEGACY service cases that
 * carry only a free-text `sales_agent` NAME (mirrored from AutoCount) and no
 * created_by / assigned_to id linkage: matching that text against these names
 * lets the salesperson — and, per the pyramid rule, everyone above them — see
 * their own old cases without any data backfill. Empty names are dropped;
 * result is de-duplicated. Reuses subtreeUserIds so the id-scope and the
 * name-scope can never resolve to different people.
 */
export async function subtreeAgentNames(
  env: Env,
  rootUserId: number,
  maxDepth: number = MAX_CHAIN_DEPTH,
): Promise<string[]> {
  const ids = await subtreeUserIds(env, rootUserId, maxDepth);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT name FROM users WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ name: string | null }>();
  const names = new Set<string>();
  for (const r of rows.results ?? []) {
    const n = (r.name ?? "").trim().toLowerCase();
    if (n) names.add(n);
  }
  return [...names];
}

/**
 * Restrict `project_sales_reports` rows to the ones a non-director sales user
 * may see: their OWN sale-amount entries plus their downline's (owner spec
 * 2026-07). Rep identity on a sales-report row is `uploaded_by` — the users.id
 * of the rep who logged the sale (see createSalesReport) — which maps directly
 * onto the users.manager_id subtree that subtreeUserIds() returns, so no extra
 * join is needed.
 *
 * `canSeeAll` short-circuits for directors / service-case managers (`*`,
 * Super Admin / Sales Director / Finance Manager, or service_cases.manage) —
 * they keep the full list unchanged. For everyone else, rows whose rep can't
 * be resolved (null uploaded_by) are dropped: fail closed on financial data.
 * Reuses subtreeUserIds — the same downline resolver SO / Service Cases use.
 */
export async function scopeSalesReportsForUser<
  T extends { uploaded_by?: number | null },
>(
  env: Env,
  userId: number | null | undefined,
  rows: T[],
  canSeeAll: boolean,
): Promise<T[]> {
  if (canSeeAll) return rows;
  if (userId == null) return []; // fail closed, never open
  const visible = new Set(await subtreeUserIds(env, Number(userId)));
  return rows.filter(
    (r) => r.uploaded_by != null && visible.has(Number(r.uploaded_by)),
  );
}
