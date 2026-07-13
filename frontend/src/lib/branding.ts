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
  /** R2 object key for an uploaded logo ("" = none). Uploaded in Settings →
   *  Branding; served via GET /api/branding/logo (auth-gated). */
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

/** 2990 company defaults — mirrors the backend's DEFAULT_BRANDING_2990 and
 *  migration 0093 seed. Blank fields are owner-editable placeholders; they
 *  must STAY blank (letterheads omit blank lines), never snap to a Houzs
 *  literal. */
export const DEFAULT_BRANDING_2990: Branding = {
  companyName: "2990's Home",
  registrationNo: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoR2Key: "",
};

/** Defaults for the given company code (GET /api/branding echoes the active
 *  company's code alongside the branding). Unknown/absent code → HOUZS, the
 *  pre-multi-company behaviour. */
export function defaultBrandingForCompany(companyCode?: string | null): Branding {
  const code = (companyCode ?? "").trim().toUpperCase();
  if (code === "2990") return { ...DEFAULT_BRANDING_2990 };
  return { ...DEFAULT_BRANDING };
}

/** Normalise a partial/loose server payload into a complete Branding, falling
 *  back to the given company's default for any missing/blank field (default:
 *  the HOUZS seed — untouched callers unchanged). Dual-reads
 *  camelCase ?? snake_case so a snake_cased backend column never reads
 *  undefined (the repo's #1 recurring bug). */
export function normalizeBranding(
  raw: unknown,
  defaults: Branding = DEFAULT_BRANDING,
): Branding {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string, fallback: string): string => {
    const v = (r[camel] ?? r[snake]) as unknown;
    const s = v == null ? "" : String(v).trim();
    return s || fallback;
  };
  return {
    companyName: pick("companyName", "company_name", defaults.companyName),
    registrationNo: pick("registrationNo", "registration_no", defaults.registrationNo),
    address: pick("address", "address", defaults.address),
    phone: pick("phone", "phone", defaults.phone),
    email: pick("email", "email", defaults.email),
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

// ── Logo memo for the pure (non-React) jspdf libs ─────────────────────────────
// jspdf needs the image as a dataURL + its natural dimensions, and drawHeader()
// is synchronous — so the logo is fetched ONCE (authed, via the api client) and
// memoized at module level, keyed by logoR2Key. Upload keys carry a Date.now()
// stamp (new upload = new key), so key equality is a correct cache check.
// Multi-page / multi-print runs reuse the memo instead of refetching.

export interface BrandingLogo {
  key: string;
  dataUrl: string;
  /** jspdf addImage format tag. */
  format: "PNG" | "JPEG";
  /** Natural pixel size — used to preserve the aspect ratio in the header. */
  width: number;
  height: number;
}

let logoCache: BrandingLogo | null = null;
let logoInflight: Promise<void> | null = null;
let logoFailedKey: string | null = null; // don't hammer a 404/broken key

/** Sync accessor for drawHeader(). null = no logo (text-only header). */
export function getBrandingLogoCache(): BrandingLogo | null {
  const key = brandingCache.logoR2Key;
  if (!key) return null;
  return logoCache && logoCache.key === key ? logoCache : null;
}

/** Drop the memo — called after a logo upload/remove in Settings so the next
 *  PDF re-reads the new state instead of a stale image. */
export function clearBrandingLogoCache(): void {
  logoCache = null;
  logoInflight = null;
  logoFailedKey = null;
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });

const dataUrlDimensions = (dataUrl: string): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });

/**
 * Ensure the branding logo (if any) is memoized for the PDF libs. Fail-soft:
 * any fetch/decode failure leaves the memo empty, and the letterhead simply
 * renders text-only — a PDF must never fail because of a logo. Concurrent
 * callers share one in-flight fetch.
 */
