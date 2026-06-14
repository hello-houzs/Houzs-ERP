import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

// One structured access-log line per request + a request id echoed back in the
// `X-Request-Id` header. Turns `wrangler tail` into a greppable log and lets a
// user quote the id when reporting an issue. Complements the slow-query log
// (d1-compat) already shipped. Cheap; mount outermost so it times the whole
// chain and sees the final status + (for authed routes) the resolved user.
//
// Sentry/error-aggregation is intentionally NOT wired here to avoid adding a
// Worker dependency + bundle weight; the onError humanizer already returns
// clean errors. Add a SENTRY_DSN-gated hook later if error aggregation is wanted.

function requestId(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export const requestLog: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const id = c.req.header("X-Request-Id") || requestId();
  c.header("X-Request-Id", id);
  c.set("requestId", id);
  const t0 = Date.now();
  await next();
  const ms = Date.now() - t0;
  const path = new URL(c.req.url).pathname;
  if (path === "/health") return; // skip keep-alive noise
  const uid = c.get("user")?.id ?? "-";
  console.log(`[req] ${c.req.method} ${path} ${c.res.status} ${ms}ms id=${id} user=${uid}`);
};
