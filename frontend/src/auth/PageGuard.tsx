import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";
import type { AccessLevel } from "../types";

/**
 * Read the current user's access level for a page (mig 073).
 * Thin wrapper over `useAuth().pageAccess(page)` for ergonomic use
 * inside page components. The `*` wildcard short-circuits to "full"
 * so admins always pass.
 *
 * Usage:
 *   const level = usePageAccess("sales");
 *   if (level === "partial") // show own-only view
 */
export function usePageAccess(page: string): AccessLevel {
  return useAuth().pageAccess(page);
}

/**
 * Route guard for per-page access. Replaces the legacy
 * `<Guard perm="<resource>.read">` for migrated pages.
 *
 * `minLevel` defaults to "partial" — i.e. the user needs at least
 * partial access to enter. Pass `"full"` for admin-only routes where
 * the partial view doesn't make sense.
 *
 * Users who don't meet the minimum get redirected home, matching
 * the existing `<Guard>` behaviour.
 */
export function PageGuard({
  page,
  minLevel = "partial",
  children,
}: {
  page: string;
  minLevel?: AccessLevel;
  children: ReactNode;
}) {
  const level = usePageAccess(page);
  const rank: Record<AccessLevel, number> = { none: 0, partial: 1, full: 2 };
  if (rank[level] < rank[minLevel]) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
