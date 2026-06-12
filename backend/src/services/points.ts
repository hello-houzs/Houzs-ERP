import { eq, sql, and, gte, lt, desc } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  users,
  point_transactions,
  user_streak_weeks,
  leaderboard_cache,
  gamify_settings,
  departments,
} from "../db/schema";

/**
 * Houzs Points service.
 *
 * Single source of truth for balance changes. Every mutation goes
 * through this module so the ledger stays append-only and the cached
 * balance columns on `users` never drift from `point_transactions`.
 *
 * Conventions:
 *   • `pool = 'earned'`   — accumulating, sender-only-from-self spend
 *   • `pool = 'gifting'`  — monthly allowance, only spendable as a gift
 *   • Balance writes are positive (earn / receive) or negative (spend
 *     / send / redeem). The ledger row's `delta` carries the sign.
 *   • No raw `UPDATE users SET ..._balance` outside this file.
 */

export type Pool = "earned" | "gifting";

export type Reason =
  | "gift_sent"
  | "gift_received"
  | "monthly_reset"
  | "innovation_shipped"
  | "suggestion_approved"
  | "upvote_received"
  | "redeem"
  | "redeem_refund"
  | "admin_adjust";

export interface LedgerInput {
  user_id: number;
  pool: Pool;
  delta: number;
  reason: Reason | string;
  ref_type?: string | null;
  ref_id?: number | null;
  counterparty_user_id?: number | null;
  note?: string | null;
}

// ── Settings helpers ────────────────────────────────────────────
// Single small table; cache nothing — D1 reads are cheap and
// settings change rarely. Callers that need many keys at once just
// read once via `getSettings`.

