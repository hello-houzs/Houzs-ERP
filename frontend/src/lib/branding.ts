// ----------------------------------------------------------------------------
// Company identity (Branding) — ONE source of truth for the company name /
// registration no / address / phone / email / website that used to be hardcoded
// across the app chrome, the login screen, and the jspdf document letterheads.
//
// Two consumption paths share this module:
//   • React components read it via useBranding() (hooks/useBranding.ts), which
//     fetches GET /api/branding once and caches it through the app's query layer.
//   • The pure jspdf PDF libs (vendor/scm/lib/pdf-common.ts) can't use hooks, so
//     they read getBrandingCache() — a plain module-level snapshot that
//     useBranding() pushes via setBrandingCache() the moment the fetch resolves.
//
// DEFAULT_BRANDING carries the CURRENT hardcoded values VERBATIM so the chrome,
// login screen, and PDFs render identically before the fetch resolves (or if it
// fails / the app is offline) — only centralised, nothing changes visually.
// ----------------------------------------------------------------------------

export interface Branding {
  companyName: string;
  registrationNo: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  /** R2 object key for an uploaded logo. Reserved — logo upload is deferred. */
  logoR2Key: string;
}

/** Seeded defaults — VERBATIM the values that were hardcoded before this change
 *  (frontend pdf-common.ts COMPANY + AuthScreens "Houzs Century" lockup + the
 *  email from-address). Mirrors the 0038_branding_config.sql seed row so the
 *  fetch returns the same values it falls back to. */
export const DEFAULT_BRANDING: Branding = {
  companyName: "Houzs Century Sdn Bhd",
  registrationNo: "202201031135 (1476832-W)",
  address:
    "1831-B, Jalan KPB 1, Kawasan Perindustrian Balakong, 43300 Seri Kembangan, Selangor.",
  phone: "011-1110 8883",
  email: "hello@houzscentury.com",
  website: "",
  logoR2Key: "",
};

/** Normalise a partial/loose server payload into a complete Branding, falling
 *  back to the seeded default for any missing/blank field. Dual-reads
 *  camelCase ?? snake_case so a snake_cased backend column never reads
 *  undefined (the repo's #1 recurring bug). */
export function normalizeBranding(raw: unknown): Branding {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string, fallback: string): string => {
    const v = (r[camel] ?? r[snake]) as unknown;
    const s = v == null ? "" : String(v).trim();
    return s || fallback;
  };
  return {
    companyName: pick("companyName", "company_name", DEFAULT_BRANDING.companyName),
    registrationNo: pick("registrationNo", "registration_no", DEFAULT_BRANDING.registrationNo),
    address: pick("address", "address", DEFAULT_BRANDING.address),
    phone: pick("phone", "phone", DEFAULT_BRANDING.phone),
    email: pick("email", "email", DEFAULT_BRANDING.email),
    // website + logoR2Key default to empty (not the seed) — they're genuinely
    // optional, so a blank server value must stay blank, not snap to a literal.
    website: ((r.website ?? r.web_site) as string | undefined)?.toString().trim() ?? "",
    logoR2Key: ((r.logoR2Key ?? r.logo_r2_key) as string | undefined)?.toString().trim() ?? "",
  };
}

// ── Module-level cache for the pure (non-React) jspdf libs ────────────────────
// Pre-seeded with DEFAULT_BRANDING so a PDF generated before any fetch (or with
// the fetch failed) still carries the correct letterhead. useBranding() calls
// setBrandingCache() on every successful fetch to keep this in sync.
let brandingCache: Branding = DEFAULT_BRANDING;

export function setBrandingCache(b: Branding): void {
  brandingCache = b;
}

export function getBrandingCache(): Branding {
  return brandingCache;
}