export async function ensureBrandingLogoLoaded(): Promise<void> {
  const key = brandingCache.logoR2Key;
  if (!key) return;                                   // no logo configured
  if (logoCache && logoCache.key === key) return;     // memo is current
  if (logoFailedKey === key) return;                  // known-bad — don't retry per print
  if (logoInflight) return logoInflight;

  logoInflight = (async () => {
    try {
      // Lazy import avoids a static api/client dependency for the many
      // consumers that only need the text branding.
      const { api, tokenStore } = await import("../api/client");
      const token = tokenStore.get();
      const res = await fetch(`${api.baseUrl}/api/branding/logo`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`logo fetch ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await blobToDataUrl(blob);
      const { width, height } = await dataUrlDimensions(dataUrl);
      if (!width || !height) throw new Error("logo has no dimensions");
      const format: BrandingLogo["format"] =
        blob.type === "image/png" || dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      logoCache = { key, dataUrl, format, width, height };
      logoFailedKey = null;
    } catch {
      logoFailedKey = key; // fail-soft: text-only header this session
    } finally {
      logoInflight = null;
    }
  })();
  return logoInflight;
}

// ── Per-brand logo memo (owner 2026-07 — brand letterheads on the SO PDF) ─────
// Same contract as the company-logo memo above, but keyed by the brand's R2
// key (project_brands.logo_r2_key, served by GET /api/projects/brands/logo).
// GET /api/scm/mfg-sales-orders/:docNo stamps `resolvedBrandLogoKey`; the SO
// PDF warms this memo with it and passes the result to drawHeader() in place
// of the company logo (company letterhead stays the fallback). Upload keys
// carry a Date.now() stamp (new upload = new key), so key equality is a
// correct cache check and the memo never serves a stale image.

const brandLogoCache = new Map<string, BrandingLogo>();
const brandLogoInflight = new Map<string, Promise<void>>();
const brandLogoFailed = new Set<string>(); // don't hammer a 404/broken key

/** Sync accessor for drawHeader() callers. null = not loaded / no brand logo
 *  (the header falls back to the company logo, then text-only). */
export function getBrandLogoCache(key: string | null | undefined): BrandingLogo | null {
  if (!key) return null;
  return brandLogoCache.get(key) ?? null;
}

/** Drop the memo — called after a brand-logo upload/remove in Project
 *  Maintenance so the next PDF re-reads the new state instead of a stale
 *  image. */
export function clearBrandLogoCache(): void {
  brandLogoCache.clear();
  brandLogoInflight.clear();
  brandLogoFailed.clear();
}

/**
 * Ensure a brand logo is memoized for the PDF libs. Fail-soft: any
 * fetch/decode failure leaves the memo empty and the SO letterhead falls back
 * to the company logo — a PDF must never fail because of a logo. Concurrent
 * callers share one in-flight fetch per key.
 */
export async function ensureBrandLogoLoaded(key: string | null | undefined): Promise<void> {
  if (!key) return;                                    // no brand logo resolved
  if (brandLogoCache.has(key)) return;                 // memo is current
  if (brandLogoFailed.has(key)) return;                // known-bad — don't retry per print
  const inflight = brandLogoInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      // Lazy import avoids a static api/client dependency for the many
      // consumers that only need the text branding (same as the company memo).
      const { api, tokenStore } = await import("../api/client");
      const token = tokenStore.get();
      const res = await fetch(
        `${api.baseUrl}/api/projects/brands/logo?key=${encodeURIComponent(key)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error(`brand logo fetch ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await blobToDataUrl(blob);
      const { width, height } = await dataUrlDimensions(dataUrl);
      if (!width || !height) throw new Error("logo has no dimensions");
      const format: BrandingLogo["format"] =
        blob.type === "image/png" || dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      brandLogoCache.set(key, { key, dataUrl, format, width, height });
    } catch {
      brandLogoFailed.add(key); // fail-soft: company letterhead this session
    } finally {
      brandLogoInflight.delete(key);
    }
  })();
  brandLogoInflight.set(key, p);
  return p;
}