export async function getSettings(env: Env): Promise<Record<string, string>> {
  const db = getDb(env);
  const rows = await db.select().from(gamify_settings);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function getSettingNumber(
  env: Env,
  key: string,
  fallback: number,
): Promise<number> {
  const db = getDb(env);
  const row = await db
    .select({ value: gamify_settings.value })
    .from(gamify_settings)
    .where(eq(gamify_settings.key, key))
    .then((r) => r[0]);
  if (!row) return fallback;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Ledger primitive ────────────────────────────────────────────
/**
 * Write one ledger row + adjust the cached balance on `users` in a
 * single D1 batch (atomic per Workers semantics).
 */
async function writeLedger(env: Env, e: LedgerInput): Promise<void> {
  const balanceCol = e.pool === "earned" ? "points_balance" : "gifting_balance";
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO point_transactions
         (user_id, pool, delta, reason, ref_type, ref_id, counterparty_user_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      e.user_id,
      e.pool,
      e.delta,
      e.reason,
      e.ref_type ?? null,
      e.ref_id ?? null,
      e.counterparty_user_id ?? null,
      e.note ?? null,
    ),
    env.DB.prepare(
      `UPDATE users SET ${balanceCol} = ${balanceCol} + ? WHERE id = ?`,
    ).bind(e.delta, e.user_id),
  ];
  await env.DB.batch(stmts);
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Award earned points to a user. Idempotency is the caller's
 * responsibility — pass `ref_type` + `ref_id` so future audits can
 * spot duplicates.
 */
export async function award(
  env: Env,
  user_id: number,
  reason: Reason | string,
  amount: number,
  opts: {
    ref_type?: string;
    ref_id?: number;
    note?: string;
    counterparty_user_id?: number;
  } = {},
): Promise<void> {
  if (amount <= 0) return;
  await writeLedger(env, {
    user_id,
    pool: "earned",
    delta: amount,
    reason,
    ref_type: opts.ref_type,
    ref_id: opts.ref_id,
    counterparty_user_id: opts.counterparty_user_id ?? null,
    note: opts.note,
  });
}

/**
 * Peer-to-peer gift. Decrements sender's gifting balance, increments
 * recipient's earned balance. Two ledger rows, one batch.
 */
export async function transfer(
  env: Env,
  from_user_id: number,
  to_user_id: number,
  amount: number,
  note?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (from_user_id === to_user_id) {
    return { ok: false, error: "Cannot send points to yourself" };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive integer" };
  }

  const min = await getSettingNumber(env, "points.gift_min", 5);
  const max = await getSettingNumber(env, "points.gift_max", 100);
  if (amount < min) return { ok: false, error: `Minimum gift is ${min} points` };
  if (amount > max) return { ok: false, error: `Maximum gift is ${max} points` };

  // Confirm sender has enough gifting balance + recipient exists.
  const db = getDb(env);
  const sender = await db
    .select({
      id: users.id,
      gifting: users.gifting_balance,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, from_user_id))
    .then((r) => r[0]);
  if (!sender) return { ok: false, error: "Sender not found" };
  if ((sender.gifting ?? 0) < amount) {
    return { ok: false, error: "Not enough gifting points left this month" };
  }

  const recipient = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, to_user_id))
    .then((r) => r[0]);
  if (!recipient) return { ok: false, error: "Recipient not found" };
  if (recipient.status !== "active") {
    return { ok: false, error: "Recipient is inactive" };
  }

  // Two ledger rows + two balance updates in one batch.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO point_transactions
         (user_id, pool, delta, reason, ref_type, counterparty_user_id, note)
       VALUES (?, 'gifting', ?, 'gift_sent', 'gift', ?, ?)`,
    ).bind(from_user_id, -amount, to_user_id, note ?? null),
    env.DB.prepare(
      `UPDATE users SET gifting_balance = gifting_balance - ? WHERE id = ?`,
    ).bind(amount, from_user_id),
    env.DB.prepare(
      `INSERT INTO point_transactions
         (user_id, pool, delta, reason, ref_type, counterparty_user_id, note)
       VALUES (?, 'earned', ?, 'gift_received', 'gift', ?, ?)`,
    ).bind(to_user_id, amount, from_user_id, note ?? null),
    env.DB.prepare(
      `UPDATE users SET points_balance = points_balance + ? WHERE id = ?`,
    ).bind(amount, to_user_id),
  ]);

  return { ok: true };
}

/**
 * Spend earned points (e.g. award shop redeem). Returns the new
 * balance on success. Caller is responsible for downstream effects
 * (creating the redemption row, decrementing stock, etc.).
 */
export async function spend(
  env: Env,
  user_id: number,
  amount: number,
  reason: Reason | string,
  opts: { ref_type?: string; ref_id?: number; note?: string } = {},
): Promise<{ ok: true; new_balance: number } | { ok: false; error: string }> {
  if (amount <= 0) return { ok: false, error: "Amount must be positive" };

  const db = getDb(env);
  const u = await db
    .select({ id: users.id, balance: users.points_balance })
    .from(users)
    .where(eq(users.id, user_id))
    .then((r) => r[0]);
  if (!u) return { ok: false, error: "User not found" };
  if ((u.balance ?? 0) < amount) {
    return { ok: false, error: "Not enough points" };
  }

  await writeLedger(env, {
    user_id,
    pool: "earned",
    delta: -amount,
    reason,
    ref_type: opts.ref_type,
    ref_id: opts.ref_id,
    note: opts.note,
  });

  return { ok: true, new_balance: (u.balance ?? 0) - amount };
}

/**
 * Admin override — direct ledger entry, signed delta. Used for HR
 * corrections. Always writes to the 'earned' pool. The acting admin's
 * id is stamped onto `counterparty_user_id` so the activity feed can
 * surface "Adjusted by <admin name>" without a new column / table.
 */
export async function adminAdjust(
  env: Env,
  user_id: number,
  delta: number,
  reason: string,
  note: string | undefined,
  acted_by: number,
): Promise<void> {
  await writeLedger(env, {
    user_id,
    pool: "earned",
    delta,
    reason: "admin_adjust",
    counterparty_user_id: acted_by,
    note: note ? `${reason}: ${note}` : reason,
  });
}

// ── Monthly gifting reset ───────────────────────────────────────
/**
 * Reset every active user's gifting_balance to the configured monthly
 * amount. Idempotent within a calendar month — keys on
 * `users.gifting_reset_at = YYYY-MM-01`. Re-runs in the same month
 * skip users who already match.
 */
export async function resetMonthlyGifting(
  env: Env,
): Promise<{ users_reset: number; amount: number; period: string }> {
  const amount = await getSettingNumber(env, "monthly_gifting_amount", 100);
  // Period stamp is the first day of the current month, ISO-8601.
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1,
  ).padStart(2, "0")}-01`;

  const db = getDb(env);
  const targets = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.status, "active"),
        sql`(${users.gifting_reset_at} IS NULL OR ${users.gifting_reset_at} <> ${period})`,
      ),
    );

  if (targets.length === 0) {
    return { users_reset: 0, amount, period };
  }

  // One ledger row per user (audit) + one balance set + one
  // gifting_reset_at stamp — all in a single batch per chunk.
  const stmts: D1PreparedStatement[] = [];
  for (const t of targets) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO point_transactions
           (user_id, pool, delta, reason, note)
         VALUES (?, 'gifting', ?, 'monthly_reset', ?)`,
      ).bind(t.id, amount, period),
    );
    stmts.push(
      env.DB.prepare(
        `UPDATE users SET gifting_balance = ?, gifting_reset_at = ? WHERE id = ?`,
      ).bind(amount, period, t.id),
    );
  }
  // D1 caps batches around ~100 statements; chunk defensively.
  const CHUNK = 80;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await env.DB.batch(stmts.slice(i, i + CHUNK));
  }

  return { users_reset: targets.length, amount, period };
}

// ── Streak rollover ─────────────────────────────────────────────

/**
 * ISO 8601 week label for a given date — `YYYY-WW`. Matches what
 * sqlite's `strftime('%Y-%W', ...)` produces (Sunday-anchored is what
 * we use throughout the app).
 */
export function isoWeek(d: Date): string {
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const week = Math.floor((d.getTime() - start) / (7 * 24 * 60 * 60 * 1000));
  return `${y}-${String(week).padStart(2, "0")}`;
}

/**
 * Recompute the current ISO week's qualifying counts for every user
 * with activity, then update users.current_streak with the longest
 * tail of consecutive qualifying weeks ending at the current week.
 *
 * Counts: ledger rows in the 'earned' pool with reason in
 * ('upvote_received', 'gift_received') from the start of the current
 * ISO week. Threshold from gamify_settings.
 */
export async function recomputeWeeklyStreaks(
  env: Env,
): Promise<{ users_touched: number; current_week: string }> {
  const threshold = await getSettingNumber(env, "streak_weekly_threshold", 5);
  const now = new Date();
  const week = isoWeek(now);

  // Count this week's qualifying events per user via the ledger.
  // Sunday-of-current-week (00:00 UTC) for the date floor.
  const day = now.getUTCDay(); // 0..6, Sun..Sat
  const weekStart = new Date(now);
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(now.getUTCDate() - day);
  const startIso = weekStart.toISOString();

  // Aggregate: how many DISTINCT counterparties (givers) per user this
  // week? Counting raw rows let one persistent voter farm a user's streak
  // by upvoting many of their posts. Distinct counterparties means
  // "qualified by N different people gifted/upvoted me", which is the
  // metric an engagement streak should actually represent.
  // SQLite's COUNT(DISTINCT) drops NULLs, so legacy rows with no
  // counterparty_user_id (pre-dedup-fix) silently fall out — acceptable;
  // those weeks are already in the past.
  const rows = await env.DB.prepare(
    `SELECT user_id, COUNT(DISTINCT counterparty_user_id) AS upvotes
       FROM point_transactions
      WHERE created_at >= ?
        AND reason IN ('upvote_received','gift_received')
      GROUP BY user_id`,
  )
    .bind(startIso)
    .all<{ user_id: number; upvotes: number }>();

  const touched = rows.results ?? [];

  // Upsert this week's row per user.
  for (const r of touched) {
    const qualified = (r.upvotes ?? 0) >= threshold ? 1 : 0;
    await env.DB.prepare(
      `INSERT INTO user_streak_weeks (user_id, iso_week, upvotes_count, qualified, computed_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, iso_week) DO UPDATE SET
           upvotes_count = excluded.upvotes_count,
           qualified     = excluded.qualified,
           computed_at   = excluded.computed_at`,
    )
      .bind(r.user_id, week, r.upvotes, qualified)
      .run();
  }

  // For each user with any streak history, walk backward from the
  // current week and count consecutive qualified weeks.
  const candidates = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM user_streak_weeks`,
  ).all<{ user_id: number }>();

  for (const c of candidates.results ?? []) {
    const weeks = await env.DB.prepare(
      `SELECT iso_week, qualified
         FROM user_streak_weeks
        WHERE user_id = ?
        ORDER BY iso_week DESC
        LIMIT 200`,
    )
      .bind(c.user_id)
      .all<{ iso_week: string; qualified: number }>();
    let run = 0;
    for (const w of weeks.results ?? []) {
      if (w.qualified === 1) run++;
      else break;
    }
    await env.DB.prepare(`UPDATE users SET current_streak = ? WHERE id = ?`)
      .bind(run, c.user_id)
      .run();
  }

  return { users_touched: touched.length, current_week: week };
}

