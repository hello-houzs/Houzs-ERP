import type { Env } from "../types";

// ── Branding (company identity) ───────────────────────────────
//
// ONE source of truth for the company name / SSM registration no /
// address / phone / email / website / optional logo that used to be
// hardcoded across ~30 files (backend OCR prompts + email + the
// frontend PDF letterheads / shell chrome). The owner edits it in
// Settings; every consumer reads it from here.
//
// Storage: the existing app_settings key/value JSON store (the same
// table the email channel toggles live in) under the single key
// 'branding'. Seeded with the CURRENT hardcoded values by migration
// 0038 so nothing changes visually on rollout — only centralised.

export interface Branding {
  companyName: string;
  registrationNo: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  // R2 object key for an optional uploaded logo; "" when none.
  logoR2Key: string;
}

const BRANDING_KEY = "branding";

// Fallback identical to migration 0038's seed (and the historical
// hardcodes). Used only if the row is missing (fresh/restored DB before
// the migration runs) so consumers never get an empty company name.
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

// Coerce a parsed JSON blob into a complete Branding, filling any missing
// field from the default. Tolerates partial rows written by older code.
function normalize(raw: unknown): Branding {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  return {
    companyName: str(r.companyName, DEFAULT_BRANDING.companyName),
    registrationNo: str(r.registrationNo, DEFAULT_BRANDING.registrationNo),
    address: str(r.address, DEFAULT_BRANDING.address),
    phone: str(r.phone, DEFAULT_BRANDING.phone),
    email: str(r.email, DEFAULT_BRANDING.email),
    website: str(r.website, DEFAULT_BRANDING.website),
    logoR2Key: str(r.logoR2Key, DEFAULT_BRANDING.logoR2Key),
  };
}

// Read the single branding row. Reuses the app_settings JSON store via the
// d1-compat shim (env.DB) so it works from both the public-schema routes and
// the scm routes (same Env.DB binding). Falls back to DEFAULT_BRANDING when
// the row is missing or unparseable — never throws.
export async function getBranding(env: Env): Promise<Branding> {
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM app_settings WHERE key = ?`,
    )
      .bind(BRANDING_KEY)
      .first<{ value: string }>();
    if (!row?.value) return { ...DEFAULT_BRANDING };
    return normalize(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

// Upsert the branding row. Mirrors email.ts setSetting (same app_settings
// upsert + datetime('now') TEXT timestamp via the shim). updatedBy is the
// editing user's id for the audit columns.
export async function setBranding(
  env: Env,
  branding: Branding,
  updatedBy: number | null,
): Promise<void> {
  const json = JSON.stringify(branding);
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`,
  )
    .bind(BRANDING_KEY, json, updatedBy ?? null)
    .run();
}
