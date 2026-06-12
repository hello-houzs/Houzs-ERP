import { drizzle } from "drizzle-orm/postgres-js";
import type { Env } from "../types";
import { getSql, resolveDatabaseUrl } from "./pg";
import * as schema from "./schema.pg";

/**
 * Drizzle client over Supabase Postgres (postgres.js). Built per request —
 * postgres.js sockets can't cross the Worker request boundary, and Hyperdrive
 * pools the connection, so a fresh client per call is cheap.
 *
 * Coexists with raw SQL during the cutover: `env.DB` is injected with a
 * D1-compatible shim over the SAME Postgres (see middleware/db.ts), so the
 * legacy `env.DB.prepare(...)` paths and Drizzle paths hit one database.
 */
export function getDb(env: Env) {
  return drizzle(getSql(resolveDatabaseUrl(env)), { schema });
}

export type DB = ReturnType<typeof getDb>;
export { schema };