// ── Leaderboard ─────────────────────────────────────────────────

export interface LeaderboardRow {
  user_id: number;
  name: string;
  email: string;
  department_id: number | null;
  department_name: string | null;
  profile_pic_r2_key: string | null;
  points: number;
  current_streak: number;
  rank: number;
}

export type Period = "week" | "month" | "all";
export type Scope = "company" | { department_id: number };

function periodFloorISO(period: Period): string | null {
  if (period === "all") return null;
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  if (period === "week") {
    d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // Sunday
  } else {
    d.setUTCDate(1);
  }
  return d.toISOString();
}

/**
 * Compute a leaderboard fresh (no cache read). Ranks by sum of
 * positive 'earned' deltas in the period — gifts received, awards,
 * upvotes received. Ties broken by earlier first-earn within the
 * period. Returns top 100.
 */
export async function computeLeaderboard(
  env: Env,
  scope: Scope,
  period: Period,
): Promise<LeaderboardRow[]> {
  const floor = periodFloorISO(period);
  const scopeFilter =
    scope === "company"
      ? ""
      : ` AND u.department_id = ${Number(scope.department_id)} `;
  const periodFilter = floor ? ` AND pt.created_at >= '${floor}' ` : "";

  const rows = await env.DB.prepare(
    `SELECT u.id          AS user_id,
            COALESCE(u.name, u.email) AS name,
            u.email,
            u.department_id,
            d.name        AS department_name,
            u.profile_pic_r2_key,
            u.current_streak,
            COALESCE(SUM(CASE WHEN pt.delta > 0 THEN pt.delta ELSE 0 END), 0) AS points
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN point_transactions pt
              ON pt.user_id = u.id
             AND pt.pool = 'earned'
             ${periodFilter}
      WHERE u.status = 'active'
        ${scopeFilter}
      GROUP BY u.id
      ORDER BY points DESC, u.id ASC
      LIMIT 100`,
  ).all<Omit<LeaderboardRow, "rank">>();

  return (rows.results ?? []).map((r, i) => ({ ...r, rank: i + 1 }));
}

