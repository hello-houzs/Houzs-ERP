import { useEffect } from "react";
import { useQuery } from "./useQuery";
import { api } from "../api/client";
import {
  type Branding,
  DEFAULT_BRANDING,
  normalizeBranding,
  setBrandingCache,
} from "../lib/branding";

interface BrandingResponse {
  branding?: unknown;
}

/**
 * Company identity for the app chrome, the login screen, and (indirectly, via
 * the module-level cache) the jspdf letterheads.
 *
 * Fetches GET /api/branding once and caches it through the shared query layer
 * (request-dedup + SWR for free). The endpoint is read-open so the login screen
 * — which renders before any session exists — can also show the right company
 * name. While the fetch is pending or if it fails, callers get DEFAULT_BRANDING
 * (the seeded literals), so the UI never flashes empty and never breaks offline.
 *
 * On every successful fetch we also push the value into the module-level cache
 * (lib/branding.ts) so the pure PDF libs, which can't call hooks, draw the same
 * letterhead.
 */
export function useBranding(): Branding {
  const q = useQuery<BrandingResponse>(() => api.get("/api/branding"));

  const branding = q.data
    ? normalizeBranding(q.data.branding)
    : DEFAULT_BRANDING;

  // Keep the non-React PDF cache in sync once the real value lands.
  useEffect(() => {
    if (q.data) setBrandingCache(branding);
    // branding is derived from q.data; depend on the raw payload to avoid a new
    // object identity re-firing the effect every render.
  }, [q.data, branding]);

  return branding;
}
