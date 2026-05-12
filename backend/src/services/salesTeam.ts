import type { Env } from "../types";

// ── Code generator ────────────────────────────────────────────
// Format: SR-NNN. Sequence picks up after the highest existing code
// across all-time (no per-year reset since rep population is small).

export async function nextSalesRepCode(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT code FROM sales_reps
       WHERE code LIKE 'SR-%'
       ORDER BY code DESC LIMIT 1`,
  ).first<{ code: string }>();
  let next = 1;
  if (row?.code) {
    const tail = row.code.slice(3);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `SR-${String(next).padStart(3, "0")}`;
}

// ── Cycle check ──────────────────────────────────────────────
// Walk upward from the proposed upline; if we ever land on the rep
// itself, the assignment would create a loop. Used by POST + PATCH
// to refuse a bad upline.

export async function wouldCreateUplineCycle(
  env: Env,
  repId: number,
  proposedUplineId: number,
): Promise<boolean> {
  if (repId === proposedUplineId) return true;
  let cursor: number | null = proposedUplineId;
  const visited = new Set<number>();
  while (cursor != null) {
    if (cursor === repId) return true;
    if (visited.has(cursor)) return true; // pre-existing cycle in data, defensive
    visited.add(cursor);
    const row: { upline_id: number | null } | null = await env.DB.prepare(
      `SELECT upline_id FROM sales_reps WHERE id = ?`,
    )
      .bind(cursor)
      .first<{ upline_id: number | null }>();
    cursor = row?.upline_id ?? null;
  }
  return false;
}

// ── Subtree resolution ───────────────────────────────────────
// Returns the set of rep ids in a rep's downline (inclusive). Used
// by the admin-of-subtree permission check on PATCH endpoints.

export async function subtreeRepIds(env: Env, rootRepId: number): Promise<Set<number>> {
  const result = new Set<number>([rootRepId]);
  let frontier: number[] = [rootRepId];
  while (frontier.length) {
    const placeholders = frontier.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id FROM sales_reps WHERE upline_id IN (${placeholders}) AND archived_at IS NULL`,
    )
      .bind(...frontier)
      .all<{ id: number }>();
    const next: number[] = [];
    for (const r of rows.results ?? []) {
      if (!result.has(r.id)) {
        result.add(r.id);
        next.push(r.id);
      }
    }
    frontier = next;
  }
  return result;
}

// ── Audit log helper ─────────────────────────────────────────

export async function logSalesTeamActivity(
  env: Env,
  repId: number,
  action: string,
  fromValue: string | null,
  toValue: string | null,
  note: string | null,
  userId?: number | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sales_team_activity (rep_id, action, from_value, to_value, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(repId, action, fromValue, toValue, note, userId ?? null)
    .run();
}
