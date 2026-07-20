import { useLocation } from "react-router-dom";

export type AppSurface = "survey" | "portal" | "reset" | "invite" | "staff";

/**
 * Pick the top-level application tree for one browser location.
 *
 * This must run from the live Router location, not once at module evaluation:
 * reset/invite screens navigate back to `/`, and a frozen decision leaves the
 * new URL trapped inside the old public-only route tree.
 */
export function appSurfaceForPath(pathname: string): AppSurface {
  if (pathname.startsWith("/survey/")) return "survey";
  if (
    pathname === "/track" ||
    pathname.startsWith("/track/") ||
    pathname === "/portal" ||
    pathname.startsWith("/portal/")
  ) return "portal";
  if (pathname.startsWith("/reset/")) return "reset";
  if (pathname.startsWith("/invite/")) return "invite";
  return "staff";
}

export function useAppSurface(): AppSurface {
  return appSurfaceForPath(useLocation().pathname);
}