function scopeKey(scope: Scope): string {
  return scope === "company" ? "company" : `department:${scope.department_id}`;
}

/**
 * Read a cached leaderboard if fresh (< maxAgeMs old). Otherwise
 * compute, store, and return.
 */
export async function getLeaderboardCached(
  env: Env,
  scope: Scope,
  period: Period,
  maxAgeMs = 15 * 60 * 1000,
): Promise<LeaderboardRow[]> {
  const key = scopeKey(scope);
  const db = getDb(env);
  const cached = await db
    .select()
    .from(leaderboard_cache)
    .where(
      and(
        eq(leaderboard_cache.scope, key),
        eq(leaderboard_cache.period, period),
      ),
    )
    .then((r) => r[0]);
  if (cached) {
    const age = Date.now() - new Date(cached.computed_at).getTime();
    if (age >= 0 && age < maxAgeMs) {
      try {
        return JSON.parse(cached.rows_json) as LeaderboardRow[];
      } catch {
        /* fall through to recompute */
      }
    }
  }

  const rows = await computeLeaderboard(env, scope, period);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO leaderboard_cache (scope, period, computed_at, rows_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, period) DO UPDATE SET
         computed_at = excluded.computed_at,
         rows_json   = excluded.rows_json`,
  )
    .bind(key, period, now, JSON.stringify(rows))
    .run();
  return rows;
}

/**
 * Refresh every cached leaderboard scope/period — called by the
 * daily cron after streak rollover.
 */
export async function refreshAllLeaderboards(env: Env): Promise<number> {
  const db = getDb(env);
  const depts = await db.select({ id: departments.id }).from(departments);
  const periods: Period[] = ["week", "month", "all"];
  let n = 0;
  for (const p of periods) {
    await getLeaderboardCached(env, "company", p, 0);
    n++;
    for (const d of depts) {
      await getLeaderboardCached(env, { department_id: d.id }, p, 0);
      n++;
    }
  }
  return n;
}

// ── Recent transactions for a user ──────────────────────────────
export async function recentTransactions(
  env: Env,
  user_id: number,
  limit = 50,
): Promise<any[]> {
  const db = getDb(env);
  const rows = await db
    .select()
    .from(point_transactions)
    .where(eq(point_transactions.user_id, user_id))
    .orderBy(desc(point_transactions.created_at))
    .limit(Math.min(limit, 200));
  return rows;
}
