import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { getUserBySession, type AuthUser } from "../services/auth";
import { hasPermission } from "../services/permissions";
import {
  fullAccessMap,
  meetsLevel,
  type AccessLevel,
} from "../services/pageAccess";

// Legacy "service" user — used when a request authenticates with the
// shared DASHBOARD_API_KEY env var (cron jobs, internal tooling). Has
// the wildcard permission, so it can hit anything.
const SERVICE_USER: AuthUser = {
  id: 0,
  email: "service@local",
  name: "Service",
  role_id: 0,
  role_name: "Service",
  status: "active",
  permissions: ["*"],
  permissions_set: new Set(["*"]),
  manager_id: null,
  scope_to_pic: false,
  department_id: null,
  brand_scope: null,
  page_access: fullAccessMap(),
};

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    /** Page-level access for the current request — set by
     *  `requirePageAccess`. Routes that need partial/full branching
     *  read this instead of recomputing. */
    access_level: AccessLevel;
  }
}

/**
 * Auth middleware. Accepts either:
 *   - Bearer <session-token>  → validated against the sessions table
 *   - Bearer <DASHBOARD_API_KEY> → legacy shared key, treated as service user
 *
 * On success the user (with their permissions) is attached to the
 * Hono context as `c.get("user")`. Routes can then call
 * `requirePermission(perm)` for granular gating.
 */
// Public API sub-paths that live under /api/* but must NOT require
// staff auth. Customer-facing endpoints (survey, track lookup, portal
// case view) all sit here so Cloudflare Pages' single /api/* rewrite
// forwards them without route collisions against SPA paths.
const PUBLIC_API_PREFIXES = [
  "/api/survey",
  "/api/track",
  "/api/portal",
  "/api/auth",
  "/api/supplier-auth",
  "/api/supplier",
];

export const auth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_API_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
    await next();
    return;
  }

  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Legacy shared key — service-tier access for tooling and cron.
  if (c.env.DASHBOARD_API_KEY && token === c.env.DASHBOARD_API_KEY) {
    c.set("user", SERVICE_USER);
    await next();
    return;
  }

  // Otherwise it's a session token.
  const user = await getUserBySession(c.env, token);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", user);
  await next();
};

/**
 * Per-route permission gate. Pass a single permission key.
 *
 * Usage:
 *   app.post("/", requirePermission("users.manage"), async (c) => {...})
 */
export function requirePermission(perm: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    // Fast path: O(1) Set lookup. Falls back to the array form for
    // any caller that builds AuthUser without going through
    // hydrateAuthUser (e.g. tests / scripts).
    const granted = user.permissions_set ?? user.permissions;
    if (!hasPermission(granted, perm)) {
      return c.json({ error: `Forbidden: missing ${perm}` }, 403);
    }
    await next();
  };
}

/**
 * Per-route gate that accepts ANY of the listed permissions. Used where
 * a narrow permission (e.g. projects.chat) and a broader one
 * (projects.write) should both unlock the same endpoint, so admins can
 * pick the least-privilege fit per role.
 *
 * Usage:
 *   app.post("/:id/notes",
 *     requireAnyPermission(["projects.write", "projects.chat"]),
 *     handler);
 */
export function requireAnyPermission(perms: string[]): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const granted = user.permissions_set ?? user.permissions;
    if (!perms.some((p) => hasPermission(granted, p))) {
      return c.json(
        { error: `Forbidden: requires one of ${perms.join(", ")}` },
        403
      );
    }
    await next();
  };
}

/**
 * Per-page access gate. Reads `user.page_access[pageKey]` and compares
 * against `minLevel` (default 'partial' — i.e. user needs ≥partial to
 * enter). The wildcard `*` permission short-circuits to 'full'.
 *
 * Sets `c.var.access_level` so downstream handlers can branch on the
 * resolved level without re-checking.
 *
 * Usage:
 *   app.get("/", requirePageAccess("sales"), async (c) => {
 *     const level = c.get("access_level"); // 'partial' | 'full'
 *     ...
 *   });
 *
 *   app.post("/", requirePageAccess("sales", "full"), handler); // write
 */
export function requirePageAccess(
  pageKey: string,
  minLevel: AccessLevel = "partial",
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const granted = user.permissions_set ?? user.permissions;
    if (hasPermission(granted, "*")) {
      c.set("access_level", "full");
      await next();
      return;
    }
    const level: AccessLevel = (user.page_access?.[pageKey] ?? "none") as AccessLevel;
    if (!meetsLevel(level, minLevel)) {
      return c.json(
        { error: `Forbidden: needs ${minLevel} access to ${pageKey}` },
        403,
      );
    }
    c.set("access_level", level);
    await next();
  };
}
