import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../types";
import * as schema from "./schema";

/**
 * Drizzle client bound to the request-scoped D1 binding. Workers spin
 * up a fresh isolate per request, so we build the client per call —
 * no module-level cache. Drizzle itself is stateless; `env.DB` is the
 * actual D1 connection.
 *
 * Coexists with raw SQL (`env.DB.prepare(...)`) — same binding under
 * the hood. New code uses `getDb(env)`; existing routes stay on raw
 * SQL until they're converted in subsequent passes.
 */
export function getDb(env: Env) {
  return drizzle(env.DB, { schema });
}

export type DB = ReturnType<typeof getDb>;
export { schema };
