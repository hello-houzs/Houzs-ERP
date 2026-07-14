import { useEffect } from "react";
import { useQuery } from "./useQuery";
import { api } from "../api/client";
import {
  type Branding,
  HOUZS_COMPANY_CODE,
  defaultBrandingForCompany,
  ensureBrandingLogoLoaded,
  hostDefaultCompanyCode,
  normalizeBranding,
  setBrandingCache,
  shortCompanyName,
} from "../lib/branding";

interface BrandingResponse {
  branding?: unknown;
  /** Active company the backend resolved for this request ('HOUZS' | '2990').
   *  Picks the matching default set so a blank 2990 field stays blank instead
   *  of snapping to a Houzs literal. Absent on a pre-multi-company backend. */
  companyCode?: string | null;
  /** postgres.js camelCases raw-SQL columns, but dual-read the snake form
   *  anyway (repo's #1 recurring bug class). */
  company_code?: string | null;
}

/** Branding plus the company it belongs to. All Branding fields are present,
 *  so every existing `const branding = useBranding()` callsite is unchanged. */
export type BrandingWithCompany = Branding & { companyCode: string };

/**
 * Company identity for the app chrome, the login screen, and (indirectly, via
 * the module-level cache) the jspdf letterheads.
 *
 * Fetches GET /api/branding once and caches it through the shared query layer
 * (request-dedup + SWR for free). The backend resolves the ACTIVE company
 * (top-bar switcher header → hostname default → HOUZS) and echoes its code;
 * switching company invalidates every query, so this refetches and the whole
 * chrome + PDF cache flips to the new company's identity.
 *
 * While the fetch is pending or if it fails (including pre-auth on the login
 * screen, where /api/branding 401s), callers get the HOSTNAME company's
 * defaults — Houzs literals on Houzs hosts (unchanged), 2990's name on a 2990
 * host — so the UI never flashes empty and never shows the wrong company.
 *
 * On every successful fetch we also push the value into the module-level cache
 * (lib/branding.ts) so the pure PDF libs, which can't call hooks, draw the same
 * letterhead.
 */
export function useBranding(): BrandingWithCompany {
  // Company identity is effectively static — cache it for the session so it's
  // fetched once, not re-requested on every navigation (default 30s staleTime).
  const q = useQuery<BrandingResponse>(() => api.get("/api/branding"), [], {
    staleTime: Infinity,
  });

  const companyCode = (
    (q.data?.companyCode ?? q.data?.company_code)?.trim() ||
    hostDefaultCompanyCode()
  ).toUpperCase();
  const branding = q.data
    ? normalizeBranding(q.data.branding, defaultBrandingForCompany(companyCode))
    : defaultBrandingForCompany(companyCode);

  // Keep the non-React PDF cache in sync once the real value lands.
  useEffect(() => {
    if (q.data) {
      setBrandingCache(branding, companyCode);
      // Warm the letterhead-logo memo in the background so the first PDF of
      // the session already has it. Fail-soft + memoized inside — a broken
      // logo never surfaces here, and repeat mounts don't refetch.
      void ensureBrandingLogoLoaded();
    }
    // branding is derived from q.data; depend on the raw payload to avoid a new
    // object identity re-firing the effect every render.
  }, [q.data, branding, companyCode]);

  // Browser-tab title follows the active company. HOUZS keeps the exact
  // index.html literal (byte-identical single-company behaviour); other
  // companies get "<short name> ERP". Vendored SCM pages that set their own
  // document.title win afterwards — this only runs when the company flips.
  useEffect(() => {
    document.title =
      companyCode === HOUZS_COMPANY_CODE
        ? "Houzs Century ERP"
        : `${shortCompanyName(branding.companyName)} ERP`;
  }, [companyCode, branding.companyName]);

  return { ...branding, companyCode };
}
