// ----------------------------------------------------------------------------
// PIN brute-force rate limiter.
//
// /pos/pin-login is UNAUTHENTICATED, takes a public staffId (enumerable via GET
// /pos/sales-staff) and a 6-digit PIN, and on success mints a full session. So
// the lockout is a real security control, not a nicety.
//
// The limiter MUST be globally consistent: a Cloudflare Worker runs as many
// short-lived V8 isolates spread across edge POPs, so a per-isolate in-memory
// Map does NOT bound global attempts (an attacker just rides isolate churn /
// fans across POPs to get a fresh bucket). The production limiter is therefore
// backed by a single Postgres table (pos_pin_attempts) via atomic SECURITY
// DEFINER functions — see migration 0119. The in-memory limiter is kept ONLY as
// the unit-test double (swapped in via __resetRateLimiter in pos.ts).
// ----------------------------------------------------------------------------

const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;

/** Minimal shape of the Supabase client the DB limiter needs (rpc only).
 *  Supabase's .rpc() returns a thenable query builder rather than a real
 *  Promise, so the return is typed PromiseLike — `await` is all we need. */
export interface RateLimitClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export type CheckResult =
  | { allowed: true; remainingAttempts: number }
  | { allowed: false; retryAfter: number };

export interface PinRateLimiter {
  check(client: RateLimitClient, staffId: string): Promise<CheckResult>;
  recordFailure(client: RateLimitClient, staffId: string): Promise<void>;
  reset(client: RateLimitClient, staffId: string): Promise<void>;
}

// ── In-memory (TEST DOUBLE ONLY — not durable across isolates) ──────────────
export const createPinRateLimiter = (): PinRateLimiter => {
  const states = new Map<string, { count: number; resetAt: number }>();
  const purge = (now: number, id: string) => {
    const s = states.get(id);
    if (s && s.resetAt <= now) states.delete(id);
  };
  return {
    async check(_client, staffId) {
      const now = Date.now();
      purge(now, staffId);
      const s = states.get(staffId);
      if (!s) return { allowed: true, remainingAttempts: MAX_FAILURES };
      if (s.count >= MAX_FAILURES) return { allowed: false, retryAfter: Math.ceil((s.resetAt - now) / 1000) };
      return { allowed: true, remainingAttempts: MAX_FAILURES - s.count };
    },
    async recordFailure(_client, staffId) {
      const now = Date.now();
      purge(now, staffId);
      const s = states.get(staffId) ?? { count: 0, resetAt: now + WINDOW_MS };
      s.count += 1; // Window starts at first failure; later failures don't extend it.
      states.set(staffId, s);
    },
    async reset(_client, staffId) {
      states.delete(staffId);
    },
  };
};

// ── Durable, globally-consistent (Postgres) — PRODUCTION ────────────────────
export const createDbPinRateLimiter = (): PinRateLimiter => ({
  async check(client, staffId) {
    const { data, error } = await client.rpc('pin_attempt_check', {
      p_staff_id: staffId, p_max: MAX_FAILURES,
    });
    if (error) {
      // Fail OPEN (parity with the empty-state in-memory limiter): a transient
      // DB blip must not lock out every salesperson. Failures still accrue via
      // recordFailure, so the durable counter resumes enforcing immediately.
      console.warn('[pin-rate-limit] check rpc failed, allowing:', error);
      return { allowed: true, remainingAttempts: MAX_FAILURES };
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { allowed: boolean; retry_after: number; remaining: number }
      | undefined;
    if (row && row.allowed === false) return { allowed: false, retryAfter: Number(row.retry_after) || 60 };
    return { allowed: true, remainingAttempts: row ? Number(row.remaining) : MAX_FAILURES };
  },
  async recordFailure(client, staffId) {
    const { error } = await client.rpc('pin_attempt_fail', {
      p_staff_id: staffId, p_window_seconds: WINDOW_MS / 1000,
    });
    if (error) console.warn('[pin-rate-limit] fail rpc error:', error);
  },
  async reset(client, staffId) {
    const { error } = await client.rpc('pin_attempt_reset', { p_staff_id: staffId });
    if (error) console.warn('[pin-rate-limit] reset rpc error:', error);
  },
});

// Production singleton — durable Postgres-backed. Tests swap to the in-memory
// limiter via __resetRateLimiter() (pos.ts).
export const pinRateLimiter = createDbPinRateLimiter();
