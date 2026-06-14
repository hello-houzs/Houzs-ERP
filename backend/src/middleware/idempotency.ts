import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

// Methods whose side effects are worth de-duplicating.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// A claim INSERT that collides on the (key, scope) primary key means another
// in-flight request already owns this key (PG and SQLite phrasings).
function isUniqueViolation(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e ?? "");
  return /duplicate key value violates unique constraint|UNIQUE constraint failed/i.test(m);
}

const inFlight = (c: { json: (b: unknown, s: 409) => Response }) =>
  c.json({ error: "A request with this Idempotency-Key is still being processed" }, 409);

/**
 * Opt-in request idempotency.
 *
 * Activates ONLY when the client sends an `Idempotency-Key` header on a
 * mutating request; otherwise it is a pure pass-through, so mounting it
 * changes nothing for existing clients (none send the header today).
 *
 * The motivating case: after a 503 from a cold Hyperdrive pool, a user
 * re-submits an order. With a stable key per submit, the first request's
 * 2xx response is stored and the retry replays it verbatim instead of
 * creating a duplicate order/DO/PO.
 *
 * Fail-open by design: ANY bookkeeping error (table absent before the
 * migration runs, transient DB hiccup) falls through to the handler. The
 * worst case is "no dedup" — exactly today's behaviour — never a blocked
 * write. Must be mounted AFTER auth so `userId` is populated.
 */
export const idempotency: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const key = c.req.header("Idempotency-Key");
  if (!key || !MUTATING.has(c.req.method)) return next();

  const scope = `${c.req.method} ${new URL(c.req.url).pathname}`;
  const userId = c.get("userId") ?? null;
  const db = c.env.DB;

  let claimed = false;
  try {
    const existing = await db
      .prepare(
        `SELECT status_code, response_body FROM idempotency_keys WHERE key = ? AND scope = ?`,
      )
      .bind(key, scope)
      .first<{ status_code: number | null; response_body: string | null }>();

    if (existing) {
      // status_code NULL → the original request is still running.
      if (existing.status_code == null) return inFlight(c);
      // Completed → replay the stored response verbatim.
      return new Response(existing.response_body ?? "", {
        status: existing.status_code,
        headers: { "Content-Type": "application/json", "Idempotent-Replay": "true" },
      });
    }

    // Claim the key with an in-flight placeholder (status_code stays NULL).
    await db
      .prepare(`INSERT INTO idempotency_keys (key, scope, user_id) VALUES (?, ?, ?)`)
      .bind(key, scope, userId)
      .run();
    claimed = true;
  } catch (e) {
    if (isUniqueViolation(e)) return inFlight(c);
    console.warn(
      `[idempotency] bookkeeping skipped (fail-open): ${String((e as Error)?.message ?? e).slice(0, 120)}`,
    );
    return next();
  }

  await next();

  // Persist a 2xx response for future replay; release the claim on any other
  // outcome so a genuinely-failed request can be retried under the same key.
  try {
    const res = c.res;
    if (res && res.status >= 200 && res.status < 300) {
      const body = await res.clone().text();
      await db
        .prepare(
          `UPDATE idempotency_keys SET status_code = ?, response_body = ? WHERE key = ? AND scope = ?`,
        )
        .bind(res.status, body, key, scope)
        .run();
    } else if (claimed) {
      await db
        .prepare(`DELETE FROM idempotency_keys WHERE key = ? AND scope = ?`)
        .bind(key, scope)
        .run();
    }
  } catch (e) {
    console.warn(
      `[idempotency] response capture skipped: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
    );
  }
};
