import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { getSql, resolveDatabaseUrl } from "../db/pg";
import { d1Compat } from "../db/d1-compat";

/**
 * D1 -> Supabase cutover glue. Replaces `env.DB` with a D1-compatible shim
 * over Postgres so the ~685 existing `env.DB.prepare(...).bind(...).all()`
 * call sites run against Supabase with no per-call changes. The shim also
 * rewrites the SQLite-isms (datetime('now'), char()) in query text.
 *
 * Mounted FIRST (before auth + routes) so every handler — including the
 * unauthenticated /api/auth, /api/survey, /api/track routes — gets Postgres.
 */
export const dbInject = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  // No HYPERDRIVE binding and no DATABASE_URL → leave the bound D1 in place.
  // This keeps the rollback path alive (drop [[hyperdrive]], D1 still bound →
  // app keeps serving instead of 500ing on getSql("")), and lets vitest run
  // against its isolated migrated D1 instead of a live Postgres.
  const url = resolveDatabaseUrl(c.env);
  if (!url) return next();
  const sqlClient = getSql(url);
  c.env.DB = d1Compat(sqlClient) as unknown as D1Database;
  try {
    await next();
  } finally {
    // Close the per-request socket gracefully after the response — left open,
    // workerd severs it and logs "Network connection lost" against the request.
    c.executionCtx.waitUntil(sqlClient.end({ timeout: 5 }).catch(() => {}));
  }
});

/**
 * Same swap for the cron path, which calls services with the raw Worker `env`
 * (no Hono context). Wrap once at the top of `scheduled`, pass the result down.
 */
export function withPgDb(env: Env): Env {
  const url = resolveDatabaseUrl(env);
  if (!url) return env; // same fallback as dbInject: cron stays on bound D1
  return { ...env, DB: d1Compat(getSql(url)) as unknown as D1Database };
}
