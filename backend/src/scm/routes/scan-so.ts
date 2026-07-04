// ---------------------------------------------------------------------------
// /scan-so — Claude-powered OCR for HANDWRITTEN showroom sale-order slips
// (phone photos of Zanotti / AKEMI-style carbon-copy forms) → structured JSON
// the Backend "Scan Order" modal turns into a prefilled New SO.
//
// Ported from HOOKKA's scan-po.ts (typed customer-PO PDFs) and adapted:
//   • input is image(s) (jpeg/png/webp) or a PDF, not PDF-only;
//   • catalog injection pulls live from Supabase Postgres (mfg_products,
//     fabric_trackings, maintenance config sofa sizes/leg heights);
//   • few-shot pool = the 5 most recent operator-CONFIRMED so_scan_samples
//     rows, filtered to the slip's SALESPERSON first (fall back to global);
//   • per-SALESPERSON learning (vs HOOKKA's per-customer): each rep has
//     their own handwriting/notation habits that differ per product
//     category, so a distilled rules block (so_scan_rules, organized by
//     SOFA / MATTRESS / BEDFRAME / ACCESSORY / SERVICE sections) is
//     regenerated from that rep's corrected samples after every confirm;
//   • PLUS a GLOBAL shared alias layer (reserved so_scan_rules row
//     '__GLOBAL__'): a product-name/fabric-code alias dictionary distilled
//     from the latest corrected samples ACROSS ALL reps ("Bamboo Cruise" /
//     "Cruise" / "B.Cruise" → one SKU), injected into EVERY scan so one
//     rep's corrections teach all reps. Refreshed on every confirm
//     (fire-and-forget) and weekly (before the per-rep pass).
//
// Endpoints:
//   POST /scan-so/extract                     — multipart image(s)/pdf (+ salesperson field) → JSON + sampleId
//   POST /scan-so/enqueue                     — same inputs; queue a BACKGROUND job that OCRs + creates a DRAFT SO
//   GET  /scan-so/jobs/:id                    — poll a background job (status / soDocNo / error)
//   GET  /scan-so/jobs?salesperson=           — latest 20 background jobs (optionally one rep's)
//   POST /scan-so/jobs/clear-failed           — delete the caller's failed (status=error) jobs ('*' clears all reps')
//   POST /scan-so/samples/:id/confirm         — store operator-corrected JSON (+ salesperson); auto-distills rep rules
//   GET  /scan-so/salespeople                 — distinct reps seen across samples + rules (modal datalist)
//   GET  /scan-so/rules/:salesperson          — view a rep's distilled rules
//   POST /scan-so/rules/:salesperson/distill  — manually regenerate a rep's rules
//
// Setup:
//   npx wrangler secret put ANTHROPIC_API_KEY
//
// Prompt caching: the SYSTEM_PROMPT + catalog block is sent as a
// cache_control:ephemeral prefix — identical across calls until the catalog
// changes, so repeat scans within 5 min get the ~90% cached-input discount.
//
// Auth: same as mfg-sales-orders write routes — supabaseAuth on every
// endpoint (any signed-in staff member; RLS scopes what the user client can
// read). Sample rows are written via the service-role client so extraction
// works even before migration 0164's RLS policy lands.
//
// Houzs adaptation: same plumbing as the sibling SCM routes. The 2990's
// original built its own service client via createClient(...) defaulting to
// the `public` schema; in Houzs the so_scan_samples / so_scan_rules /
// mfg_products / fabric_trackings / maintenance_config_history /
// so_dropdown_options tables live in the dedicated `scm` Postgres schema, so
// serviceClient() here returns getSupabaseService(env) (db:{schema:'scm'}) —
// every sb.from('...') resolves to scm.*, never public.*. The catalog read
// uses c.get('supabase') (also scm-scoped, attached by supabaseAuth).
// ANTHROPIC_API_KEY is OPTIONAL on the Houzs Env: when absent /extract returns
// 503 anthropic_key_missing — it must not break the worker or tsc.
// Crons (wired in backend/src/index.ts scheduled()): the keep-warm cron
// (warmCatalogCacheForCron) fires during showroom hours so the catalog prompt
// cache rarely goes cold, and the weekly distill cron (distillAllSalespersonRules,
// Sunday-gated in the 02:00 UTC slot) re-distills every rep's rules plus the
// cross-rep __GLOBAL__ alias dictionary AND __GLOBAL_RULES__ shared rules. The
// per-confirm fire-and-forget distill remains the primary fast learning path.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { paginateAll } from '../lib/paginate-all';
import { getBranding } from '../../services/branding';
// Background scan job — the DRAFT SO is created through mfg-sales-orders'
// factored create core (PRICING-CRITICAL; never reimplemented here), and each
// scanned payment RECEIPT becomes a payments-ledger row through the same
// factored insert+audit core the interactive POST /:docNo/payments route uses.
import { createDraftSalesOrder, recordSoPaymentRow } from './mfg-sales-orders';
import { todayMyt } from '../lib/my-time';
import { normalizePhone } from '../shared/phone';

// The scm-scoped service client (getSupabaseService, db:{schema:'scm'}) and the
// middleware-attached c.get('supabase') are both schema-parameterised clients.
// Use the loosely-typed form (matches scm/env.ts Variables.supabase) so the
// scm-schema client is assignable wherever the ported code expects a client.
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const scanSo = new Hono<{ Bindings: Env; Variables: Variables }>();
scanSo.use('*', supabaseAuth);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Anthropic (and gateways in front of it) return transient 429 rate-limits and
// 529 "Overloaded" / 5xx spikes that clear on a retry; a single hit otherwise
// fails the whole scan/distill with a hard error. Retry those a few times with
// an exponential-ish backoff. Non-retryable statuses (4xx other than 429) and
// the final attempt fall straight through to the caller's existing !resp.ok
// handling, so the response shape is unchanged. Only the transport is retried —
// the prompt/body and response parsing are untouched.
const RETRYABLE_ANTHROPIC_STATUS = new Set([429, 500, 502, 503, 529]);

async function anthropicFetchWithRetry(
  init: RequestInit,
  tries = 3,
): Promise<Response> {
  let resp: Response | null = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    resp = await fetch(ANTHROPIC_URL, init);
    if (resp.ok) return resp;
    // Peek the body for an explicit overloaded_error without consuming the
    // Response the caller reads — clone so the returned body survives. Some
    // gateways surface an overloaded body under a status outside the set.
    let overloaded = false;
    try {
      const peek = await resp.clone().text();
      if (/overloaded/i.test(peek)) overloaded = true;
    } catch { /* body peek is best-effort */ }
    const retryable = RETRYABLE_ANTHROPIC_STATUS.has(resp.status) || overloaded;
    if (!retryable || attempt === tries - 1) return resp;
    // 400ms, 800ms, 1600ms … keeps the whole retry window well under the
    // per-call AbortSignal.timeout budget.
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  return resp as Response;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ArrayBuffer -> base64. Workers don't expose Node's Buffer; the chunked loop
// keeps stack usage bounded for large files. (Ported from HOOKKA scan-po.)
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Phone normalisation — Malaysian numbers to a bare national-significant form
// under the +60 country prefix, WITHOUT the leading trunk 0. The slip writes
// "0197770309" / "012-345 6789" / "+6017 888 9999"; the form stores the part
// AFTER +60, so a leading 0 must be dropped ("0197770309" → "197770309"). Any
// existing +60 / 60 country prefix is also stripped. Non-MY-looking strings
// fall through unchanged (digits-only) so nothing is silently corrupted.
// ---------------------------------------------------------------------------
function normalizeMyPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/[^\d]/g, '');
  if (digits === '') return null;
  // Strip a leading +60 / 60 country code, then the trunk 0.
  if (digits.startsWith('60')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  return digits === '' ? null : digits;
}

// ---------------------------------------------------------------------------
// Google Geocoding — turn the raw handwritten address text into accurate
// state / city / postcode. The LLM frequently mis-parses Malaysian areas
// (e.g. "Melawati" sits in KL/Setapak ~53100, not Ampang/Selangor 68000), so
// when GOOGLE_MAPS_API_KEY is present we geocode the raw address and prefer the
// returned components over the LLM guess. Fail-soft: missing key / network
// error / no confident result → return null and keep the LLM parse.
// ---------------------------------------------------------------------------
type GeocodeParts = { state: string | null; city: string | null; postcode: string | null };
async function geocodeAddress(
  rawAddress: string | null | undefined,
  apiKey: string | undefined,
): Promise<GeocodeParts | null> {
  const addr = (rawAddress ?? '').trim();
  if (!apiKey || addr === '') return null;
  try {
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json' +
      `?address=${encodeURIComponent(addr)}&region=my&components=country:MY&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return null;
    const body = (await resp.json()) as {
      status?: string;
      results?: Array<{
        address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>;
      }>;
    };
    if (body.status !== 'OK' || !body.results?.length) return null;
    const comps = body.results[0].address_components ?? [];
    const pick = (type: string): string | null => {
      const c = comps.find((x) => (x.types ?? []).includes(type));
      return (c?.long_name ?? '').trim() || null;
    };
    const state = pick('administrative_area_level_1');
    // City: prefer locality, fall back to the postal town / admin level 2.
    const city = pick('locality') ?? pick('postal_town') ?? pick('administrative_area_level_2');
    const postcode = pick('postal_code');
    if (!state && !city && !postcode) return null;
    return { state, city, postcode };
  } catch {
    return null;
  }
}

// Postcode IS the driver (spec section 4): once the geocoder resolves a precise
// 5-digit postcode, the city + state must come from the SAME my_localities row
// the New SO form's cascade fills from that postcode — NOT from Google's own
// (sometimes divergent) admin-area components. This snaps the seeded city/state
// to the catalog's own postcode→city→state mapping so the form's dropdowns can
// actually select them. Fail-soft: no postcode / no matching row / query error
// → return null and let the Google components stand.
async function localityForPostcode(
  sb: SupabaseClient,
  postcode: string | null | undefined,
): Promise<{ city: string | null; state: string | null } | null> {
  const pc = (postcode ?? '').replace(/[^\d]/g, '');
  if (pc.length !== 5) return null;
  try {
    const { data, error } = await sb
      .from('my_localities')
      .select('city, state')
      .eq('postcode', pc)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    const city = typeof row.city === 'string' && row.city.trim() !== '' ? row.city : null;
    const state = typeof row.state === 'string' && row.state.trim() !== '' ? row.state : null;
    if (!city && !state) return null;
    return { city, state };
  } catch {
    return null;
  }
}

// JSON-coercion recovery (ported verbatim from HOOKKA scan-po.ts) — Claude
// sometimes wraps the result in fences, sometimes adds a "Looking at the
// image…" preamble, sometimes both. Parse a best-effort substring rather
// than fail the whole extraction.
function stripJsonFences(text: string): string {
  let trimmed = text.trim();

  // 1) ```json … ``` or ``` … ```
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const fenceMatch = trimmed.match(fenceRe);
  if (fenceMatch?.[1]) trimmed = fenceMatch[1].trim();

  // 2) Strip any chain-of-thought preamble. The valid payload always starts
  //    with `{` — take from the first `{` to the last `}`.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

// ===========================================================================
// Catalog — pulled live from Supabase on every /extract call.
// ===========================================================================
type CatalogSku = {
  code: string;
  name: string;
  category: string;       // SOFA | BEDFRAME | MATTRESS | ACCESSORY | SERVICE
  baseModel: string | null;
};
type CatalogFabric = { code: string; description: string | null };
// SOFA Special Add-ons (scm.special_addons, migration 0134) — the configured
// specials the SO line editor's accordion offers. ACTIVE rows only; injected
// into the cached prompt prefix so the OCR can map a slip remark ("change nylon
// cover") to a configured special CODE and mark it on the line instead of
// dumping it in notes. allowedModels = the SOFA model_codes whose
// allowed_options.specials includes this code (validateSlip uses it to keep a
// matched special only when the line's resolved model actually offers it).
type CatalogSpecial = {
  code: string;
  label: string;
  soDescription: string | null;
  categories: string[];
};

// SO Maintenance vocabularies (so_dropdown_options, migration 0081) — the
// option groups the SO Maintenance page edits. ACTIVE rows only; injected
// into the cached prompt prefix as allowed-values lists so the OCR can map
// handwritten payment notes ("mbb 12 EPP") to exact maintenance values.
const OPTION_CATEGORIES = [
  'payment_method',     // L1 method — locked three: Merchant / Online / Cash
  'payment_merchant',   // L2 merchant banks (MBB / CIMB / Public / …)
  'online_type',        // L2 online sub-types (Bank Transfer / TNG / Cheque / DuitNow)
  'installment_plan',   // L2 plans (One Shot / 3 / 6 / 12 / 24 / 36 months)
  'customer_type',      // New / Existing
  'building_type',      // Condo / Landed / …
  'venue',              // showroom / roadshow venues
] as const;
type OptionCategory = (typeof OPTION_CATEGORIES)[number];
type CatalogOption = { value: string; label: string };
type CatalogOptions = Record<OptionCategory, CatalogOption[]>;

const emptyOptions = (): CatalogOptions => ({
  payment_method:   [],
  payment_merchant: [],
  online_type:      [],
  installment_plan: [],
  customer_type:    [],
  building_type:    [],
  venue:            [],
});

type Catalog = {
  skus: CatalogSku[];
  fabrics: CatalogFabric[];
  // Configured SOFA Special Add-ons (active special_addons rows) — feeds the
  // OCR's specialsMatch so a slip remark resolves to a configured special code.
  specials: CatalogSpecial[];
  // SKU code → the special CODES its Model offers (allowed_options.specials).
  // validateSlip resolves a line's model from skuMatch.code and keeps only a
  // matched special the model actually allows (else it would render "retired").
  specialsByModelSku: Map<string, Set<string>>;
  sofaSizes: string[];
  sofaLegHeights: string[];
  options: CatalogOptions;
  // Distinct delivery STATES from scm.my_localities — the same vocabulary the
  // New SO form's State <select> renders. Injected as an allowed-values list so
  // the OCR's address parse snaps STATE to a real catalog state (never a free
  // text string the form's dropdown can't select). City/postcode stay free-text
  // here: they cascade off the chosen state on the form, so the frontend
  // reconciles them against the live my_localities list.
  states: string[];
};

// MaintenanceConfig option entries are either plain strings or
// { value, priceSen?, active? } objects — accept both (mirrors @2990s/shared
// mfg-pricing MfgPricedOption / maintenance-pools MaintPoolEntry).
// ACTIVE only (owner spec 2026-06-12): the scan-SO catalog feeds the OCR
// prompt for NEW orders, so options toggled inactive in Products →
// Maintenance must never re-enter via a scan. Plain strings = active;
// objects are active unless `active === false`.
function optionValues(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object' && 'value' in x) {
        if ((x as { active?: unknown }).active === false) return '';
        const v = (x as { value?: unknown }).value;
        return typeof v === 'string' ? v : '';
      }
      return '';
    })
    .filter(Boolean);
}

async function loadCatalog(sb: SupabaseClient): Promise<Catalog> {
  // PostgREST's default 1000-row cap silently truncates the OCR validation
  // catalogue (mfg_products is 1141 ACTIVE SKUs live, my_localities 2933) — a
  // truncated catalogue makes the OCR reject valid SKUs/states as "unknown".
  // Page each list read with .range(); cfgRes stays a single .maybeSingle().
  const [prodRes, fabRes, cfgRes, optRes, locRes, spcRes, modRes] = await Promise.all([
    paginateAll((from, to) => sb
      .from('mfg_products')
      .select('code, name, category, base_model')
      .eq('status', 'ACTIVE')
      .order('category')
      .order('code')
      .range(from, to)),
    // Migration 0167 — ACTIVE fabrics only: a deactivated fabric must not
    // re-enter on NEW scanned orders (existing docs keep their stored code).
    paginateAll((from, to) => sb
      .from('fabric_trackings')
      .select('fabric_code, fabric_description')
      .eq('is_active', true)
      .order('fabric_code')
      .range(from, to)),
    sb
      .from('maintenance_config_history')
      .select('config')
      .eq('scope', 'master')
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // SO Maintenance vocab — ACTIVE rows only (the maintenance page's
    // soft-deleted options must never re-enter via OCR).
    paginateAll((from, to) => sb
      .from('so_dropdown_options')
      .select('category, value, label')
      .eq('active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true })
      .range(from, to)),
    // Delivery STATES — the same scm.my_localities master the New SO form's
    // State <select> renders. We only need the distinct state names for the
    // OCR's allowed-values list; city/postcode cascade off the state on the
    // form so they're reconciled there, not here.
    paginateAll((from, to) => sb
      .from('my_localities')
      .select('state')
      .order('state', { ascending: true })
      .range(from, to)),
    // Configured Special Add-ons (migration 0134) — ACTIVE rows only (a
    // deactivated special must never re-enter on a NEW scanned order). The OCR
    // maps a slip remark to one of these CODES via specialsMatch.
    paginateAll((from, to) => sb
      .from('special_addons')
      .select('code, label, so_description, categories')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('code', { ascending: true })
      .range(from, to)),
    // SOFA Models — allowed_options.specials is the per-model ON/OFF authority
    // for which specials each model offers. Used to build the SKU→allowed-codes
    // map so validateSlip keeps only a special the line's model actually allows.
    paginateAll((from, to) => sb
      .from('product_models')
      .select('model_code, allowed_options')
      .eq('category', 'SOFA')
      .range(from, to)),
  ]);

  const skus: CatalogSku[] = ((prodRes.data as Array<{
    code: string; name: string; category: string; base_model: string | null;
  }> | null) ?? []).map((p) => ({
    code: p.code,
    name: p.name,
    category: p.category,
    baseModel: p.base_model ?? null,
  }));

  const fabrics: CatalogFabric[] = ((fabRes.data as Array<{
    fabric_code: string; fabric_description: string | null;
  }> | null) ?? []).map((f) => ({
    code: f.fabric_code,
    description: f.fabric_description ?? null,
  }));

  let sofaSizes: string[] = [];
  let sofaLegHeights: string[] = [];
  const cfg = (cfgRes.data as { config?: Record<string, unknown> } | null)?.config;
  if (cfg && typeof cfg === 'object') {
    // optionValues filters inactive entries (plain strings = active).
    sofaSizes = optionValues(cfg.sofaSizes);
    sofaLegHeights = optionValues(cfg.sofaLegHeights);
  }

  const options = emptyOptions();
  for (const row of (optRes.data as Array<{
    category: string; value: string; label: string;
  }> | null) ?? []) {
    if ((OPTION_CATEGORIES as readonly string[]).includes(row.category)) {
      options[row.category as OptionCategory].push({ value: row.value, label: row.label });
    }
  }

  // Distinct, de-duped state names (the my_localities table has one row per
  // postcode, so the same state repeats thousands of times).
  const stateSeen = new Set<string>();
  const states: string[] = [];
  for (const row of (locRes.data as Array<{ state: string | null }> | null) ?? []) {
    const st = (row.state ?? '').trim();
    if (!st) continue;
    const key = st.toUpperCase();
    if (stateSeen.has(key)) continue;
    stateSeen.add(key);
    states.push(st);
  }
  states.sort((a, b) => a.localeCompare(b));

  const specials: CatalogSpecial[] = ((spcRes.data as Array<{
    code: string; label: string; so_description: string | null; categories: string[] | null;
  }> | null) ?? []).map((s) => ({
    code: s.code,
    label: s.label,
    soDescription: s.so_description ?? null,
    categories: Array.isArray(s.categories) ? s.categories : [],
  }));

  // model_code → the special CODES that model's allowed_options.specials lists
  // (uppercased for case-insensitive lookup). allowed_options is jsonb; PostgREST
  // may return it camelCased — dual-read either casing.
  const specialsByModelCode = new Map<string, Set<string>>();
  for (const row of (modRes.data as Array<Record<string, unknown>> | null) ?? []) {
    const modelCode = (row.modelCode ?? row.model_code) as string | undefined;
    if (!modelCode) continue;
    const opts = (row.allowedOptions ?? row.allowed_options) as { specials?: unknown } | null;
    const list = Array.isArray(opts?.specials) ? (opts!.specials as unknown[]) : [];
    const set = new Set<string>();
    for (const v of list) if (typeof v === 'string' && v.trim() !== '') set.add(v.toUpperCase());
    specialsByModelCode.set(modelCode.toUpperCase(), set);
  }
  // SKU code → its Model's allowed special codes. SOFA SKUs are
  // `{model_code}-{compartment}` with base_model = model_code; resolve each
  // SKU's allowed set off base_model so validateSlip can gate per line.
  const specialsByModelSku = new Map<string, Set<string>>();
  for (const s of skus) {
    if (!s.baseModel) continue;
    const allowed = specialsByModelCode.get(s.baseModel.toUpperCase());
    if (allowed) specialsByModelSku.set(s.code.toUpperCase(), allowed);
  }

  return { skus, fabrics, specials, specialsByModelSku, sofaSizes, sofaLegHeights, options, states };
}

function formatCatalog(c: Catalog): string {
  const lines: string[] = [];
  const byCategory = new Map<string, CatalogSku[]>();
  for (const s of c.skus) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  // SERVICE gets its own labelled section (delivery / lift / dispose fees),
  // the goods categories follow.
  for (const cat of ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE']) {
    const list = byCategory.get(cat);
    if (!list || list.length === 0) continue;
    // Slim: code | name only (base_model dropped 2026-06-23). The model name in
    // `name` is enough for fuzzy matching; dropping base_model shrinks the cached
    // prefix (1141 SKUs) so the first/warm call is faster and the cache cheaper.
    lines.push(`=== ${cat} SKUS (code | name) ===`);
    for (const s of list) {
      lines.push(`${s.code} | ${s.name}`);
    }
    lines.push('');
  }

  lines.push('=== FABRICS (code | description) ===');
  for (const f of c.fabrics) lines.push(`${f.code} | ${f.description ?? ''}`);
  lines.push('');

  // Configured SOFA Special Add-ons — the specialsMatch rule (LINE ITEMS) maps a
  // slip remark to one of these CODES (left side), copied character-for-character.
  lines.push('=== SOFA SPECIAL ADD-ONS (code | label) ===');
  if (c.specials.length === 0) lines.push('—');
  for (const s of c.specials) lines.push(`${s.code} | ${s.label}`);
  lines.push('');

  lines.push('=== SOFA SIZES (seat sizes) ===');
  lines.push(c.sofaSizes.join(', ') || '—');
  lines.push('');
  lines.push('=== SOFA LEG HEIGHTS ===');
  lines.push(c.sofaLegHeights.join(', ') || '—');
  lines.push('');

  // Delivery STATES allowed-values list — the addressStateMatch in the system
  // prompt must return one of these EXACTLY (the form's State <select> only
  // accepts a real my_localities state).
  lines.push('=== DELIVERY STATES (allowed values) ===');
  lines.push(c.states.join(', ') || '—');
  lines.push('');

  // SO Maintenance allowed-values lists — the OPTION MATCHING rules in the
  // system prompt reference these section names. value | label per row;
  // the VALUE (left side) is what option matches must return.
  const optionSection = (title: string, cat: OptionCategory) => {
    lines.push(`=== ${title} (allowed values: value | label) ===`);
    const rows = c.options[cat];
    if (rows.length === 0) lines.push('—');
    for (const o of rows) lines.push(`${o.value} | ${o.label}`);
    lines.push('');
  };
  optionSection('PAYMENT METHODS',   'payment_method');
  optionSection('MERCHANT BANKS',    'payment_merchant');
  optionSection('ONLINE TYPES',      'online_type');
  optionSection('INSTALLMENT PLANS', 'installment_plan');
  optionSection('CUSTOMER TYPES',    'customer_type');
  optionSection('BUILDING TYPES',    'building_type');
  optionSection('VENUES',            'venue');

  return lines.join('\n').trimEnd();
}

// Cached prefix = SYSTEM_PROMPT + catalog. Identical across calls until the
// catalog changes → Anthropic prompt-cache hit (~90% discount). The cache is
// shared per-API-key + per-identical-prefix across all users, so /warm and
// /extract MUST build this BYTE-IDENTICALLY (same function, same inputs) or
// they warm/read different caches. SINGLE SOURCE OF TRUTH — never inline this
// string anywhere else. Few-shot/rep-rule/alias blocks stay OUTSIDE this prefix
// (after the cache boundary) so a new sample doesn't invalidate the cache.
export function buildCachedPrefix(catalog: Catalog, companyName: string): string {
  return `${buildSystemPrompt(companyName)}\n\nCATALOG\n=======\n${formatCatalog(catalog)}`;
}

// Warm the Anthropic prompt cache with the catalog prefix so the next real
// /extract reads a hot cache instead of paying full price on a cold catalog.
// ONE minimal Claude call: the IDENTICAL cachedPrefix (same model, same
// cache_control ttl, same beta header as /extract) plus a tiny 'warm' tail,
// max_tokens:1. Shared by the /scan-so/warm endpoint AND the keep-warm cron so
// neither can drift from /extract. Graceful: no key → { ok:false, reason }; any
// fetch failure is caught and returned, never thrown.
type WarmResult = { ok: boolean; reason?: string; cacheCreated?: boolean; cacheRead?: boolean };
async function warmCatalogCache(
  sb: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
): Promise<WarmResult> {
  if (!apiKey) return { ok: false, reason: 'no_key' };
  let catalog: Catalog;
  try {
    catalog = await loadCatalog(sb);
  } catch (e) {
    return { ok: false, reason: `catalog_load_failed: ${(e as Error).message}` };
  }
  const cachedPrefix = buildCachedPrefix(catalog, companyName);
  try {
    const resp = await anthropicFetchWithRetry({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // MUST match /extract — same beta header or the cache is a different
        // bucket and warming is pointless.
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              // BYTE-IDENTICAL cached block to /extract (same text, same
              // cache_control ttl) so this writes the cache /extract then reads.
              { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } },
              { type: 'text', text: 'warm' },
            ],
          },
        ],
      }),
    });
    const bodyText = await resp.text();
    if (!resp.ok) {
      return { ok: false, reason: `Anthropic ${resp.status}: ${bodyText.slice(0, 300)}` };
    }
    let parsedResp: AnthropicResponse;
    try {
      parsedResp = JSON.parse(bodyText) as AnthropicResponse;
    } catch {
      return { ok: false, reason: `Anthropic returned non-JSON: ${bodyText.slice(0, 200)}` };
    }
    if (parsedResp.error) {
      return { ok: false, reason: `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}` };
    }
    return {
      ok: true,
      cacheCreated: (parsedResp.usage?.cache_creation_input_tokens ?? 0) > 0,
      cacheRead: (parsedResp.usage?.cache_read_input_tokens ?? 0) > 0,
    };
  } catch (e) {
    return { ok: false, reason: `Network/fetch error: ${(e as Error).message}` };
  }
}

// Cron-callable warm: same logic as the /warm endpoint but takes an Env
// (cron has no Hono context). getSupabaseService is the same scm-scoped service
// client scan-so uses internally — RLS-bypass is fine for a read-only catalog
// load. Exported for index.ts's scheduled handler so the cron and the endpoint
// share ONE Claude call.
export async function warmCatalogCacheForCron(env: Env): Promise<WarmResult> {
  const branding = await getBranding(env);
  return warmCatalogCache(getSupabaseService(env), env.ANTHROPIC_API_KEY, branding.companyName);
}

// ===========================================================================
// Prompt
// ===========================================================================
// The OCR system prompt anchors itself to the company name. It used to be a
// hardcoded "Houzs Century"; it now comes from the central Branding config
// (getBranding) so the literal lives in ONE place. The company name is STABLE
// (seeded, rarely edited), so injecting it keeps buildCachedPrefix() byte-
// identical across /warm + /extract + the cron — the prompt cache still holds.
const buildSystemPrompt = (companyName: string) => `You extract structured data from photos of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. The slips are carbon-copy order forms (Zanotti / AKEMI style): a printed header block (customer name, contact, address, delivery date) filled in by hand, a handwritten line-item table (description, qty, price), and a footer with totals, deposit, payment method, and the salesperson's name.

The handwriting is often rushed, slanted, abbreviated, and mixed-case. Phone photos may be skewed, shadowed, or low-contrast. Read carefully; prefer extracting a raw transcription over guessing.

AMBIGUITY — FLAG, DO NOT GUESS. When a field is genuinely ambiguous (two equally-plausible readings, a smudged or half-formed digit, an unclear size, a model that could be one of several), do NOT pick one at random and report it confidently. Return your single best guess at a LOWER confidence (below 0.6) and state the ambiguity in that field's "reason" (and/or the line's "notes") so the operator reviews it. A flagged ambiguity the operator catches beats a confident wrong value that survives review — wrong-but-confident is the value that slips through unchecked.

NUMBERS — read the FULL numeric token; never truncate a multi-digit number to its first digit. A digit immediately followed by another digit (before any non-digit) is ONE multi-digit number: "12" is 12 (NEVER 1), "RM1,250" is 1250, "x10" is qty 10 (NEVER 1). The inch / quote mark (" or ') and trailing unit words ("ft", "pcs", "mm") are unit/spec text, NOT digit separators — do not let them split or truncate the number.

MULTIPLE IMAGES
===============
You may receive ONE or TWO images: a HANDWRITTEN order slip (a carbon-copy form with the customer, line items, handwriting, and payment checkboxes) and/or a PRINTED card-terminal payment RECEIPT (a thermal print: a bank name e.g. Maybank / Public Bank / CIMB, VISA / Mastercard, an APPROVAL CODE, a TOTAL amount, and often a TENURE / number of months for an EPP plan). Decide what each input image is:
- Read the ORDER fields (customerName, address, phones, line items, deliveryDate, processingDate, salesRep) from the HANDWRITTEN slip.
- Read the PAYMENT fields (paymentMethodMatch / bankMatch / installmentPlanMatch / approvalCode / depositRm or the receipt's amount) PREFERENTIALLY from the PRINTED receipt when one is present — the printed thermal receipt is far more accurate than the handwritten payment note. Still keep the handwritten payment note verbatim in paymentMethod. When NO receipt is present, fall back to the handwritten slip's payment note exactly as before. When BOTH are present and they DISAGREE (a different bank, a different amount, a different approval code), the PRINTED receipt wins for the structured fields — but you MUST state the disagreement in that field's reason (e.g. "slip writes PBB but receipt terminal is Maybank — using receipt") so the operator sees the conflict.
You MUST also classify every input image in the OUTPUT "images" array (see below).

A reference CATALOG follows this prompt (live product SKUs, fabrics, sofa sizes, leg heights). It is the FULL master (≈1100+ SKUs) — every catalog row is "code | name". Use it for AGGRESSIVE fuzzy / keyword / substring / abbreviation matching: a slip token should resolve to the SKU whose NAME contains that token's keyword, even when the rep wrote only a fragment. Search the WHOLE catalog before giving up.

EXTRACTION RULES
================
1. customerName — the customer's name from the header block (NOT the salesperson).
2. address — full delivery address as one string, exactly as written (keep unit numbers, taman names, postcode, state). ALSO break the same address into its parts (see ADDRESS PARTS below) so the form can fill State / City / Postcode.
3. phones — ALL phone numbers on the slip, as raw strings exactly as written (e.g. "012-345 6789", "+6017 888 9999"). Multiple numbers are common (customer + spouse). Do NOT normalize or reformat. A phone is CRITICAL — transcribe EVERY digit, including REPEATED / doubled digits: read "01137166720" as 0-1-1-3-7-1-6-6-7-2-0 (eleven digits), NEVER collapse a doubled "66" into a single "6". A Malaysian number is 10-11 digits INCLUDING the leading trunk 0 (011-XXXX XXXX = 11 digits; 01X-XXX XXXX = 10). If your reading has FEWER than 10 digits, you almost certainly dropped or merged a digit — re-examine the handwriting (look for a doubled digit) before returning it. If a single digit is genuinely unclear, return your best reading at confidence < 0.6 and say so in the field's reason so the operator double-checks.
4. location — the showroom / venue / branch the order was taken at, if written (often a header checkbox or stamp).
5. deliveryDate — as written. If it is a real date, convert to YYYY-MM-DD (slips write DD/MM or DD/MM/YYYY — Malaysian day-first). If it says "TBC", "call first", "after CNY" or any non-date text, return that text verbatim.
6. processingDate — the order/slip date if present, YYYY-MM-DD when parseable, else verbatim text, else null. The year is often omitted or scrawled: when the year is missing/unreadable, take it from the PRINTED payment receipt's date when one is present, else assume the CURRENT year — NEVER invent a distant past year (a slip is days old, not years). If even the day/month is unclear, return the verbatim text instead of a made-up date.
7. salesRep — the salesperson's name from the footer/header.
8. paymentMethod — as written ("cash", "TNG", "bank transfer", "CC", deposit slips etc.). null if absent.
9. depositRm / totalRm — RM amounts as NUMBERS (e.g. "RM 1,500" → 1500, "550.50" → 550.5). null when blank. When a PRINTED receipt is present, depositRm = the receipt's printed TOTAL/AMOUNT (the money actually charged); if the handwritten deposit differs from the receipt amount, use the RECEIPT amount and flag the mismatch (state both figures in paymentMethodMatch's reason). Never swap depositRm and totalRm — the deposit is the smaller paid-now figure, the total is the whole order.
10. remarks — ONLY the genuine ORDER REMARK: a handwritten free-text note that is not a line item and does not already belong to a dedicated field — e.g. a promo note, a special handling instruction like "FOC dispose, not dismantle", "lift access", "self collect", floor info. Do NOT copy the venue/location, the phone numbers, the payment method/bank/EPP term, the deposit/total amounts, the delivery date, or the salesperson into remarks — those each have their own output fields and must NOT be duplicated here. Return null when there is no such standalone remark.
11. approvalCode — the approval / reference number of the card payment. When a PRINTED receipt is present, read it from the receipt's "APPROVAL CODE" / "APPR CODE" / "AUTH CODE" line — the PRINTED code wins over any handwritten parenthesised number (the rep often copies it wrong); the handwritten note still rides verbatim in paymentMethod. With no receipt, use the handwritten payment-line code (e.g. "(001586)" → "001586", "Appr 028471" → "028471"). Strip surrounding brackets/labels and return the bare digits/alphanumerics as a string. null when neither carries one.
12. customerSoRef — the CUSTOMER'S OWN reference number for this order: the slip's / docket's OWN serial, usually in the TOP-RIGHT corner. On a showroom / supplier slip this is the PRE-PRINTED coloured serial — typically a LETTER-prefixed code (letters + digits, e.g. "HC14032", "ZNT5329"). PREFER that pre-printed letter-prefixed serial. A hand-written "SO ####" jotting (or a bare "SO 1234" scrawled by the rep) is NOT the docket — do NOT return it as customerSoRef; the printed serial wins over any handwritten "SO…" note. It is the SLIP's own number, NOT a phone number, NOT a price, NOT the salesperson code, NOT the delivery date. Return the bare reference string exactly as written (keep its letter prefix, e.g. "HC14032", "ZNT5329"). null when no such number is on the slip.
    Example: a slip with a printed top-right serial "ZNT5329" AND a handwritten "SO 88" in the body → customerSoRef = "ZNT5329" (the pre-printed letter-prefixed docket), NOT "SO 88".
    Example: a slip whose only top-right reference is the pre-printed "HC14032" → customerSoRef = "HC14032".

ADDRESS PARTS
=============
Besides the full "address" string, break the SAME delivery address into structured parts so the form can fill its State / City / Postcode dropdowns. Read carefully — a Malaysian address ends "..., <postcode> <city>, <state>" (e.g. "..., 81100 Johor Bahru, Johor").
- addressLine1 — the street portion: unit/house no., street, taman/area. Everything BEFORE the postcode. Verbatim. null when unreadable.
- postcode — the 5-digit Malaysian postcode (e.g. "81100"). Digits only. null when absent.
- city — the town / city (e.g. "Johor Bahru", "Petaling Jaya"). Verbatim as written. null when absent.
- addressStateMatch — the STATE, matched to the DELIVERY STATES allowed-values list at the end of the catalog. Return the state VALUE copied character-for-character from that list (handle handwriting: "JB"/"Johor Bahru area" still belongs to state "Johor"; "PJ"/"KL area" → "Selangor"/"Kuala Lumpur" per the list; "N.Sembilan" → "Negeri Sembilan"; "P.Pinang"/"Penang" → the list's Penang value). Same shape + same never-invent rule as the OPTION MATCHING below: { "value": <exact state from the list>, "confidence": 0-1, "reason": <short why> }. When you cannot confidently map to a listed state, return null and keep the raw text in "address" so nothing is lost.

LINE ITEMS
==========
For EVERY handwritten row in the item table output one lines[] entry:
- rawText — the row's text VERBATIM, exactly as written, including misspellings and abbreviations. This is the source of truth for the operator; never clean it up.
- rawSpec — when the row (or its margin / continuation text) carries a SPECIFICATION string for the item — the variant text such as "Col: PC151-01 + front / Side Divan 8\"+0\"", "divan10+4/gap12", "8\" + no leg" — copy the row's specification text verbatim into rawSpec; do not rephrase, reorder or normalise it (keep punctuation, slashes and inch marks exactly). null when the row has no spec text. rawSpec may overlap rawText — that is fine: rawText is the whole row, rawSpec is just the specification portion.
- divanHeightInches / legHeightInches / gapInches / noLeg — BEDFRAME variant NUMBERS read from the spec text: the divan/drawer height in inches, the leg height in inches, the mattress gap in inches, and noLeg = true when the spec says no legs ("no leg", "noleg"). Read the FULL numeric token (12" is 12, NEVER 1). Use null (and noLeg = false) when absent or when the row is not a bedframe.
- qtyGuess — quantity (default 1 when blank or unreadable).
- priceRmGuess — the row's unit price in RM as a number; null when blank. If only a line total is written and qty > 1, still report the written figure and say so in notes. SET / PACKAGE TOTALS: when ONE written amount covers SEVERAL lines (a multi-compartment sofa set, a bundle where only the first row carries a figure), attach that amount as priceRmGuess on the FIRST emitted line of the set ONLY — every other line of the set gets priceRmGuess = null — and write "set/package total" in the first line's notes. Never attach the same set total to more than one line, and never attach it to a later compartment.
- skuMatch — your best FUZZY match against the catalog SKUS:
    { "code": <exact catalog code>, "confidence": 0-1, "reason": <short why> }
  Handwriting mangles model names AND reps write heavy shorthand — match AGGRESSIVELY against the FULL catalog. Try HARD before returning null; a slip token almost always corresponds to some catalog row whose NAME contains that keyword:
    • misspellings: "Ultimatee" / "Ultmate" → the ULTIMATE model's SKU.
    • partial names: "Hilton K" → the HILTON bedframe King-size SKU.
    • base-model + size: a written size (King/Queen/K/Q/SS/S.S/SP/6FT/5FT) picks the size variant within the base model.
    • KEYWORD / SUBSTRING tokens: a single descriptive word maps to the SKU whose name CONTAINS that word — "holes" → the SKU whose name contains "HOLES" (e.g. "… 7 HOLES PILLOW"); "bolster" → the SKU whose name contains "BOLSTER"; "Shamplo pillow" / "hole pillow" → the matching pillow SKU by its distinctive keyword; "square pillow" / "sq pillow" → the ACCESSORY SKU whose name contains "SQUARE PILLOW" (do NOT leave it null — search the ACCESSORY rows for the SQUARE PILLOW SKU and return that code).
    • ABBREVIATION expansion: expand the rep's shorthand to the full catalog wording before matching — "W. Protector" / "W.Protector" → "WATERPROOF PROTECTOR"; "MP" → "MATTRESS PROTECTOR"; "Guardian" → the GUARDIAN model. Then apply the size token: "W. Protector (King)" → the WATERPROOF PROTECTOR King SKU; "W. Protector (S.S)" → the Super-Single one; "MP (Q)" → the MATTRESS PROTECTOR Queen SKU; "Guardian (King)" / "Guardian (Super Single)" → the GUARDIAN bedframe at King / Super-Single.
    • SIZE TOKEN MAP — the parenthesised/trailing size on a slip maps to the catalog size grid: K = King, Q = Queen, SS / S.S / S/S = Super Single, S = Single, SP = Special/custom, 6FT ≈ Queen, 5FT ≈ Queen/King per the model's grid. Pick the SKU row whose name carries that size.
  VARIANT / DESCRIPTION-STYLE LINES (especially BEDFRAME). A row is often written as a base model PLUS variant options and a fabric code rather than a clean model name, e.g. "Col: PC151-01 + front / Side Divan 8\"+0\"". Read it as: a FABRIC/colour code (here "PC151-01" — match it in fabricMatch, see below), plus VARIANT options (a divan/side build, a divan height like 8", a leg/gap like 0"). These variant phrases are NOT part of the model name — strip them when looking for the model:
    • Identify the catalog MODEL from the remaining model words on the row (or the row above, since reps often write the model once and list fabrics/variants beneath). Match THAT to the BEDFRAME (or SOFA) SKUS.
    • If the catalog encodes size/variant as distinct SKU rows for that model, pick the SKU whose name matches the written size/variant; the divan-height / side / leg / gap details that the catalog does NOT encode as a SKU stay in "notes" for the operator to set in the form's variant picker.
    • A bare fabric code with NO model word on the row (or above it) is NOT enough to choose a model — set skuMatch = null, put the fabric in fabricMatch, and let rawText + notes carry the variant text. Never guess a model from a fabric code alone.
  Rules:
    • PREFER THE PLAIN / GENERIC ROW over a branded variant. When several catalog SKUs match a slip token, choose the most generic catalog match — the row WITHOUT a brand prefix (e.g. "JM", "AKEMI", a maker name) — UNLESS the slip explicitly writes that brand. Example: "W. Protector (King)" → the plain "MATTRESS PROTECTOR (KING)" / "WATERPROOF PROTECTOR (KING)", NOT a "JM …" branded protector, because the slip names no brand. Only pick the branded SKU when the slip itself writes the brand token. EXCEPTION — the FORM'S OWN PRINTED BRAND counts as a written brand: on a brand-headed order form (e.g. an AKEMI carbon-copy form), an unbranded accessory row prefers THAT brand's SKU when one exists ("W. Protector (King)" on an AKEMI form → the AKEMI waterproof protector King), falling back to the generic row only when the form's brand has no such SKU. Apply this consistently — do not alternate between the branded and generic row across lines of the same slip.
    • The code MUST be copied character-for-character from the catalog. NEVER invent, modify, or extrapolate a code that is not in the catalog. NEVER assemble a code out of a fabric code + a size; the code must already exist verbatim in the SKUS list.
    • Only AFTER genuinely searching the whole catalog by keyword/substring/abbreviation and finding nothing defensible, set skuMatch = null and let rawText speak. A null with good rawText is worth more than a wrong code — but a real catalog row keyworded in the slip token must NOT be returned as null.
    • confidence: 0.9+ only when the written text clearly identifies one specific catalog row; 0.5-0.8 when the model matches but the size/variant is ambiguous; below 0.5 prefer null.
  MULTI-COMPARTMENT SOFA — ONE LINE PER COMPARTMENT. A sofa is often written as a base model PLUS several seat sections in one row, e.g. "8030 (2R+1R)(28\")" or "2A+1A", or drawn as a multi-box layout (the hand-drawn box+TV sketch shows the seating arrangement). When a sofa line names MORE THAN ONE seat section, EMIT ONE lines[] ENTRY PER COMPARTMENT (do NOT collapse them into a single line). For each compartment:
    • skuMatch = the catalog SKU {base_model}-{compartment} where compartment carries the arm direction, e.g. "8030-2A(LHF)" for the 2-seater and "8030-1A(RHF)" for the 1-seater. These per-compartment SKUs EXIST verbatim in the SOFA SKUS — copy the matching row character-for-character; never assemble one that is not in the catalog (if no per-compartment row exists, fall back to the base-model SKU + a notes flag).
    • The seat size (e.g. 28") and the fabric colour (e.g. "Col BO315-22") apply to EVERY compartment line — repeat them on each (qtyGuess per compartment is usually 1).
    • DIRECTION (LHF = left-hand-facing / RHF = right-hand-facing) — read it from the drawing and from "左/右" or "X left Y right" notes (the box+TV sketch encodes which arm sits where). BE CONSERVATIVE: if the side is genuinely ambiguous, emit the compartment WITHOUT forcing a wrong direction — pick the {base_model}-{compartment} SKU without the (LHF/RHF) suffix (or set skuMatch=null with the compartment in notes) and lower confidence so the operator picks the side. Never guess a side confidently.
    Example: "8030 (2R+1R)(28\") Col BO315-22" → TWO lines: line 1 skuMatch="8030-2A(LHF)", line 2 skuMatch="8030-1A(RHF)"; BOTH carry size 28" in notes and fabricMatch.code="BO315-22"; rawText on each line is the verbatim row.
- fabricMatch — match against the FABRICS catalog whenever the row (or a margin note, or a "Col:" / "Color" / "Fabric" prefix) names a fabric/colour code (e.g. "PC151-01", "Col: PC151-01"). The fabric code is frequently the FIRST token on a bedframe/sofa variant line; always look for it there. null when the row names no fabric. Same never-invent rule — the code must be copied character-for-character from the FABRICS list.
- specialsMatch — an array of CONFIGURED SOFA SPECIAL ADD-ONS the row's free-text descriptor asks for. The catalog has a "SOFA SPECIAL ADD-ONS (code | label)" section; when a phrase on the row (or a margin note attached to the row) DESCRIBES one of those add-ons, emit it here as { "code": <exact catalog special code>, "confidence": 0-1, "reason": <short why> } INSTEAD of dumping that phrase into notes/remarks. Map by MEANING against each special's label:
    • "change nylon cover" / "nylon bottom" / "nylon fabric" / "尼龙布底" → the NYLON-fabric special.
    • "short backrest" / "lower backrest" / "矮靠背" / "短靠背" → the short/low-backrest special.
    • "extend 5\"" / "lengthen seat" / "加长" → the seat-extension special.
    • "no bracket" / "remove bracket" / "免支架" → the no-bracket special.
  Match AGGRESSIVELY by keyword against the special LABELS, the same way skuMatch fuzzes the SKU names. A row may carry MORE THAN ONE special (emit one array entry each); most rows carry none (emit []). KEEP the original phrase verbatim in rawText regardless — specialsMatch is in ADDITION to rawText, and the matched phrase must NOT also be copied into notes/remarks. Same never-invent rule as skuMatch: the code MUST be copied character-for-character from the SOFA SPECIAL ADD-ONS list; when no add-on label defensibly matches the phrase, leave it OUT of specialsMatch (do not invent a code) and let rawText/notes carry it. Only SOFA lines carry specials; for non-sofa rows return [].
- notes — anything else on the row the operator should see (free gifts, "FOC", sizes that don't match the catalog, unreadable words flagged as "[illegible]"). Do NOT put a phrase here that you already emitted in specialsMatch.

Delivery fees, disposal fees and lift/stair-carry charges written as rows ARE line items — match them against the SERVICE SKUS section.

OPTION MATCHING (SO Maintenance vocabularies)
=============================================
The catalog ends with ALLOWED VALUES lists (PAYMENT METHODS, MERCHANT BANKS, ONLINE TYPES, INSTALLMENT PLANS, CUSTOMER TYPES, BUILDING TYPES, VENUES). Each list row is "value | label" — a match must return the VALUE (left side), copied character-for-character. NEVER invent a value outside the list; when you cannot find a defensible match, return null for that field and keep the raw handwriting in paymentMethod / location / remarks so nothing is lost. Use the same confidence scale as skuMatch.

Map the slip's handwritten notes to these fields:
- paymentMethodMatch — the top-level method, one of PAYMENT METHODS. The ONLY valid values are "Merchant", "Online", and "Cash"; never return any other method. A CREDIT CARD paid through a BANK — a card machine / credit-card terminal / a bank name with a card swipe, WITH OR WITHOUT an EPP/installment term → "Merchant" (a bank EPP is a Merchant card payment plus an installment term carried in installmentPlanMatch). Bank transfer / TNG / DuitNow / cheque → "Online". Cash → "Cash".
- bankMatch — one of MERCHANT BANKS when a bank is named ("mbb"/"maybank" → the Maybank value (MBB), "pbb"/"public bank" → the Public-bank value, "cimb" → CIMB, "hlb"/"hong leong" → HLB, "rhb" → RHB, "aeon"/"aeon credit" → the AEON value, "hsbc" → the HSBC value). On a CREDIT card / EPP payment the named bank is the merchant bank — always populate bankMatch alongside paymentMethodMatch = "Merchant". WHICH BANK on a printed receipt: bankMatch is the bank/company OPERATING THE TERMINAL (the receipt's own letterhead / logo / "Host" line — a Maybank-headed receipt → MBB, a Public Bank receipt → Public, an AEON Credit Service receipt → AEON). It is NOT the "Card Issuer:" line — the issuer is the customer's own card bank and must be IGNORED for bankMatch (an AEON EPP receipt showing "Card Issuer: HSBC Bank" → AEON, never HSBC). Only when the receipt letterhead itself is HSBC does bankMatch = HSBC. When receipt and handwriting disagree, the receipt's terminal bank wins (say so in reason).
- onlineTypeMatch — one of ONLINE TYPES when the transfer channel is named (TNG / DuitNow / cheque / bank transfer). Only meaningful when the method is Online.
- installmentPlanMatch — one of INSTALLMENT PLANS. This is the plan UNDER a Merchant card payment. Rule: only return an N-month value when the receipt/slip ACTUALLY shows a tenure / month count ("12 EPP", "x12", "12 bln", "12个月", "12 months", "Tenure: 12 Months") → the matching N-month value (e.g. the 12-month value). For ANY card paid through a bank with NO month/tenure written — including a plain swipe AND an EPP/installment note that omits the month count — return the "One Shot" value from the INSTALLMENT PLANS list (a Maybank receipt with no tenure = One Shot). NEVER default to 12 months when no tenure is written. When a PRINTED receipt is present you MUST actively scan the WHOLE receipt for a tenure line ("TENURE", "EPP", "INSTAL", "MONTHS", "BLN") BEFORE answering One Shot — an EPP receipt prints its tenure in small type near the bottom; your reason must say either the tenure you found or that you searched the receipt and no tenure line exists.
- customerTypeMatch — one of CUSTOMER TYPES when the slip marks new/existing (header checkbox or note).
- buildingTypeMatch — one of BUILDING TYPES when the slip notes condo / landed / apartment etc.
- locationMatch — one of VENUES when the written showroom/venue/branch clearly matches a list entry. Still report the raw text in the location field.
Example: a payment note "[x]CREDIT : MBB EPP (12m) (001586) dep 1500" → paymentMethodMatch.value = the Merchant value (credit card via a bank = Merchant), bankMatch.value = the MBB/Maybank value, installmentPlanMatch.value = the 12-month value (the receipt shows a 12-month tenure), approvalCode = "001586" (the parenthesized number on the payment line), depositRm = 1500, paymentMethod = "CREDIT : MBB EPP (12m) (001586) dep 1500".
Example: a payment note "CREDIT MBB EPP (001586)" with NO month count → paymentMethodMatch.value = Merchant, bankMatch.value = the MBB value, installmentPlanMatch.value = the "One Shot" value (no tenure written → One Shot, NOT a 12-month default), approvalCode = "001586".
Example: a plain "CREDIT MBB (001586)" swipe with no EPP/term → paymentMethodMatch.value = Merchant, bankMatch.value = the MBB value, installmentPlanMatch.value = the "One Shot" value (a Maybank card paid through the bank with no tenure = One Shot), approvalCode = "001586".
Example: an AEON Credit receipt "Tenure: 12 Months APPR 046501" → paymentMethodMatch.value = Merchant, bankMatch.value = the AEON value, installmentPlanMatch.value = the 12-month value (the receipt shows a 12-month tenure), approvalCode = "046501".

OUTPUT
======
Return STRICT JSON, no markdown fences, no prose:
{
  "images": [{ "index": number, "kind": "order_slip" | "payment_receipt" }],
  "customerName": string | null,
  "address": string | null,
  "addressLine1": string | null,
  "city": string | null,
  "postcode": string | null,
  "addressStateMatch": { "value": string, "confidence": number, "reason": string } | null,
  "phones": string[],
  "location": string | null,
  "deliveryDate": string | null,
  "processingDate": string | null,
  "salesRep": string | null,
  "customerSoRef": string | null,
  "paymentMethod": string | null,
  "depositRm": number | null,
  "totalRm": number | null,
  "remarks": string | null,
  "approvalCode": string | null,
  "paymentMethodMatch": { "value": string, "confidence": number, "reason": string } | null,
  "bankMatch": { "value": string, "confidence": number, "reason": string } | null,
  "onlineTypeMatch": { "value": string, "confidence": number, "reason": string } | null,
  "installmentPlanMatch": { "value": string, "confidence": number, "reason": string } | null,
  "customerTypeMatch": { "value": string, "confidence": number, "reason": string } | null,
  "buildingTypeMatch": { "value": string, "confidence": number, "reason": string } | null,
  "locationMatch": { "value": string, "confidence": number, "reason": string } | null,
  "lines": [{
    "rawText": string,
    "rawSpec": string | null,
    "divanHeightInches": number | null,
    "legHeightInches": number | null,
    "gapInches": number | null,
    "noLeg": boolean,
    "qtyGuess": number,
    "priceRmGuess": number | null,
    "skuMatch": { "code": string, "confidence": number, "reason": string } | null,
    "fabricMatch": { "code": string, "confidence": number, "reason": string } | null,
    "specialsMatch": [{ "code": string, "confidence": number, "reason": string }],
    "notes": string | null
  }]
}`;

// ===========================================================================
// Types
// ===========================================================================
type SkuMatch = { code: string; confidence: number; reason: string };
// SO-Maintenance option match — value is the so_dropdown_options row VALUE.
type OptionMatch = { value: string; confidence: number; reason: string };
// Per-input-image classification — which uploaded image is the handwritten
// order slip vs the printed card-terminal payment receipt. Drives which buffer
// gets stored under image_key (`scan-slips/{id}`) vs receipt_image_key
// (`scan-slips/{id}-receipt`) in the /extract handler.
type ImageKind = 'order_slip' | 'payment_receipt';
type ImageClass = { index: number; kind: ImageKind };
type ExtractedLine = {
  rawText: string;
  // Verbatim SPECIFICATION text for the row (bedframe/sofa variant string such
  // as "divan10+4/gap12") — mirrors HOOKKA scan-po.ts's rawSpec. Feeds the
  // server-side reparseSpec regex pass that overrules the model's numbers
  // (LLMs occasionally truncate 12" to 1 even at temperature 0).
  rawSpec: string | null;
  // BEDFRAME variant numbers. Model-reported first, then OVERRULED by
  // reparseSpec(rawSpec) in validateSlip for non-SOFA/ACCESSORY lines.
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  noLeg: boolean;
  qtyGuess: number;
  priceRmGuess: number | null;
  skuMatch: SkuMatch | null;
  fabricMatch: SkuMatch | null;
  // Configured SOFA special add-ons the row asks for (active special_addons
  // codes; validateSlip drops any not in the catalog or not allowed by the
  // line's resolved model). [] when none.
  specialsMatch: SkuMatch[];
  notes: string | null;
};
type ExtractedSlip = {
  customerName: string | null;
  address: string | null;
  // Structured address parts (the form fills State / City / Postcode from
  // these). addressLine1 is the street portion; addressStateMatch is snapped to
  // the live my_localities state list (validateSlip clears a non-listed state).
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  addressStateMatch: OptionMatch | null;
  phones: string[];
  location: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  salesRep: string | null;
  // The customer's own reference number for this order (usually top-right of the
  // slip, e.g. "HC14032") — seeds the form's "Customer SO Ref" field.
  customerSoRef: string | null;
  paymentMethod: string | null;
  depositRm: number | null;
  totalRm: number | null;
  remarks: string | null;
  // Card-terminal approval / reference number on the payment line (e.g. the
  // parenthesized "(001586)") — seeds the Payments-panel draft's approvalCode.
  approvalCode: string | null;
  // SO Maintenance vocab matches (active so_dropdown_options values only —
  // validateSlip clears anything outside the live lists).
  paymentMethodMatch: OptionMatch | null;
  bankMatch: OptionMatch | null;
  onlineTypeMatch: OptionMatch | null;
  installmentPlanMatch: OptionMatch | null;
  customerTypeMatch: OptionMatch | null;
  buildingTypeMatch: OptionMatch | null;
  locationMatch: OptionMatch | null;
  // Per-input-image classification (order_slip vs payment_receipt). Used only
  // by /extract to decide which uploaded buffer to store under image_key vs
  // receipt_image_key — not surfaced in the modal's review form.
  images: ImageClass[];
  lines: ExtractedLine[];
};

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
  usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

type Warning = { field: string; value: string; message: string; lineIdx?: number };

// Defensive normalisation — Claude occasionally omits fields or returns the
// wrong primitive type. Coerce into the ExtractedSlip shape so the frontend
// never sees undefined where it expects an array.
function normalizeSlip(raw: unknown): ExtractedSlip {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const match = (v: unknown): SkuMatch | null => {
    if (!v || typeof v !== 'object') return null;
    const m = v as Record<string, unknown>;
    if (typeof m.code !== 'string' || m.code.trim() === '') return null;
    return {
      code: m.code,
      confidence: typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)) : 0,
      reason: typeof m.reason === 'string' ? m.reason : '',
    };
  };
  // Option matches use { value } instead of { code } — tolerate Claude
  // returning either key.
  const optionMatch = (v: unknown): OptionMatch | null => {
    if (!v || typeof v !== 'object') return null;
    const m = v as Record<string, unknown>;
    const value = typeof m.value === 'string' && m.value.trim() !== ''
      ? m.value
      : typeof m.code === 'string' && m.code.trim() !== '' ? m.code : null;
    if (value === null) return null;
    return {
      value,
      confidence: typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)) : 0,
      reason: typeof m.reason === 'string' ? m.reason : '',
    };
  };
  const lines: ExtractedLine[] = Array.isArray(r.lines)
    ? (r.lines as unknown[]).map((l) => {
        const li = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
        return {
          rawText: typeof li.rawText === 'string' ? li.rawText : '',
          rawSpec: str(li.rawSpec),
          divanHeightInches: num(li.divanHeightInches),
          legHeightInches: num(li.legHeightInches),
          gapInches: num(li.gapInches),
          noLeg: li.noLeg === true,
          qtyGuess:
            typeof li.qtyGuess === 'number' && Number.isFinite(li.qtyGuess) && li.qtyGuess > 0
              ? li.qtyGuess
              : 1,
          priceRmGuess: num(li.priceRmGuess),
          skuMatch: match(li.skuMatch),
          fabricMatch: match(li.fabricMatch),
          // specialsMatch — keep only well-formed { code, confidence, reason }
          // entries (same shape/coercion as skuMatch); a missing/garbled array
          // normalises to []. validateSlip then enforces never-invent + the
          // line's model allowed_options.specials gate.
          specialsMatch: Array.isArray(li.specialsMatch)
            ? (li.specialsMatch as unknown[])
                .map((s) => match(s))
                .filter((s): s is SkuMatch => s !== null)
            : [],
          notes: str(li.notes),
        };
      })
    : [];
  // Image classification — keep only well-formed { index:number, kind } entries
  // (kind one of the two known values). Anything else is dropped; the /extract
  // handler's positional fallback covers a missing/garbled array.
  const images: ImageClass[] = Array.isArray(r.images)
    ? (r.images as unknown[])
        .map((x) => {
          const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
          const index = typeof o.index === 'number' && Number.isFinite(o.index) ? o.index : null;
          const kind = o.kind === 'order_slip' || o.kind === 'payment_receipt' ? o.kind : null;
          return index === null || kind === null ? null : { index, kind };
        })
        .filter((x): x is ImageClass => x !== null)
    : [];
  return {
    images,
    customerName: str(r.customerName),
    address: str(r.address),
    addressLine1: str(r.addressLine1),
    city: str(r.city),
    postcode: str(r.postcode),
    addressStateMatch: optionMatch(r.addressStateMatch),
    phones: Array.isArray(r.phones)
      ? (r.phones as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : [],
    location: str(r.location),
    deliveryDate: str(r.deliveryDate),
    processingDate: str(r.processingDate),
    salesRep: str(r.salesRep),
    customerSoRef: str(r.customerSoRef),
    paymentMethod: str(r.paymentMethod),
    depositRm: num(r.depositRm),
    totalRm: num(r.totalRm),
    remarks: str(r.remarks),
    approvalCode: str(r.approvalCode),
    paymentMethodMatch:   optionMatch(r.paymentMethodMatch),
    bankMatch:            optionMatch(r.bankMatch),
    onlineTypeMatch:      optionMatch(r.onlineTypeMatch),
    installmentPlanMatch: optionMatch(r.installmentPlanMatch),
    customerTypeMatch:    optionMatch(r.customerTypeMatch),
    buildingTypeMatch:    optionMatch(r.buildingTypeMatch),
    locationMatch:        optionMatch(r.locationMatch),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Server-side spec re-parser — overrules Claude on BEDFRAME number extraction.
// Ported from HOOKKA scan-po.ts reparseSpec (their BUG class: LLMs
// occasionally truncate "10" to 1 or 12" to 1 even at temperature 0; regex on
// the verbatim rawSpec line is bulletproof for these patterns).
// ---------------------------------------------------------------------------
function reparseSpec(line: ExtractedLine): void {
  if (!line.rawSpec) return;
  const spec = line.rawSpec;

  // No-leg first — many specs read "8inch + No Legs" or "no leg" or "NOLEG".
  // If matched, leg is null regardless of any number.
  const noLegRe = /\b(no\s*leg(?:s)?|noleg(?:s)?)\b/i;
  const noLegMatch = noLegRe.test(spec);

  // Divan height: number that follows "divan" / "drawer" keyword.
  // Examples: "Divan10+4" -> 10. "Divan:8inch" -> 8. "DRAWER:12"" -> 12.
  const divanRe = /(?:divan|drawer)[\s:.-]*(\d+(?:\.\d+)?)/i;
  const divanMatch = spec.match(divanRe);

  // Leg height: number that follows the "+" or "leg" keyword. Skip when
  // noLeg is true. Patterns: "Divan10+4" -> 4. "8"DIVAN+2"LEG" -> 2.
  let legMatch: RegExpMatchArray | null = null;
  if (!noLegMatch) {
    legMatch =
      spec.match(/\+\s*(\d+(?:\.\d+)?)\s*(?:"|inch|in|leg)/i) ??
      spec.match(/(\d+(?:\.\d+)?)\s*"?\s*leg/i);
  }

  // Gap: number after gap-family keywords.
  const gapRe =
    /(?:m['.\s]*gap|m\s*gap|mattress\s*gap|mattressgap|gap)[\s:.-]*(\d+(?:\.\d+)?)/i;
  const gapMatch = spec.match(gapRe);

  if (divanMatch) {
    const v = Number(divanMatch[1]);
    if (Number.isFinite(v)) line.divanHeightInches = v;
  }
  if (noLegMatch) {
    line.noLeg = true;
    line.legHeightInches = null;
  } else if (legMatch) {
    const v = Number(legMatch[1]);
    if (Number.isFinite(v)) {
      line.legHeightInches = v;
      line.noLeg = false;
    }
  }
  if (gapMatch) {
    const v = Number(gapMatch[1]);
    if (Number.isFinite(v)) line.gapInches = v;
  }
}

// Normalize a code for tolerant matching: uppercase, drop every
// non-alphanumeric separator, then strip leading zeros from each numeric run.
// Examples (all collapse to the same key):
//   "KN-390-01" -> "KN3901"
//   "KN.390-001" -> "KN3901"
//   "KN 390-1" -> "KN3901"
// Used as a fallback when the exact-uppercase lookup misses (ported from
// HOOKKA scan-po.ts normalizeForMatch).
function normalizeForMatch(s: string): string {
  return s
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((seg) => seg.replace(/(?:^|(?<=\D))0+(?=\d)/g, ''))
    .join('');
}

// Catalog-bound validation: a skuMatch/fabricMatch whose code is NOT in the
// live catalog is cleared to null (never-invent rule, enforced server-side —
// same belt-and-braces as HOOKKA's validateAndEnrichPO). Case-insensitive
// snap to the canonical catalog casing on hit; TOLERANT fallbacks (ported
// from HOOKKA scan-po.ts) before clearing:
//   SKU:    exact-upper → drop a "1" before a trailing letter group
//           ("8030-1L(LHF)" → "8030-L(LHF)") → add one ("8030-L(LHF)" →
//           "8030-1L(LHF)") → separator/leading-zero-stripped lookup.
//   Fabric: exact-upper → separator/leading-zero-stripped lookup
//           ("KN.390-001" / "KN 390-1" → the canonical "KN-390-01").
// Every hit snaps the code to the catalog's canonical casing.
function validateSlip(slip: ExtractedSlip, catalog: Catalog): Warning[] {
  const warnings: Warning[] = [];
  const skuCanon = new Map(catalog.skus.map((s) => [s.code.toUpperCase(), s.code]));
  const fabricCanon = new Map(catalog.fabrics.map((f) => [f.code.toUpperCase(), f.code]));
  const specialCanon = new Map(catalog.specials.map((s) => [s.code.toUpperCase(), s.code]));
  // Tolerant lookup tables — separator-stripped + leading-zero-stripped key →
  // canonical catalog code. Built AFTER the exact maps so an exact hit always
  // wins (the norm key can collide across near-identical codes; first in wins).
  const skuCanonByNorm = new Map<string, string>();
  for (const s of catalog.skus) {
    const k = normalizeForMatch(s.code);
    if (!skuCanonByNorm.has(k)) skuCanonByNorm.set(k, s.code);
  }
  const fabricCanonByNorm = new Map<string, string>();
  for (const f of catalog.fabrics) {
    const k = normalizeForMatch(f.code);
    if (!fabricCanonByNorm.has(k)) fabricCanonByNorm.set(k, f.code);
  }
  // Category by canonical code — gates the bedframe reparseSpec pass below.
  const categoryByCode = new Map(catalog.skus.map((s) => [s.code.toUpperCase(), s.category]));

  slip.lines.forEach((line, i) => {
    if (line.skuMatch) {
      const upper = line.skuMatch.code.toUpperCase();
      let canon = skuCanon.get(upper);
      if (!canon) {
        // "8030-1L(LHF)" → "8030-L(LHF)"
        const dropOne = upper.replace(/-1([A-Z])/, '-$1');
        if (dropOne !== upper) canon = skuCanon.get(dropOne);
      }
      if (!canon) {
        // "8030-L(LHF)" → "8030-1L(LHF)"
        const addOne = upper.replace(/-([A-Z])(\(|$)/, '-1$1$2');
        if (addOne !== upper) canon = skuCanon.get(addOne);
      }
      if (!canon) canon = skuCanonByNorm.get(normalizeForMatch(line.skuMatch.code));
      if (canon) {
        line.skuMatch.code = canon;
      } else {
        warnings.push({
          field: 'skuMatch',
          value: line.skuMatch.code,
          message: `Line ${i + 1}: suggested SKU not in catalog — cleared; pick manually.`,
          lineIdx: i,
        });
        line.skuMatch = null;
      }
    }
    // Regex re-parse the verbatim spec to overrule any Claude truncation
    // mistakes (12" read as 1). Bedframe-family only — skipped for SOFA /
    // ACCESSORY where the spec format is different (same gate as HOOKKA).
    // Runs AFTER the SKU snap so the category gate reads the canonical code;
    // lines with no resolved SKU still reparse (the divan/leg/gap regexes
    // only fire on bedframe spec keywords, so non-bedframe text is inert).
    {
      const cat = line.skuMatch ? categoryByCode.get(line.skuMatch.code.toUpperCase()) ?? '' : '';
      if (cat !== 'SOFA' && cat !== 'ACCESSORY') reparseSpec(line);
    }
    if (line.fabricMatch) {
      const upper = line.fabricMatch.code.toUpperCase();
      let canon = fabricCanon.get(upper);
      if (!canon) canon = fabricCanonByNorm.get(normalizeForMatch(line.fabricMatch.code));
      if (canon) {
        // Snap to the catalog's canonical casing (HOOKKA fabric-casing rule).
        line.fabricMatch.code = canon;
      } else {
        warnings.push({
          field: 'fabricMatch',
          value: line.fabricMatch.code,
          message: `Line ${i + 1}: suggested fabric not in catalog — cleared.`,
          lineIdx: i,
        });
        line.fabricMatch = null;
      }
    }
    // specialsMatch — same never-invent enforcement as skuMatch, PLUS a model
    // gate. Drop any special whose code is not in catalog.specials (case-
    // insensitive snap on hit), then keep only specials the line's resolved
    // Model actually offers (allowed_options.specials). The model is resolved
    // off the line's skuMatch.code via catalog.specialsByModelSku; with no
    // resolved SKU there is no model authority, so all matched specials are
    // dropped (a special can't render checked on a line with no product).
    if (Array.isArray(line.specialsMatch) && line.specialsMatch.length > 0) {
      const allowedForModel = line.skuMatch
        ? catalog.specialsByModelSku.get(line.skuMatch.code.toUpperCase()) ?? null
        : null;
      const kept: SkuMatch[] = [];
      for (const sp of line.specialsMatch) {
        const canon = specialCanon.get(sp.code.toUpperCase());
        if (!canon) {
          warnings.push({
            field: 'specialsMatch',
            value: sp.code,
            message: `Line ${i + 1}: suggested special not in catalog — dropped.`,
            lineIdx: i,
          });
          continue;
        }
        if (!allowedForModel || !allowedForModel.has(canon.toUpperCase())) {
          warnings.push({
            field: 'specialsMatch',
            value: canon,
            message: `Line ${i + 1}: special "${canon}" not offered by this line's model — dropped.`,
            lineIdx: i,
          });
          continue;
        }
        sp.code = canon;
        kept.push(sp);
      }
      line.specialsMatch = kept;
    }
  });

  // SO-Maintenance option matches — same never-invent enforcement: a value
  // outside the ACTIVE allowed list is cleared (case-insensitive snap to the
  // canonical casing on hit).
  const optionFields: Array<{
    field: keyof Pick<ExtractedSlip,
      'paymentMethodMatch' | 'bankMatch' | 'onlineTypeMatch' | 'installmentPlanMatch' |
      'customerTypeMatch' | 'buildingTypeMatch' | 'locationMatch'>;
    category: OptionCategory;
  }> = [
    { field: 'paymentMethodMatch',   category: 'payment_method' },
    { field: 'bankMatch',            category: 'payment_merchant' },
    { field: 'onlineTypeMatch',      category: 'online_type' },
    { field: 'installmentPlanMatch', category: 'installment_plan' },
    { field: 'customerTypeMatch',    category: 'customer_type' },
    { field: 'buildingTypeMatch',    category: 'building_type' },
    { field: 'locationMatch',        category: 'venue' },
  ];
  for (const { field, category } of optionFields) {
    const m = slip[field];
    if (!m) continue;
    const canon = new Map(catalog.options[category].map((o) => [o.value.toUpperCase(), o.value]));
    const hit = canon.get(m.value.toUpperCase());
    if (hit) {
      m.value = hit;
    } else {
      warnings.push({
        field,
        value: m.value,
        message: `Suggested ${category.replace(/_/g, ' ')} not in the SO Maintenance list — cleared; pick manually.`,
      });
      slip[field] = null;
    }
  }

  // Delivery STATE — same never-invent enforcement against the live
  // my_localities state list. A state outside the catalog (or empty list) is
  // cleared so the form never seeds a State the dropdown can't select.
  if (slip.addressStateMatch) {
    const stateCanon = new Map(catalog.states.map((s) => [s.toUpperCase(), s]));
    const hit = stateCanon.get(slip.addressStateMatch.value.toUpperCase());
    if (hit) {
      slip.addressStateMatch.value = hit;
    } else {
      warnings.push({
        field: 'addressStateMatch',
        value: slip.addressStateMatch.value,
        message: 'Suggested delivery state not in the localities list — cleared; pick manually.',
      });
      slip.addressStateMatch = null;
    }
  }
  return warnings;
}

// Service-role client — sample-row reads/writes bypass RLS so extraction
// works regardless of policy state (same pattern as mfg-sales-orders.ts's
// admin client). Auth is already enforced by supabaseAuth on the router.
//
// Houzs CRITICAL fix: getSupabaseService(env) returns a client scoped to the
// `scm` schema (db:{schema:'scm'}), so every sb.from('so_scan_samples' /
// 'so_scan_rules' / 'mfg_products' / …) resolves to scm.*, NOT public.*. The
// 2990's original used createClient(...) defaulting to public.
function serviceClient(env: Env): SupabaseClient {
  return getSupabaseService(env);
}

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return (
    err?.code === '42P01' ||
    // PostgREST reports an unknown relation as PGRST205 ("Could not find the
    // table '…' in the schema cache"), not the raw Postgres 42P01.
    err?.code === 'PGRST205' ||
    /so_scan_samples.*does not exist|relation .* does not exist|could not find the table/i.test(err?.message ?? '')
  );
}

const TABLE_MISSING_MSG =
  'scan-so tables missing — apply src/db/migrations-pg/0023_so_scan_samples.sql to this database.';

// ===========================================================================
// Per-SALESPERSON rule distillation — ported from HOOKKA's ocr-distill.ts
// (per-customer, D1) and adapted to per-salesperson on Supabase, with the
// rules ORGANIZED BY PRODUCT CATEGORY (each rep's notation differs between
// sofa / mattress / bedframe slips).
// ===========================================================================

// `ilike` with no wildcards = case-insensitive exact match, BUT % and _ in
// the value would still act as wildcards — escape them so a rep literally
// named "A_B" can't match "AXB".
function ilikeExact(v: string): string {
  return v.replace(/([\\%_])/g, '\\$1');
}

// Salesperson KEY normalization — applied on EVERY write and read of the
// so_scan_samples / so_scan_rules / scan_jobs salesperson column so that
// case / whitespace variants of one rep's name share ONE learning pool
// (" aaron " / "Aaron" / "aaron  tan" vs "Aaron Tan"). HOOKKA
// BUG-2026-06-07-012 class: their exact-name mismatch wasted 92% of gold
// samples. Trim + collapse internal whitespace; CASE is handled on the read
// side (every lookup goes through ilikeExact, which is case-insensitive) and
// on the rules-write side (the distill upserts onto the existing row's
// canonical casing), so the display casing the rep typed is preserved.
function normalizeRepKey(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
}

// Reserved so_scan_rules key for the GLOBAL shared product-alias dictionary
// (cross-rep: "Bamboo Cruise" vs "Cruise" → one SKU). Just a row — no
// migration. The /salespeople listing filters it out; the weekly cron and
// rep enumeration must never treat it as a salesperson.
const GLOBAL_ALIAS_KEY = '__GLOBAL__';
// Reserved so_scan_rules key for the CROSS-REP SHARED RULES blob — common,
// NON-rep-specific extraction patterns distilled from CONFIRMED corrections
// across ALL salespeople ("one rep's learnings benefit every rep"). Sibling to
// __GLOBAL__ (which is aliases only); this layer is the shared GENERAL/category
// rules every scan — including a brand-new rep's first scan — benefits from.
// Same table/shape (just another reserved row), so NO migration.
const GLOBAL_RULES_KEY = '__GLOBAL_RULES__';
// Either reserved row must be kept out of the salesperson datalist / per-rep
// enumeration / weekly per-rep pass.
const isGlobalKey = (v: string): boolean => {
  const k = v.trim().toUpperCase();
  return k === GLOBAL_ALIAS_KEY || k === GLOBAL_RULES_KEY;
};

const buildDistillMetaPrompt = (companyName: string) => `You are reviewing extraction sessions of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. ALL the examples below were written by ONE salesperson. Each example is a PAIR: what the AI initially extracted, followed by what the human operator corrected it to (the confirmed truth). Each salesperson has their own handwriting and notation habits, and those habits DIFFER per product category. Write a concise salesperson-specific OCR rule block so future extractions of this rep's slips apply their conventions automatically.

DERIVE THE RULES FROM THE DIFFS: compare each "AI extracted" JSON against its "Operator corrected" JSON. Wherever they differ, the AI misread this rep's notation and the human fixed it — that diff is exactly how this rep's shorthand maps to catalog truth (e.g. AI read "BO315-2", operator corrected to "BO315-02" → this rep drops leading zeros in suffixes). Fields that the AI already got right need no rule. Prioritize recurring corrections across multiple pairs over one-off fixes.

ORGANIZE the rules into CATEGORY SECTIONS, in this order, skipping a section only when the rep has no examples in that category:
SOFA:
MATTRESS:
BEDFRAME:
ACCESSORY:
SERVICE:
You may end with a GENERAL: section for habits that span categories (header fields, dates, phone formats, deposit/total notation, salesperson signature style).

Within each category section capture what is BESPOKE TO THIS REP:
  • Shorthand patterns for that category's line items.
  • How they write model names (repeated abbreviations, habitual misspellings, casing).
  • How they write sizes (K/Q/King/Queen/6FT/5FT, sofa seat sizes, dimension notation).
  • Fabric / colour code conventions and where on the row they write them.
  • Price habits (unit price vs line total, "RM" omitted, thousands separators, rounding).
  • Qty habits ("x2" vs "2pcs" vs a bare digit, what a blank qty means for this rep).

In the GENERAL: section ALSO capture this rep's HEADER / non-line-item habits whenever the diffs reveal them:
  • customerSoRef format — the prefix, length, and letter/digit pattern of the slip's own reference number they habitually use (e.g. always "HC#####", or "No. <5 digits>" top-right). Teach the pattern, not a one-off value.
  • Address-part splitting — how they lay out the address and where the postcode / city / state sit, so addressLine1 / postcode / city / addressStateMatch split correctly (e.g. they write state as "JB" meaning Johor, or omit the postcode and only write the taman).
  • Phone / date / deposit notation quirks for this rep (day-first vs written-out dates, "dep" markers, how they sign off salesRep).
  • QUIRKS THAT CONFLICT with the universal rules — when this rep consistently writes something that the universal rules would read differently, call it out explicitly as an override for THIS rep only (e.g. "this rep's 'K' on accessory rows means a colour code, NOT King size").

DO NOT restate universal extraction rules that apply to every salesperson.
DO NOT enumerate every line item from the examples.
DO NOT write a generic OCR primer.
DO write 100-400 words total: each section label exactly as above ("SOFA:", "MATTRESS:", …) on its own line, with short bullet points (•, -, *) underneath. No markdown headers, no fences, no preamble, no closing remarks.

Output ONLY the rule text. The very first characters of your response must be a section label (e.g. "SOFA:"). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

type DistillResult = {
  status: 'distilled' | 'skipped' | 'error';
  reason?: string;
  rulesGenerated?: string;
  sampleCount?: number;
};

// Feed extracted→corrected PAIRS so the model learns from the DIFFS (what
// the AI got wrong vs what the human fixed). Each side is truncated to keep
// the worst case token-bounded; typical slip JSON is ~1-2k chars so
// truncation rarely fires. Shared by per-rep rules + global alias distills.
const PAIR_SIDE_MAX = 4_000;
function pairExamplesText(samples: Array<{ extracted: unknown; corrected: unknown }>): string {
  const sideText = (v: unknown): string => {
    if (v === null || v === undefined) return '(not recorded)';
    const s = JSON.stringify(v);
    return s.length > PAIR_SIDE_MAX ? `${s.slice(0, PAIR_SIDE_MAX)}…(truncated)` : s;
  };
  return samples
    .map(
      (r, i) =>
        `Example ${i + 1}:\nAI extracted: ${sideText(r.extracted)}\nOperator corrected: ${sideText(r.corrected)}`,
    )
    .join('\n\n');
}

// One prose-distill Claude call (temperature 0, fences stripped). Returns
// the cleaned text or an error string — never throws.
async function claudeDistillCall(
  apiKey: string,
  system: string,
  userPayload: string,
): Promise<{ text: string; error: string | null }> {
  try {
    const resp = await anthropicFetchWithRetry({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        // Determinism: same sample pool → same distilled output.
        temperature: 0,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPayload }] }],
      }),
    });
    const bodyText = await resp.text();
    if (!resp.ok) {
      return { text: '', error: `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}` };
    }
    let parsedResp: AnthropicResponse;
    try {
      parsedResp = JSON.parse(bodyText) as AnthropicResponse;
    } catch {
      return { text: '', error: `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}` };
    }
    if (parsedResp.error) {
      return { text: '', error: `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}` };
    }
    const firstText = parsedResp.content?.find((b) => b.type === 'text')?.text ?? '';
    // Distill output is plain prose, not JSON — strip fences only.
    // (Do NOT slice to first/last brace — that would truncate prose.)
    let cleaned = firstText.trim();
    const m = cleaned.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (m?.[1]) cleaned = m[1].trim();
    return { text: cleaned, error: null };
  } catch (e) {
    return { text: '', error: `Network/fetch error: ${(e as Error).message}` };
  }
}

/**
 * Regenerate so_scan_rules for one salesperson from their latest ≤50
 * corrected samples. REPLACES any existing rules row (regenerate-from-pool,
 * not merge — same contract as HOOKKA's distillCustomerRules).
 *
 * Cheap-skip: fewer than 2 corrected samples → skip WITHOUT an Anthropic
 * call, so the fire-and-forget trigger on /confirm is always safe.
 */
async function distillSalespersonRules(
  svc: SupabaseClient,
  apiKey: string | undefined,
  salesperson: string,
  companyName: string,
): Promise<DistillResult> {
  const rep = normalizeRepKey(salesperson);
  if (!rep) return { status: 'error', reason: 'Missing salesperson.' };
  // Reserved keys route to their own cross-rep distillers, never a per-rep
  // rules pass: '__GLOBAL__' → shared alias dictionary,
  // '__GLOBAL_RULES__' → shared cross-rep rules blob.
  if (rep.toUpperCase() === GLOBAL_RULES_KEY) return distillGlobalRules(svc, apiKey, companyName);
  if (isGlobalKey(rep)) return distillGlobalAliases(svc, apiKey, companyName);
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .ilike('salesperson', ilikeExact(rep))
    .order('created_at', { ascending: false })
    .limit(50);
  if (selErr) {
    return { status: 'error', reason: isMissingTable(selErr) ? TABLE_MISSING_MSG : selErr.message };
  }
  const samples = (rows as Array<{ extracted: unknown; corrected: unknown }> | null) ?? [];
  if (samples.length < 2) {
    return {
      status: 'skipped',
      reason: `Need at least 2 corrected samples to distill rules; "${rep}" has ${samples.length}.`,
      sampleCount: samples.length,
    };
  }

  const userPayload =
    `Salesperson: ${rep}\n\n` +
    `Here are ${samples.length} extraction sessions for this salesperson's slips (newest first), ` +
    `each as an AI-extracted → operator-corrected pair. Derive their per-category notation habits ` +
    `from the diffs and write the rule block:\n\n` +
    pairExamplesText(samples);

  const call = await claudeDistillCall(apiKey, buildDistillMetaPrompt(companyName), userPayload);
  let distilledText = call.text;
  const errorMsg = call.error;

  if (errorMsg || !distilledText) {
    return { status: 'error', reason: errorMsg ?? 'Claude returned empty rules.' };
  }
  // Soft cap — keep the injected prompt block bounded (same 32k ceiling as
  // HOOKKA's distill).
  if (distilledText.length > 32_000) distilledText = distilledText.slice(0, 32_000);

  // Canonical PK casing: if a rules row already exists under a different
  // casing ("aaron" vs "Aaron"), upsert onto THAT key instead of creating a
  // case-variant duplicate.
  let key = rep;
  const { data: existing } = await svc
    .from('so_scan_rules')
    .select('salesperson')
    .ilike('salesperson', ilikeExact(rep))
    .limit(1)
    .maybeSingle();
  const existingKey = (existing as { salesperson: string } | null)?.salesperson;
  if (existingKey) key = existingKey;

  const { error: upErr } = await svc
    .from('so_scan_rules')
    .upsert(
      {
        salesperson: key,
        rules: distilledText,
        sample_count: samples.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'salesperson' },
    );
  if (upErr) {
    return { status: 'error', reason: isMissingTable(upErr) ? TABLE_MISSING_MSG : upErr.message };
  }

  return { status: 'distilled', rulesGenerated: distilledText, sampleCount: samples.length };
}

// ===========================================================================
// GLOBAL shared product-alias dictionary — stored under the reserved
// '__GLOBAL__' so_scan_rules row. Cross-rep learning: the SAME product gets
// written differently by different reps ("Bamboo Cruise" / "Cruise" /
// "B.Cruise" → one SKU), so one rep's corrections should teach everyone.
// Per-rep STYLE notes stay in the per-rep rule rows; this is aliases only.
// ===========================================================================
const buildGlobalAliasMetaPrompt = (companyName: string) => `You are reviewing extraction sessions of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. The examples below were written by MANY DIFFERENT salespeople. Each example is a PAIR: what the AI initially extracted, followed by what the human operator corrected it to (the confirmed truth).

Your ONLY job is to build a SHARED PRODUCT-NAME ALIAS DICTIONARY that benefits every salesperson. The same product gets written many different ways across reps ("Bamboo Cruise", "Cruise", "B.Cruise" all mean one SKU). DERIVE THE ALIASES FROM THE DIFFS: wherever the operator corrected a line's skuMatch or fabricMatch, that line's rawText shows how the product was written and the corrected code is the catalog truth — record that variant → code mapping. rawText spellings the AI already matched correctly also confirm aliases worth recording when they differ from the catalog name.

ORGANIZE the dictionary into CATEGORY SECTIONS, in this order, skipping a section only when there are no aliases for it:
SOFA:
MATTRESS:
BEDFRAME:
ACCESSORY:
SERVICE:
You may end with a FABRICS: section for fabric/colour-code shorthand aliases (how reps abbreviate fabric codes → the exact fabric code).

Within each section write one bullet per alias group:
  • "<variant 1>", "<variant 2>", … → <exact catalog code or base model> (short qualifier only when needed, e.g. "size variant still required")
Use ONLY codes / base models that appear in the operator-corrected JSON — NEVER invent a code.
KNOWN ACCESSORY ALIASES — when a corrected sample resolves a "square pillow" / "sq pillow" row to a SQUARE PILLOW accessory code, ALWAYS record it as one ACCESSORY alias group: "Square Pillow", "Sq Pillow" → <the corrected SQUARE PILLOW accessory code> (still only use a code that appears in the corrected JSON; never invent one).

DO NOT write per-salesperson style notes (handwriting habits, qty/price/date/phone notation, signature styles) — those live in separate per-rep rule files.
DO NOT restate universal extraction rules.
DO NOT enumerate every line item from the examples.
DO write 100-400 words total: each section label exactly as above ("SOFA:", "MATTRESS:", …) on its own line, with short bullet points (•, -, *) underneath. No markdown headers, no fences, no preamble, no closing remarks.

Output ONLY the dictionary text. The very first characters of your response must be a section label (e.g. "SOFA:"). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

/**
 * Regenerate the '__GLOBAL__' shared alias dictionary from the latest ≤80
 * corrected samples ACROSS ALL salespeople. REPLACES the existing row
 * (regenerate-from-pool, not merge — same contract as the per-rep distill).
 *
 * Cheap-skip: fewer than 2 corrected samples total → skip WITHOUT an
 * Anthropic call, so the fire-and-forget trigger on /confirm is always safe.
 */
async function distillGlobalAliases(
  svc: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
): Promise<DistillResult> {
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .order('created_at', { ascending: false })
    .limit(80);
  if (selErr) {
    return { status: 'error', reason: isMissingTable(selErr) ? TABLE_MISSING_MSG : selErr.message };
  }
  const samples = (rows as Array<{ extracted: unknown; corrected: unknown }> | null) ?? [];
  if (samples.length < 2) {
    return {
      status: 'skipped',
      reason: `Need at least 2 corrected samples to distill the shared alias dictionary; have ${samples.length}.`,
      sampleCount: samples.length,
    };
  }

  const userPayload =
    `Here are ${samples.length} extraction sessions across ALL salespeople (newest first), ` +
    `each as an AI-extracted → operator-corrected pair. Build the shared product-name alias ` +
    `dictionary from the diffs:\n\n` +
    pairExamplesText(samples);

  const call = await claudeDistillCall(apiKey, buildGlobalAliasMetaPrompt(companyName), userPayload);
  let distilledText = call.text;
  if (call.error || !distilledText) {
    return { status: 'error', reason: call.error ?? 'Claude returned empty aliases.' };
  }
  // Soft cap — keep the injected prompt block bounded (same ceiling as the
  // per-rep distill).
  if (distilledText.length > 32_000) distilledText = distilledText.slice(0, 32_000);

  const { error: upErr } = await svc
    .from('so_scan_rules')
    .upsert(
      {
        salesperson: GLOBAL_ALIAS_KEY,
        rules: distilledText,
        sample_count: samples.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'salesperson' },
    );
  if (upErr) {
    return { status: 'error', reason: isMissingTable(upErr) ? TABLE_MISSING_MSG : upErr.message };
  }

  return { status: 'distilled', rulesGenerated: distilledText, sampleCount: samples.length };
}

// ===========================================================================
// CROSS-REP SHARED RULES — stored under the reserved '__GLOBAL_RULES__'
// so_scan_rules row. Where __GLOBAL__ holds product-name ALIASES, this holds
// the COMMON, NON-rep-specific EXTRACTION PATTERNS distilled from CONFIRMED
// corrections across ALL salespeople: how the operator consistently fixes
// sizes, fabric-code casing, payment-note → option mapping, address splitting,
// customerSoRef shape, etc. — patterns that recur regardless of who wrote the
// slip. Injected into EVERY /extract so one rep's corrections raise the
// baseline for everyone, INCLUDING brand-new reps with no rules of their own.
// Per-rep STYLE (handwriting habits) stays in the per-rep rows; this is the
// shared, universal-improvement layer.
// ===========================================================================
const buildGlobalRulesMetaPrompt = (companyName: string) => `You are reviewing extraction sessions of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. The examples below were written by MANY DIFFERENT salespeople. Each example is a PAIR: what the AI initially extracted, followed by what the human operator corrected it to (the confirmed truth).

Your job is to distill SHARED EXTRACTION RULES that apply to EVERY salesperson — the COMMON, RECURRING ways the operator corrects the AI that are NOT specific to one rep's handwriting. These rules raise the baseline accuracy for all reps, including brand-new ones. DERIVE THEM FROM THE DIFFS: wherever the operator repeatedly corrected the same KIND of field the same way across DIFFERENT reps, that is a shared pattern worth a rule (e.g. a size token consistently re-mapped, a fabric-code casing normalisation, a payment-note phrase that should map to a specific option value, an address part that's habitually mis-split, a customerSoRef shape that's commonly misread).

ONLY capture a rule when the SAME correction pattern shows up across MULTIPLE different salespeople (or is clearly rep-independent). If a correction is unique to one rep's handwriting/notation, DO NOT include it here — that belongs in the per-rep rules. Skip product-name aliases (those live in a separate shared alias dictionary); focus on EXTRACTION-LOGIC patterns: sizes, options/payment mapping, dates, phones, address parts, customerSoRef, qty/price reading.

ORGANIZE into these sections, in this order, skipping a section only when you have no shared rule for it:
LINE ITEMS:
PAYMENT & OPTIONS:
ADDRESS:
HEADER & DATES:
You may end with a GENERAL: section for anything cross-cutting.

Within each section write short bullet rules phrased as universal instructions (not "rep X does…", but "a slip token written as … should map to …"). Each rule must be defensible from the diffs below.

DO NOT restate the universal extraction rules the model already follows by default (never-invent codes, day-first dates, drop trunk 0 on phones) UNLESS the diffs show those defaults are being corrected in a specific consistent direction.
DO NOT write per-salesperson style notes.
DO NOT enumerate every line item from the examples.
DO write 80-350 words total: each section label exactly as above ("LINE ITEMS:", …) on its own line, with short bullet points (•, -, *) underneath. No markdown headers, no fences, no preamble, no closing remarks.

Output ONLY the rule text. The very first characters of your response must be a section label (e.g. "LINE ITEMS:"). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

/**
 * Regenerate the '__GLOBAL_RULES__' shared cross-rep rules blob from the
 * latest ≤80 corrected samples ACROSS ALL salespeople. REPLACES the existing
 * row (regenerate-from-pool, same contract as the alias + per-rep distills).
 *
 * Cheap-skip: fewer than 3 corrected samples total → skip WITHOUT an
 * Anthropic call (shared rules need a few reps' worth of signal to be
 * meaningful; keeps the fire-and-forget trigger on /confirm cheap + safe).
 * Fail-soft: every error path returns a DistillResult, never throws.
 */
async function distillGlobalRules(
  svc: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
): Promise<DistillResult> {
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .order('created_at', { ascending: false })
    .limit(80);
  if (selErr) {
    return { status: 'error', reason: isMissingTable(selErr) ? TABLE_MISSING_MSG : selErr.message };
  }
  const samples = (rows as Array<{ extracted: unknown; corrected: unknown }> | null) ?? [];
  if (samples.length < 3) {
    return {
      status: 'skipped',
      reason: `Need at least 3 corrected samples to distill cross-rep shared rules; have ${samples.length}.`,
      sampleCount: samples.length,
    };
  }

  const userPayload =
    `Here are ${samples.length} extraction sessions across ALL salespeople (newest first), ` +
    `each as an AI-extracted → operator-corrected pair. Distill the SHARED, rep-independent ` +
    `extraction rules from the recurring diffs:\n\n` +
    pairExamplesText(samples);

  const call = await claudeDistillCall(apiKey, buildGlobalRulesMetaPrompt(companyName), userPayload);
  let distilledText = call.text;
  if (call.error || !distilledText) {
    return { status: 'error', reason: call.error ?? 'Claude returned empty shared rules.' };
  }
  // Soft cap — keep the injected prompt block bounded (same ceiling as the
  // alias + per-rep distills).
  if (distilledText.length > 32_000) distilledText = distilledText.slice(0, 32_000);

  const { error: upErr } = await svc
    .from('so_scan_rules')
    .upsert(
      {
        salesperson: GLOBAL_RULES_KEY,
        rules: distilledText,
        sample_count: samples.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'salesperson' },
    );
  if (upErr) {
    return { status: 'error', reason: isMissingTable(upErr) ? TABLE_MISSING_MSG : upErr.message };
  }

  return { status: 'distilled', rulesGenerated: distilledText, sampleCount: samples.length };
}

/**
 * Weekly cron entry point — refresh the '__GLOBAL__' shared alias dictionary
 * and the '__GLOBAL_RULES__' cross-rep rules blob FIRST, then regenerate
 * rules for EVERY salesperson with ≥2
 * corrected samples. Sequential (one Anthropic call at a time) and
 * error-isolated per rep: one rep failing never blocks the rest. The
 * per-confirm fire-and-forget distill remains the fast path; this weekly
 * pass is the safety net that consolidates (e.g. confirms whose distill
 * fetch died mid-flight).
 *
 * WIRED: backend/src/index.ts scheduled() calls this on Sundays in the daily
 * 02:00 UTC slot; the per-confirm fire-and-forget distill is the primary live
 * path and this weekly pass is the consolidating safety net.
 */
export async function distillAllSalespersonRules(
  svc: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
): Promise<{ distilled: number; skipped: number; errors: number; reps: number }> {
  const summary = { distilled: 0, skipped: 0, errors: 0, reps: 0 };

  // Shared alias dictionary first — it benefits every rep's scans and its
  // sample pool (all corrected rows) is a superset of any rep's.
  try {
    const g = await distillGlobalAliases(svc, apiKey, companyName);
    if (g.status === 'distilled') summary.distilled += 1;
    else if (g.status === 'skipped') summary.skipped += 1;
    else {
      summary.errors += 1;
      console.error(`[scan-so weekly distill] __GLOBAL__ aliases failed: ${g.reason}`);
    }
  } catch (e) {
    summary.errors += 1;
    console.error(`[scan-so weekly distill] __GLOBAL__ aliases threw: ${(e as Error).message}`);
  }

  // Cross-rep shared RULES blob — also benefits every rep (and brand-new
  // reps), distilled from the same all-reps corrected pool. Error-isolated
  // like the alias pass so it can never block the per-rep loop below.
  try {
    const gr = await distillGlobalRules(svc, apiKey, companyName);
    if (gr.status === 'distilled') summary.distilled += 1;
    else if (gr.status === 'skipped') summary.skipped += 1;
    else {
      summary.errors += 1;
      console.error(`[scan-so weekly distill] __GLOBAL_RULES__ failed: ${gr.reason}`);
    }
  } catch (e) {
    summary.errors += 1;
    console.error(`[scan-so weekly distill] __GLOBAL_RULES__ threw: ${(e as Error).message}`);
  }

  // Distinct salespeople with ≥2 corrected rows. Supabase has no DISTINCT
  // aggregate over the REST API, so pull the (small) salesperson column and
  // count client-side, case-insensitively (matching the ilike used by
  // distillSalespersonRules).
  const { data, error } = await paginateAll((from, to) => svc
    .from('so_scan_samples')
    .select('salesperson')
    .not('corrected', 'is', null)
    .not('salesperson', 'is', null)
    .order('created_at', { ascending: false })
    .range(from, to));
  if (error) {
    console.error('[scan-so weekly distill] sample scan failed:', error.message);
    summary.errors += 1;
    return summary;
  }

  const counts = new Map<string, { display: string; n: number }>();
  for (const row of (data as Array<{ salesperson: string | null }> | null) ?? []) {
    const t = normalizeRepKey(row.salesperson);
    if (!t) continue;
    // Belt-and-braces: the reserved global key is never a salesperson.
    if (isGlobalKey(t)) continue;
    const key = t.toUpperCase();
    const cur = counts.get(key);
    if (cur) cur.n += 1;
    else counts.set(key, { display: t, n: 1 });
  }
  const reps = Array.from(counts.values())
    .filter((r) => r.n >= 2)
    .map((r) => r.display)
    .sort((a, b) => a.localeCompare(b));
  summary.reps = reps.length;

  for (const rep of reps) {
    try {
      const res = await distillSalespersonRules(svc, apiKey, rep, companyName);
      if (res.status === 'distilled') summary.distilled += 1;
      else if (res.status === 'skipped') summary.skipped += 1;
      else {
        summary.errors += 1;
        console.error(`[scan-so weekly distill] "${rep}" failed: ${res.reason}`);
      }
    } catch (e) {
      summary.errors += 1;
      console.error(`[scan-so weekly distill] "${rep}" threw: ${(e as Error).message}`);
    }
  }
  return summary;
}

// ===========================================================================
// GET /scan-so/salespeople — distinct reps seen across samples + rules.
// Feeds the modal's Salesperson datalist. Best-effort: tables missing →
// empty list (the field is free-text anyway).
// ===========================================================================
scanSo.get('/salespeople', async (c) => {
  const svc = serviceClient(c.env);
  const seen = new Map<string, string>(); // UPPER(name) -> display casing
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    // The reserved '__GLOBAL__' alias row lives in so_scan_rules but is NOT
    // a salesperson — keep it out of the modal datalist.
    if (!t || isGlobalKey(t)) return;
    if (!seen.has(t.toUpperCase())) seen.set(t.toUpperCase(), t);
  };
  try {
    const [rulesRes, samplesRes] = await Promise.all([
      svc.from('so_scan_rules').select('salesperson').limit(500),
      svc
        .from('so_scan_samples')
        .select('salesperson')
        .not('salesperson', 'is', null)
        .order('created_at', { ascending: false })
        .limit(500),
    ]);
    for (const r of (rulesRes.data as Array<{ salesperson: string | null }> | null) ?? []) add(r.salesperson);
    for (const r of (samplesRes.data as Array<{ salesperson: string | null }> | null) ?? []) add(r.salesperson);
  } catch {
    /* best-effort */
  }
  const salespeople = Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  return c.json({ success: true, data: { salespeople } });
});

// ===========================================================================
// GET /scan-so/rules/:salesperson — view a rep's distilled rules.
// ===========================================================================
scanSo.get('/rules/:salesperson', async (c) => {
  const rep = normalizeRepKey(c.req.param('salesperson'));
  if (!rep) return c.json({ error: 'bad_request', reason: 'Missing salesperson.' }, 400);
  const svc = serviceClient(c.env);
  const { data, error } = await svc
    .from('so_scan_rules')
    .select('salesperson, rules, sample_count, updated_at')
    .ilike('salesperson', ilikeExact(rep))
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: TABLE_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: error.message }, 500);
  }
  if (!data) {
    return c.json({ error: 'not_found', reason: `No distilled rules for "${rep}" yet.` }, 404);
  }
  return c.json({ success: true, data });
});

// ===========================================================================
// POST /scan-so/rules/:salesperson/distill — manual regeneration.
// ===========================================================================
scanSo.post('/rules/:salesperson/distill', async (c) => {
  const rep = normalizeRepKey(c.req.param('salesperson'));
  if (!rep) return c.json({ error: 'bad_request', reason: 'Missing salesperson.' }, 400);
  const branding = await getBranding(c.env);
  const res = await distillSalespersonRules(serviceClient(c.env), c.env.ANTHROPIC_API_KEY, rep, branding.companyName);
  if (res.status === 'error') {
    return c.json({ error: 'distill_failed', reason: res.reason }, 500);
  }
  return c.json({ success: true, data: res });
});

// ===========================================================================
// GET /scan-so/slip-image?key=scan-slips/<sampleId> — serve the stored slip
// image back as "Original Slip" proof on the SO detail page.
//
// Authed (supabaseAuth runs on the whole router). Mirrors the item-photo GET
// proxy in mfg-sales-orders.ts: validate the key prefix, stream the R2 object
// with its stored content-type, 404 when missing. The `scan-slips/` prefix
// guard stops an attacker-supplied key from reaching an unrelated R2 object.
// ===========================================================================
scanSo.get('/slip-image', async (c) => {
  const key = c.req.query('key') ?? '';
  if (!key.startsWith('scan-slips/')) {
    return c.json({ error: 'bad_request', reason: 'key must start with scan-slips/' }, 400);
  }
  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }
  const obj = await c.env.SO_ITEM_PHOTOS.get(key);
  if (!obj) return c.json({ error: 'slip_image_not_found' }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // Immutable per sample (key is the sampleId), so a long browser cache
      // is safe — matches the item-photo proxy cache policy.
      'cache-control': 'private, max-age=3600',
    },
  });
});

// ===========================================================================
// POST /scan-so/warm — pre-warm the Anthropic catalog prompt-cache.
//
// The modal fires this on open (fire-and-forget) so the cache heats while the
// operator readies their photo; the keep-warm cron fires the same logic during
// business hours so the shared cache rarely goes cold. ONE minimal Claude call
// sending the BYTE-IDENTICAL cachedPrefix /extract uses (same model, same
// cache_control ttl, same beta header) — warms exactly the bucket /extract
// reads. Returns fast. Graceful: no key → { ok:false, reason:'no_key' } (200);
// any failure is caught and returned, never thrown.
// ===========================================================================
scanSo.post('/warm', async (c) => {
  const sb = c.get('supabase');
  const branding = await getBranding(c.env);
  const result = await warmCatalogCache(sb, c.env.ANTHROPIC_API_KEY, branding.companyName);
  return c.json(result);
});

// ===========================================================================
// Shared OCR pipeline pieces — used by BOTH POST /scan-so/extract (the
// client-driven flow, kept as the mobile fallback) and the background scan
// job (POST /scan-so/enqueue → waitUntil pipeline). Factored MECHANICALLY out
// of the /extract handler — same code, same order — so the two paths can
// never drift. /extract's endpoint contract is unchanged.
// ===========================================================================
type ContentBlock = Record<string, unknown>;
// Per-IMAGE provenance, indexed by the SAME `index` Claude classifies in the
// OUTPUT "images" array — fileBlocks is built in file order, so image #N in
// the model's view is uploadedImages[N]. PDFs are NOT displayable inline on
// the SO detail page so they are never stored under image_key (they still
// ride into the prompt as document blocks).
type UploadedImage = { index: number; buffer: ArrayBuffer; mime: string };
type ScanFileParse = {
  // Claude content blocks (image or document per file), in upload order.
  fileBlocks: ContentBlock[];
  // Image files only (buffer + mime), for R2 provenance storage.
  uploadedImages: UploadedImage[];
  // EVERY accepted file's raw bytes (images AND pdfs) — the enqueue path
  // persists these to R2 for durability before the job runs.
  allFiles: Array<{ buffer: ArrayBuffer; mime: string }>;
  firstBuffer: ArrayBuffer | null;
  fileCount: number;
};

// Accept files under any field name ("file", "files", repeated) — the modal
// sends `file` repeatedly but be liberal in what we accept. Returns a plain
// bad-request reason string on any rejected input (the caller maps it to its
// own 400), or the parsed blocks/buffers.
async function parseScanFiles(
  formData: FormData,
): Promise<{ ok: true; parsed: ScanFileParse } | { ok: false; reason: string }> {
  // (entries cast to unknown: @cloudflare/workers-types narrows
  // FormDataEntryValue to string, which breaks the instanceof check.)
  const files: File[] = [];
  for (const [, v] of formData.entries() as Iterable<[string, unknown]>) {
    if (v instanceof File && v.size > 0) files.push(v);
  }
  if (files.length === 0) return { ok: false, reason: 'No file uploaded.' };

  const fileBlocks: ContentBlock[] = [];
  const uploadedImages: UploadedImage[] = [];
  const allFiles: Array<{ buffer: ArrayBuffer; mime: string }> = [];
  let firstBuffer: ArrayBuffer | null = null;
  let blockIndex = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, reason: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.` };
    }
    const mime = file.type || '';
    const name = (file.name || '').toLowerCase();
    const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
    const isImage =
      IMAGE_MIMES.has(mime) ||
      name.endsWith('.jpg') || name.endsWith('.jpeg') ||
      name.endsWith('.png') || name.endsWith('.webp');
    if (!isPdf && !isImage) {
      return { ok: false, reason: `Unsupported file type "${mime || name}". Use JPEG / PNG / WEBP / PDF.` };
    }
    const buf = await file.arrayBuffer();
    if (!firstBuffer) firstBuffer = buf;
    const data = toBase64(buf);
    if (isPdf) {
      allFiles.push({ buffer: buf, mime: 'application/pdf' });
      fileBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      });
    } else {
      const mediaType = IMAGE_MIMES.has(mime)
        ? mime
        : name.endsWith('.png') ? 'image/png'
        : name.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';
      allFiles.push({ buffer: buf, mime: mediaType });
      uploadedImages.push({ index: blockIndex, buffer: buf, mime: mediaType });
      fileBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
    }
    blockIndex += 1;
  }
  return {
    ok: true,
    parsed: { fileBlocks, uploadedImages, allFiles, firstBuffer, fileCount: files.length },
  };
}

// Dynamic (post-cache-boundary) prompt blocks: shared alias dictionary,
// cross-rep shared rules, the rep's own distilled rules, and the few-shot
// pool. All best-effort — a missing row/table just skips that block.
type PromptInjections = {
  globalAliasText: string;
  globalAliasApplied: boolean;
  globalRulesText: string;
  globalRulesApplied: boolean;
  repRulesText: string;
  repRulesMeta: { salesperson: string; sampleCount: number } | null;
  fewShotText: string;
};
async function loadPromptInjections(svc: SupabaseClient, repGiven: string): Promise<PromptInjections> {
  // GLOBAL shared product-alias dictionary ('__GLOBAL__' so_scan_rules row)
  // — injected for EVERY scan regardless of salesperson, AFTER the cache
  // boundary and BEFORE the per-rep rules block.
  let globalAliasText = '';
  let globalAliasApplied = false;
  try {
    const { data: gRow } = await svc
      .from('so_scan_rules')
      .select('rules')
      .eq('salesperson', GLOBAL_ALIAS_KEY)
      .limit(1)
      .maybeSingle();
    const g = gRow as { rules: string } | null;
    if (g && g.rules.trim() !== '') {
      globalAliasText =
        `SHARED PRODUCT ALIASES (all salespeople) — distilled from every rep's previously ` +
        `corrected slips: common handwritten product-name variants and fabric-code shorthands ` +
        `mapped to exact catalog codes. Use them to resolve ambiguous handwriting (they ` +
        `complement, never override, the catalog and the never-invent-codes rule):\n\n` +
        g.rules;
      globalAliasApplied = true;
    }
  } catch {
    /* best-effort */
  }

  // CROSS-REP SHARED RULES ('__GLOBAL_RULES__' so_scan_rules row) — common,
  // rep-independent extraction patterns distilled from CONFIRMED corrections
  // across ALL reps. Injected for EVERY scan (including a brand-new rep's
  // first one), alongside the shared aliases and BEFORE the per-rep rules so
  // a rep's own rules can still refine on top.
  let globalRulesText = '';
  let globalRulesApplied = false;
  try {
    const { data: grRow } = await svc
      .from('so_scan_rules')
      .select('rules')
      .eq('salesperson', GLOBAL_RULES_KEY)
      .limit(1)
      .maybeSingle();
    const gr = grRow as { rules: string } | null;
    if (gr && gr.rules.trim() !== '') {
      globalRulesText =
        `SHARED EXTRACTION RULES (all salespeople) — distilled from every rep's previously ` +
        `corrected slips: the common, rep-independent ways the operator fixes sizes, payment / ` +
        `option mapping, address parts, dates and customer references. Apply them to every slip ` +
        `(they complement, never override, the universal extraction rules, the catalog and the ` +
        `never-invent-codes rule):\n\n` +
        gr.rules;
      globalRulesApplied = true;
    }
  } catch {
    /* best-effort */
  }

  // Per-rep distilled rules block (so_scan_rules). Injected AFTER the
  // cache_control boundary so the catalog prefix stays cache-stable across
  // reps.
  let repRulesText = '';
  let repRulesMeta: { salesperson: string; sampleCount: number } | null = null;
  if (repGiven) {
    try {
      const { data: ruleRow } = await svc
        .from('so_scan_rules')
        .select('salesperson, rules, sample_count')
        .ilike('salesperson', ilikeExact(repGiven))
        .limit(1)
        .maybeSingle();
      const row = ruleRow as { salesperson: string; rules: string; sample_count: number | null } | null;
      if (row && row.rules.trim() !== '') {
        repRulesText =
          `SALESPERSON-SPECIFIC RULES — this slip was written by ${row.salesperson}. ` +
          `These rules were distilled from this rep's previously confirmed slips and are organized by ` +
          `product category; apply the matching category section's conventions when reading their handwriting ` +
          `(they complement, never override, the universal extraction rules and the never-invent-codes rule):\n\n` +
          row.rules;
        repRulesMeta = { salesperson: row.salesperson, sampleCount: row.sample_count ?? 0 };
      }
    } catch {
      /* best-effort */
    }
  }

  // Few-shot pool: 5 most recent operator-confirmed samples — THIS REP's
  // first, topped up with global recents (deduped by id).
  let fewShotText = '';
  try {
    type FewShotRow = { id: string; corrected: unknown };
    const picked: Array<{ corrected: unknown; mine: boolean }> = [];
    const pickedIds = new Set<string>();
    if (repGiven) {
      const { data: repRows } = await svc
        .from('so_scan_samples')
        .select('id, corrected')
        .not('corrected', 'is', null)
        .ilike('salesperson', ilikeExact(repGiven))
        .order('created_at', { ascending: false })
        .limit(5);
      for (const r of (repRows as FewShotRow[] | null) ?? []) {
        picked.push({ corrected: r.corrected, mine: true });
        pickedIds.add(r.id);
      }
    }
    if (picked.length < 5) {
      const { data: rows } = await svc
        .from('so_scan_samples')
        .select('id, corrected')
        .not('corrected', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5);
      for (const r of (rows as FewShotRow[] | null) ?? []) {
        if (picked.length >= 5) break;
        if (pickedIds.has(r.id)) continue;
        picked.push({ corrected: r.corrected, mine: false });
        pickedIds.add(r.id);
      }
    }
    if (picked.length > 0) {
      const blocks = picked
        .map((r, i) => {
          const who = repGiven ? (r.mine ? ` — written by ${repGiven}, weigh heavily` : ' — another rep') : '';
          return `Example ${i + 1} (operator-confirmed${who}):\n${JSON.stringify(r.corrected)}`;
        })
        .join('\n\n');
      fewShotText =
        `FEW-SHOT EXAMPLES from previous slips, corrected by the operator. ` +
        `Apply the same field conventions, transcription style, and matching judgement:\n\n${blocks}`;
    }
  } catch {
    /* best-effort */
  }

  return {
    globalAliasText, globalAliasApplied,
    globalRulesText, globalRulesApplied,
    repRulesText, repRulesMeta,
    fewShotText,
  };
}

// The ONE Claude vision call + JSON coercion. Timeout / retry / cache /
// parse behaviour identical for /extract and the background job.
type SlipExtractCall = {
  parsed: ExtractedSlip | null;
  errorMsg: string | null;
  timedOut: boolean;
  claudeText: string;
  cacheHit: boolean;
  cacheCreated: boolean;
};
async function callClaudeSlipExtract(
  apiKey: string,
  cachedPrefix: string,
  inj: PromptInjections,
  fileBlocks: ContentBlock[],
): Promise<SlipExtractCall> {
  let errorMsg: string | null = null;
  let timedOut = false;
  let parsed: ExtractedSlip | null = null;
  let claudeText = '';
  let cacheHit = false;
  let cacheCreated = false;

  try {
    const resp = await anthropicFetchWithRetry({
      method: 'POST',
      // Outbound timeout (110s, under the Worker's wall-clock budget) so a hung
      // Anthropic call fails fast into the graceful 503 below instead of the
      // request dangling until the platform kills it with an opaque error. The
      // timeout bounds the whole retry window, not each attempt.
      signal: AbortSignal.timeout(110_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Houzs 2026-06-23 — Houzs is a RETAILER (1141 SKUs + 705 fabrics in the
        // injected catalog vs HOOKKA's small maker catalog), so the cached prefix
        // is large and the default 5-min ephemeral cache expires between scans
        // spaced apart. Extend the cache to 1h so back-to-back and
        // within-the-hour scans reuse the catalog prefix and stay fast.
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        // temperature=0 — deterministic OCR. Same slip + same prompt must
        // produce identical output so wrong fields are reproducible bugs,
        // not a flaky lottery (lesson from the HOOKKA scan-po rollout).
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } },
              // Shared aliases + shared rules + rep rules + few-shot live AFTER
              // the cache boundary — they vary per distill/salesperson/sample and
              // must not bust the prefix. Order: shared aliases → shared rules →
              // rep rules → few-shot examples (rep-specific refines on the shared
              // baseline; concrete examples come last).
              ...(inj.globalAliasText ? [{ type: 'text', text: inj.globalAliasText }] : []),
              ...(inj.globalRulesText ? [{ type: 'text', text: inj.globalRulesText }] : []),
              ...(inj.repRulesText ? [{ type: 'text', text: inj.repRulesText }] : []),
              ...(inj.fewShotText ? [{ type: 'text', text: inj.fewShotText }] : []),
              ...fileBlocks,
              {
                type: 'text',
                text:
                  'Extract the sale-order slip above using the rules + catalog. ' +
                  "OUTPUT FORMAT: Your response must be VALID JSON ONLY. Do NOT write any preamble, explanation, analysis, or chain-of-thought. Do NOT start with phrases like 'Looking at the image…'. Do NOT wrap in markdown fences. The very first character of your response must be '{' and the very last must be '}'.",
              },
            ],
          },
        ],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
    } else {
      let parsedResp: AnthropicResponse;
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
        parsedResp = {};
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else {
        cacheHit = (parsedResp.usage?.cache_read_input_tokens ?? 0) > 0;
        cacheCreated = (parsedResp.usage?.cache_creation_input_tokens ?? 0) > 0;
        const firstText = parsedResp.content?.find((b) => b.type === 'text')?.text ?? '';
        claudeText = stripJsonFences(firstText);
        try {
          parsed = normalizeSlip(JSON.parse(claudeText));
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    // AbortSignal.timeout fires a TimeoutError (older runtimes: AbortError).
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      timedOut = true;
      errorMsg = 'OCR timed out — the slip took too long to read. Please try again.';
    } else {
      errorMsg = `Network/fetch error: ${(e as Error).message}`;
    }
  }

  return { parsed, errorMsg, timedOut, claudeText, cacheHit, cacheCreated };
}

// Persist the sample row (status EXTRACTED, or FAILED with the error blob) —
// the learning pool grows on every scan, background or interactive.
async function insertScanSample(
  svc: SupabaseClient,
  args: {
    imageSha256: string | null;
    salesperson: string | null;
    parsed: ExtractedSlip | null;
    errorMsg: string | null;
    claudeText: string;
  },
): Promise<{ sampleId: string | null; sampleInsertError: string | null }> {
  let sampleId: string | null = null;
  let sampleInsertError: string | null = null;
  try {
    const { data: inserted, error: insErr } = await svc
      .from('so_scan_samples')
      .insert({
        image_sha256: args.imageSha256,
        salesperson: args.salesperson,
        extracted: args.parsed ?? { error: args.errorMsg, claudeText: args.claudeText },
        status: args.parsed ? 'EXTRACTED' : 'FAILED',
      })
      .select('id')
      .single();
    if (insErr) {
      sampleInsertError = isMissingTable(insErr) ? TABLE_MISSING_MSG : insErr.message;
      console.error('so_scan_samples insert failed:', insErr.message);
    } else {
      sampleId = (inserted as { id: string } | null)?.id ?? null;
    }
  } catch (e) {
    sampleInsertError = (e as Error).message;
    console.error('so_scan_samples insert failed:', sampleInsertError);
  }
  return { sampleId, sampleInsertError };
}

// Original-image persistence (best-effort). The scan can carry TWO photos —
// a HANDWRITTEN order slip and a PRINTED card-terminal payment receipt. Pick
// which uploaded IMAGE is which from Claude's `images` classification, then
// store up to two raw buffers in the SO_ITEM_PHOTOS R2 bucket:
//   order slip    -> `scan-slips/${sampleId}`          (image_key, mig 0033)
//   payment recpt -> `scan-slips/${sampleId}-receipt`  (receipt_image_key, mig 0034)
// Both keys ride onto the created SO so the SO Detail page can serve them back
// as "Order Slip" / "Payment Receipt" proof. CLASSIFICATION FALLBACK: when the
// model's tags are missing/ambiguous, the first image = order slip and a
// second image (if any) = receipt. PDFs are never stored (not inline-viewable)
// and are excluded from uploadedImages. An R2/classify/DB failure must NEVER
// fail the extraction — it's pure provenance.
async function storeScanImages(
  bucket: R2Bucket | undefined,
  svc: SupabaseClient,
  sampleId: string | null,
  uploadedImages: UploadedImage[],
  parsed: ExtractedSlip | null,
): Promise<{ imageKey: string | null; receiptImageKey: string | null }> {
  let imageKey: string | null = null;
  let receiptImageKey: string | null = null;
  // const alias — narrowing on a `const` survives into the putImage closure
  // below (a plain parameter's narrowing would not).
  const store = bucket;
  if (sampleId && uploadedImages.length > 0 && store) {
    // Resolve order-slip + receipt images from the classification, falling back
    // to positional order (1st = slip, 2nd = receipt) when tags don't cover it.
    const tagByIndex = new Map<number, ImageKind>();
    for (const img of parsed?.images ?? []) {
      if (!tagByIndex.has(img.index)) tagByIndex.set(img.index, img.kind);
    }
    let slipImg: UploadedImage | null =
      uploadedImages.find((u) => tagByIndex.get(u.index) === 'order_slip') ?? null;
    let receiptImg: UploadedImage | null =
      uploadedImages.find((u) => tagByIndex.get(u.index) === 'payment_receipt') ?? null;
    // Guard against the model tagging the same image as both.
    if (slipImg && receiptImg && slipImg.index === receiptImg.index) receiptImg = null;
    if (!slipImg) {
      // Positional fallback: first image not already taken as the receipt.
      slipImg = uploadedImages.find((u) => u.index !== receiptImg?.index) ?? null;
    }
    if (!receiptImg && uploadedImages.length > 1) {
      receiptImg = uploadedImages.find((u) => u.index !== slipImg?.index) ?? null;
    }

    const putImage = async (
      img: UploadedImage | null,
      key: string,
      column: 'image_key' | 'receipt_image_key',
      label: string,
    ): Promise<string | null> => {
      if (!img) return null;
      try {
        await store.put(key, img.buffer, {
          httpMetadata: { contentType: img.mime },
        });
        const { error: keyErr } = await svc
          .from('so_scan_samples')
          .update({ [column]: key })
          .eq('id', sampleId);
        if (keyErr) {
          console.warn(`[scan-so ${label}] ${column} update failed:`, keyErr.message);
          return null;
        }
        return key;
      } catch (e) {
        console.warn(`[scan-so ${label}] R2 put failed:`, (e as Error).message);
        return null;
      }
    };

    imageKey = await putImage(slipImg, `scan-slips/${sampleId}`, 'image_key', 'slip-image');
    receiptImageKey = await putImage(
      receiptImg,
      `scan-slips/${sampleId}-receipt`,
      'receipt_image_key',
      'receipt-image',
    );
  }
  return { imageKey, receiptImageKey };
}

// Post-extraction enrichment + catalog-bound validation, IN PLACE on `parsed`:
// phone normalisation, Google-geocode address correction (postcode-driven
// city/state snap via my_localities), then validateSlip (never-invent
// enforcement + tolerant SKU/fabric snapping + the bedframe reparseSpec
// override). Returns the operator-facing warnings.
async function postProcessSlip(
  parsed: ExtractedSlip,
  sb: SupabaseClient,
  googleMapsApiKey: string | undefined,
  catalog: Catalog,
): Promise<Warning[]> {
  // Phone normalisation — store the bare national-significant form under +60
  // (drop the trunk 0): "0197770309" -> "197770309". Applies to every extracted
  // phone (main + spouse/emergency) so the form's PhoneInput seeds the correct
  // digits. phones[0] is the primary; the rest ride along for the edit-gate.
  parsed.phones = parsed.phones
    .map((p) => normalizeMyPhone(p))
    .filter((p): p is string => p !== null);

  // Address via Google Geocoding (GOOGLE_MAPS_API_KEY). The LLM mis-parses
  // Malaysian areas (it put Melawati at Ampang/Selangor 68000 — it's KL/Setapak
  // ~53100), so when geocoding succeeds we PREFER its state/city/postcode over
  // the LLM guess. Fail-soft: no key / network error / no result -> keep the LLM
  // parse untouched. The geocoded STATE is seeded into addressStateMatch so the
  // validateSlip pass below still snaps it to the catalog states list (and
  // clears it if the geocoder ever returns a non-catalog state).
  try {
    const geo = await geocodeAddress(parsed.address, googleMapsApiKey);
    if (geo) {
      // Postcode is the driver: seed it first, then resolve city/state from the
      // SAME my_localities row that postcode maps to (the cascade the form uses),
      // so the seeded city/state are consistent with the postcode and selectable
      // in the form's dropdowns. Fall back to Google's components only when no
      // localities row matches the resolved postcode.
      let city = geo.city;
      let state = geo.state;
      if (geo.postcode) {
        parsed.postcode = geo.postcode;
        const loc = await localityForPostcode(sb, geo.postcode);
        if (loc) {
          if (loc.city) city = loc.city;
          if (loc.state) state = loc.state;
        }
      }
      if (state) {
        parsed.addressStateMatch = { value: state, confidence: 0.95, reason: 'Google geocode' };
      }
      if (city) parsed.city = city;
    }
  } catch {
    /* fail-soft — keep the LLM address parse */
  }

  const warnings = validateSlip(parsed, catalog);

  // Phone plausibility (evidence 2026-07: the OCR dropped a doubled digit —
  // "01137166720" read as "0113716720"): a Malaysian national-significant
  // number (after the trunk 0 strip above) is 9-10 digits for mobiles and
  // 8-9 for landlines. Anything under 9 or over 10 very likely lost/gained a
  // digit — warn the operator so the form gets a second look.
  for (const p of parsed.phones) {
    if (p.length < 9 || p.length > 10) {
      warnings.push({
        field: 'phones',
        value: p,
        message: `Phone "+60${p}" has an unusual digit count — the scan may have dropped or doubled a digit; please verify against the slip.`,
      });
    }
  }
  return warnings;
}

// ===========================================================================
// POST /scan-so/extract
// ===========================================================================
scanSo.post('/extract', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      { error: 'anthropic_key_missing', reason: 'Run: npx wrangler secret put ANTHROPIC_API_KEY' },
      503,
    );
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return c.json({ error: 'bad_request', reason: `Invalid multipart body: ${(e as Error).message}` }, 400);
  }

  // Build Claude content blocks (image or document per file) — shared with
  // the background /enqueue path (parseScanFiles).
  const filesRes = await parseScanFiles(formData);
  if (!filesRes.ok) {
    return c.json({ error: 'bad_request', reason: filesRes.reason }, 400);
  }
  const { fileBlocks, uploadedImages, firstBuffer, fileCount } = filesRes.parsed;

  const imageSha256 = firstBuffer ? await sha256Hex(firstBuffer) : null;

  // Salesperson — operator-set in the modal BEFORE extract (free-text).
  // When given, that rep's distilled rules + their own confirmed samples are
  // injected; when blank, the AI's salesRep extraction backfills the sample
  // row so the pool still grows per rep. Normalized (trim + single-space) so
  // case/whitespace variants share one learning pool.
  const repGiven = normalizeRepKey(formData.get('salesperson'));

  // Catalog via the user-scoped client (RLS applies, same visibility the
  // operator already has on the SKU master screens).
  const sb = c.get('supabase');
  const catalog = await loadCatalog(sb);

  // Company name for the prompt anchor comes from the central Branding config
  // (stable → the cached prefix below stays byte-identical to /warm + cron).
  const branding = await getBranding(c.env);

  // Cached prefix = SYSTEM_PROMPT + catalog (shared builder — BYTE-IDENTICAL to
  // what /scan-so/warm and the keep-warm cron send, so they warm the SAME cache
  // /extract reads). Identical across calls until the catalog changes →
  // Anthropic prompt-cache hit (~90% discount). Few-shot examples stay OUTSIDE
  // the cache boundary so a new confirmed sample doesn't invalidate the cache.
  const cachedPrefix = buildCachedPrefix(catalog, branding.companyName);

  const svc = serviceClient(c.env);

  // Dynamic prompt blocks (shared aliases / cross-rep shared rules / per-rep
  // rules / few-shot) — loadPromptInjections, shared with the background job.
  const inj = await loadPromptInjections(svc, repGiven);

  // ONE Claude vision call + JSON coercion — callClaudeSlipExtract, shared
  // with the background job (timeout / retry / cache semantics inside).
  const { parsed, errorMsg, timedOut, claudeText, cacheHit, cacheCreated } =
    await callClaudeSlipExtract(apiKey, cachedPrefix, inj, fileBlocks);

  // Persist the sample row (learning pool) — insertScanSample, shared with
  // the background job. salesperson = operator's pick, else the AI's salesRep
  // detection — keeps the per-rep pool growing even when the operator forgets
  // the field.
  const sampleSalesperson = repGiven || normalizeRepKey(parsed?.salesRep) || null;
  const { sampleId, sampleInsertError } = await insertScanSample(svc, {
    imageSha256, salesperson: sampleSalesperson, parsed, errorMsg, claudeText,
  });

  // Original slip / receipt R2 persistence — storeScanImages, shared with the
  // background job (Claude image-classification fallback semantics inside).
  const { imageKey, receiptImageKey } = await storeScanImages(
    c.env.SO_ITEM_PHOTOS, svc, sampleId, uploadedImages, parsed,
  );

  if (!parsed) {
    // A hung Anthropic call (caught by the 110s AbortSignal.timeout) maps to the
    // graceful 503 {error, reason} so the modal shows "try again", not a 502.
    if (timedOut) {
      return c.json(
        { error: 'ocr_timeout', reason: errorMsg ?? 'OCR timed out. Please try again.', sampleId, imageKey, receiptImageKey },
        503,
      );
    }
    return c.json(
      { error: 'extract_failed', reason: errorMsg ?? 'Extraction failed.', sampleId, imageKey, receiptImageKey },
      502,
    );
  }

  // Phone normalisation + geocode enrichment + catalog-bound validation —
  // postProcessSlip, shared with the background job.
  const warnings = await postProcessSlip(parsed, sb, c.env.GOOGLE_MAPS_API_KEY, catalog);

  // Duplicate-upload warning — shared findDuplicateSo (same rules as the
  // background job: recent same-photo sha256, or same phone + same slip
  // ref / same slip date+total). Cheap indexed lookups; fail-soft null.
  const duplicate = await findDuplicateSo(svc, { imageSha256, excludeSampleId: sampleId, parsed });

  return c.json({
    success: true,
    data: {
      sampleId,
      // Suspected re-upload: { docNo, rule: 'image' | 'content' } of the SO
      // this slip already became, else null. The modal can warn the operator
      // before they create a second order.
      duplicate,
      // Original-slip R2 key (null when the upload was a PDF or the put
      // failed). The modal carries it onto the New SO create body.
      imageKey,
      // Payment-receipt R2 key (null when no receipt was uploaded / classified
      // or the put failed). Carried onto the New SO create body alongside.
      receiptImageKey,
      extracted: parsed,
      warnings,
      // Slim catalog so the modal's SKU/fabric pickers work without a second
      // round-trip. `options` = the SO Maintenance allowed-values lists the
      // matches were validated against (feeds the modal's review selects).
      // `states` = the my_localities state list the addressStateMatch was
      // validated against (the modal carries the matched state to the form).
      catalog: {
        skus: catalog.skus,
        fabrics: catalog.fabrics,
        options: catalog.options,
        states: catalog.states,
      },
      meta: {
        cacheHit,
        cacheCreated,
        files: fileCount,
        sampleInsertError,
        repRules: inj.repRulesMeta,
        sharedAliases: inj.globalAliasApplied,
        sharedRules: inj.globalRulesApplied,
      },
    },
  });
});

// ===========================================================================
// TRUE BACKGROUND SCAN JOB (owner 2026-07-04): the rep photographs the slip,
// POSTs /scan-so/enqueue, and can CLOSE THE APP — the OCR + DRAFT-SO create
// finish server-side inside ctx.waitUntil and the result lands in
// scm.scan_jobs (migration 0067) for the mobile Scan screen to poll.
//
//   POST /scan-so/enqueue        — same multipart inputs as /extract (image
//                                  file(s) + salesperson). Persists the photos
//                                  (R2, scan-jobs/{jobId}/{n}) + the job row,
//                                  responds { job_id, status: "queued" }
//                                  IMMEDIATELY, then runs the pipeline in
//                                  waitUntil (single Claude vision call — fits
//                                  Workers' waitUntil budget; no extra retries
//                                  beyond anthropicFetchWithRetry).
//   GET  /scan-so/jobs/:id       — poll one job (status / soDocNo / error).
//   GET  /scan-so/jobs?salesperson= — latest 20 jobs (optionally one rep's).
//   POST /scan-so/jobs/clear-failed — delete the caller's failed jobs (mobile
//                                  "Clear" button; self-scoped by normalized
//                                  rep name, wildcard '*' clears all).
//
// Both poll endpoints also run the stale-job reaper: a job stuck
// queued/running >10 min (a Worker deploy kills in-flight waitUntil work) is
// RE-RUN once from its durable R2 photos (retry_count 0 → 1, migration 0070)
// and only errored once that single retry is spent.
//
// The pipeline calls the EXACT machinery /extract uses (loadCatalog,
// buildCachedPrefix, loadPromptInjections, callClaudeSlipExtract,
// insertScanSample, storeScanImages, postProcessSlip) — shared functions, not
// copies — then creates the DRAFT SO through mfg-sales-orders'
// createDraftSalesOrder (the factored PRICING-CRITICAL create core; never
// reimplemented here). /extract stays untouched as the client-driven fallback.
// ===========================================================================
const SCAN_JOBS_MISSING_MSG =
  'scan-jobs table missing — apply src/db/migrations-pg/0067_scm_scan_jobs.sql to this database.';

// Plain-language job failures (standing rule: user-facing error = one plain
// sentence, never a raw exception / status code — those go to console.error).
const JOB_MSG = {
  fallback: 'Something went wrong while processing the scan. Please enter this order manually.',
  noKey: 'Scanning is not set up on the server yet. Please enter this order manually.',
  timeout: 'Reading the slip took too long. Please try scanning again.',
  unreadable: 'The slip photo could not be read. Please retake the photo and try again.',
  createFallback: 'The draft order could not be created. Please enter this order manually.',
} as const;

// Snake/camel-tolerant job row -> API shape (dual-read both casings — the #1
// recurring result-column bug class).
function jobToJson(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    salesperson: r.salesperson ?? null,
    soDocNo: r.soDocNo ?? r.so_doc_no ?? null,
    error: r.error ?? null,
    sampleId: r.sampleId ?? r.sample_id ?? null,
    // Duplicate-upload warning (migration 0068) — doc_no of the suspected
    // original SO; the mobile Scan screen surfaces it on the job card.
    duplicateOf: r.duplicateOf ?? r.duplicate_of ?? null,
    imageKeys: r.imageKeys ?? r.image_keys ?? [],
    createdAt: r.createdAt ?? r.created_at ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Duplicate-upload detection (owner 2026-07-04: 重复上传预警 / "已经开过单").
// Runs BEFORE the DRAFT create in the background pipeline (and in /extract for
// the interactive path). Two rules, cheapest first:
//   A) IMAGE  — the first uploaded photo's sha256 matches a so_scan_samples
//      row from the last 30 days whose background scan job already minted an
//      SO (so_scan_samples.image_sha256 -> scan_jobs.sample_id/so_doc_no; both
//      indexed by migration 0068).
//   B) CONTENT — an existing non-cancelled SO carries the SAME normalized
//      customer phone AND (the same customer SO ref [slip serial,
//      case-insensitive] OR the same slip date [so_date] + the same grand
//      total). Phone equality uses the exact E.164 form the create path
//      stores (normalizePhone), the same probe the cross-category auto-match
//      runs on every customer change (mfg-sales-orders ~4196).
// A suspected duplicate NEVER blocks the draft — the owner reviews. Callers
// prefix the SO note with "POSSIBLE DUPLICATE of <doc_no>" and stamp
// scan_jobs.duplicate_of (migration 0068). Fail-soft: any query error just
// skips the warning.
// ---------------------------------------------------------------------------
const DUP_LOOKBACK_DAYS = 30;

// Rule A core — the ONE image-hash lookup, shared by findDuplicateSo (the
// soft warning inside /extract and the background job) AND the synchronous
// hard reject in POST /enqueue (owner 2026-07-04 policy change: an exact slip
// re-upload is refused at upload time, before anything is queued). "Has this
// exact photo (sha256) already been scanned into an SO within the last
// DUP_LOOKBACK_DAYS?" — two indexed queries (so_scan_samples.image_sha256 ->
// scan_jobs.sample_id/so_doc_no, both indexed by migration 0068). THROWS on a
// query error so each caller picks its own fail-open behaviour: the soft path
// warns + skips the flag, the /enqueue path queues normally.
async function findRecentSoForSlipSha(
  svc: SupabaseClient,
  imageSha256: string,
  // The sample the CURRENT scan just inserted — excluded or every scan would
  // "duplicate" itself. null when nothing has been inserted yet (/enqueue).
  excludeSampleId: string | null,
): Promise<string | null> {
  const since = new Date(Date.now() - DUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let q = svc
    .from('so_scan_samples')
    .select('id')
    .eq('image_sha256', imageSha256)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10);
  if (excludeSampleId) q = q.neq('id', excludeSampleId);
  const { data: sampleRows, error: sampleErr } = await q;
  if (sampleErr) throw new Error(sampleErr.message);
  const sampleIds = (((sampleRows as Array<Record<string, unknown>> | null) ?? [])
    .map((r) => r.id)
    .filter((v): v is string => typeof v === 'string' && v !== ''));
  if (sampleIds.length === 0) return null;
  const { data: jobRows, error: jobErr } = await svc
    .from('scan_jobs')
    .select('so_doc_no, created_at')
    .in('sample_id', sampleIds)
    .not('so_doc_no', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (jobErr) throw new Error(jobErr.message);
  const row = ((jobRows as Array<Record<string, unknown>> | null) ?? [])[0];
  const doc = (row?.soDocNo ?? row?.so_doc_no) as string | undefined;
  return typeof doc === 'string' && doc !== '' ? doc : null;
}

async function findDuplicateSo(
  svc: SupabaseClient,
  args: {
    imageSha256: string | null;
    // The sample THIS scan just inserted — excluded or every scan would
    // "duplicate" itself.
    excludeSampleId: string | null;
    parsed: ExtractedSlip | null;
  },
): Promise<{ docNo: string; rule: 'image' | 'content' } | null> {
  // A) Same slip photo already processed into an SO recently — the shared
  //    findRecentSoForSlipSha core (also the /enqueue hard-reject probe).
  try {
    if (args.imageSha256) {
      const doc = await findRecentSoForSlipSha(svc, args.imageSha256, args.excludeSampleId);
      if (doc) return { docNo: doc, rule: 'image' };
    }
  } catch (e) {
    console.warn('[scan-so dup] image check failed:', (e as Error).message);
  }

  // B) Same phone + (same slip serial OR same slip date + same total).
  try {
    const parsed = args.parsed;
    // parsed.phones are already national-significant digits (postProcessSlip).
    const phoneNat = (parsed?.phones?.[0] ?? '').replace(/\s+/g, '');
    if (parsed && phoneNat) {
      const storedPhone = normalizePhone(`+60${phoneNat}`) ?? `+60${phoneNat}`;
      const ref = (parsed.customerSoRef ?? '').trim().toUpperCase();
      const slipDate = /^\d{4}-\d{2}-\d{2}$/.test((parsed.processingDate ?? '').trim())
        ? (parsed.processingDate as string).trim()
        : null;
      const totalCenti = typeof parsed.totalRm === 'number' && parsed.totalRm > 0
        ? Math.round(parsed.totalRm * 100)
        : null;
      // Nothing comparable beyond the phone alone → phone-only would be far
      // too noisy (repeat customers are normal); skip.
      if (ref || (slipDate && totalCenti != null)) {
        const { data } = await svc
          .from('mfg_sales_orders')
          .select('doc_no, customer_so_no, so_date, total_revenue_centi')
          .eq('phone', storedPhone)
          .neq('status', 'CANCELLED')
          .order('created_at', { ascending: false })
          .limit(25);
        for (const r of ((data as Array<Record<string, unknown>> | null) ?? [])) {
          const doc = (r.docNo ?? r.doc_no) as string | undefined;
          if (typeof doc !== 'string' || doc === '') continue;
          const candRef = String(r.customerSoNo ?? r.customer_so_no ?? '').trim().toUpperCase();
          if (ref && candRef && candRef === ref) return { docNo: doc, rule: 'content' };
          const candDate = String(r.soDate ?? r.so_date ?? '').slice(0, 10);
          const candTotal = Number(r.totalRevenueCenti ?? r.total_revenue_centi ?? NaN);
          if (slipDate && totalCenti != null && candDate === slipDate && candTotal === totalCenti) {
            return { docNo: doc, rule: 'content' };
          }
        }
      }
    }
  } catch (e) {
    console.warn('[scan-so dup] content check failed:', (e as Error).message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payment rows from receipt OCR (owner 2026-07-04: "OCR Payment detect 不到").
// The background draft used to carry only the payment HEADER fields, so the
// operator opened the draft and saw NO payment. After the DRAFT SO is created,
// every uploaded image Claude classified `payment_receipt` now becomes a
// payments-ledger row through mfg-sales-orders' recordSoPaymentRow — the SAME
// factored insert+audit core the interactive POST /:docNo/payments route uses
// (payment field derivation / Account Sheet auto-fill never reimplemented
// here). Amounts are CONSERVATIVE: the OCR extracts ONE payment field set per
// scan (not one per receipt), so the FIRST receipt carries the slip/receipt
// deposit (depositRm — read preferentially from the printed receipt) and any
// further receipt books at 0 with a "please verify" note. The receipt's
// existing R2 object (scan-jobs/{jobId}/{n} — SO_ITEM_PHOTOS, the same
// physical houzs-erp bucket the payment slip presigner serves) is REFERENCED
// as the payment slip; no copy. Never fails the job: the caller logs + notes.
// ---------------------------------------------------------------------------

// Slip payment header -> ledger method vocabulary. Mirrors the interactive
// client's mapping (MobileNewSO PAY_METHOD_CODE + its scan prefill, which
// folds a legacy 'Installment' L1 into Merchant): Merchant -> 'merchant' (+
// bank + plan months), Online -> 'transfer' (+ online type), Cash -> 'cash'.
// No/unknown method match -> 'merchant' (a printed card-terminal receipt IS a
// Merchant transaction), flagged `guessed` so the row's note says so.
function ledgerMethodFromSlip(parsed: ExtractedSlip): {
  method: 'merchant' | 'transfer' | 'cash';
  merchantProvider: string | null;
  installmentMonths: number | null;
  onlineType: string | null;
  guessed: boolean;
} {
  // 'One Shot' -> null; 'N months' -> N (same planToMonths rule as the
  // client and buildDraftSoBodyFromSlip).
  const planLabel = (parsed.installmentPlanMatch?.value ?? '').trim();
  const planMonthsMatch = /^(\d+)\s*month/i.exec(planLabel);
  const planMonths = planMonthsMatch ? Number(planMonthsMatch[1]) : null;
  const raw = (parsed.paymentMethodMatch?.value ?? '').trim().toLowerCase();
  if (raw === 'cash') {
    return { method: 'cash', merchantProvider: null, installmentMonths: null, onlineType: null, guessed: false };
  }
  if (raw === 'online') {
    return {
      method: 'transfer',
      merchantProvider: null,
      installmentMonths: null,
      onlineType: parsed.onlineTypeMatch?.value ?? null,
      guessed: false,
    };
  }
  // 'Merchant', legacy 'Installment', or nothing readable (guessed).
  return {
    method: 'merchant',
    merchantProvider: parsed.bankMatch?.value ?? null,
    installmentMonths: planMonths,
    onlineType: null,
    guessed: raw !== 'merchant' && raw !== 'installment',
  };
}

async function recordScanReceiptPayments(
  svc: SupabaseClient,
  args: {
    docNo: string;
    jobId: string;
    parsed: ExtractedSlip;
    uploadedImages: UploadedImage[];
    // scan-jobs/{jobId}/{n} keys whose R2 put SUCCEEDED at enqueue time.
    storedImageKeys: string[];
    // storeScanImages' receipt copy (scan-slips/{sampleId}-receipt) — the
    // fallback slip reference when the enqueue-time put failed.
    receiptImageKey: string | null;
    salespersonId: string;
    salespersonName: string | null;
  },
): Promise<{ recorded: number; failed: number; skippedDuplicate: number }> {
  const { parsed } = args;
  // Which uploaded IMAGES are receipts — the model's own classification only.
  // storeScanImages' positional fallback is intentionally NOT applied here:
  // booking money off an unclassified photo would be a guess; the operator
  // can still add the payment on the draft.
  const seen = new Set<number>();
  const receiptIdxs: number[] = [];
  for (const img of parsed.images) {
    if (img.kind !== 'payment_receipt' || seen.has(img.index)) continue;
    seen.add(img.index);
    if (args.uploadedImages.some((u) => u.index === img.index)) receiptIdxs.push(img.index);
  }
  if (receiptIdxs.length === 0) return { recorded: 0, failed: 0, skippedDuplicate: 0 };

  // Double-book guard. The create core books its own is_deposit ledger row
  // for the POS vocabulary (lowercase methods) — the scan draft's header
  // method is a dropdown VALUE ('Merchant'/'Online'/'Cash') so it never
  // matches today, but if the SO somehow already carries a payment row,
  // recording again would double count. Skip + surface a plain note (owner
  // 2026-07-04: "A matching payment was already recorded") instead.
  const { data: existingRows, error: existingErr } = await svc
    .from('mfg_sales_order_payments')
    .select('id')
    .eq('so_doc_no', args.docNo)
    .limit(1);
  if (existingErr) {
    console.error('[scan-job] payment pre-check failed:', args.docNo, existingErr.message);
    return { recorded: 0, failed: receiptIdxs.length, skippedDuplicate: 0 };
  }
  if (((existingRows as unknown[] | null) ?? []).length > 0) {
    console.warn('[scan-job] SO already has payment rows — skipping receipt payments:', args.docNo);
    return { recorded: 0, failed: 0, skippedDuplicate: receiptIdxs.length };
  }

  const m = ledgerMethodFromSlip(parsed);
  const depositCenti = typeof parsed.depositRm === 'number' && parsed.depositRm > 0
    ? Math.round(parsed.depositRm * 100)
    : 0;
  // Payment date = the slip/order date when readable, else today (MYT).
  // SANITY CLAMP (evidence 2026-07: the OCR invented years — "2015-09-17" /
  // "2019-12-17" for a current slip — which would book the money YEARS in the
  // past): only trust a slip date within a plausible window (up to 60 days
  // back, 7 days forward); anything outside books at today instead.
  const paidAt = (() => {
    const d = (parsed.processingDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return todayMyt();
    const t = Date.parse(`${d}T00:00:00Z`);
    if (!Number.isFinite(t)) return todayMyt();
    const now = Date.now();
    const dayMs = 86_400_000;
    if (t < now - 60 * dayMs || t > now + 7 * dayMs) return todayMyt();
    return d;
  })();

  // Receipt dedup ACROSS SOs (owner 2026-07-04 policy change: never book
  // money off a receipt image that already backs a payment row on ANY order).
  // Receipt sha256s are not stored anywhere today, so a true image-hash match
  // would mean fetching + re-hashing every prior job's R2 objects inside
  // waitUntil — too heavy. Two CHEAP probes instead, both fail-OPEN (a query
  // error just books normally):
  //   1) R2 key lineage — a payment row already references this job's
  //      scan-jobs/{jobId}/{idx} object (a re-run of the same job).
  //   2) Transaction fingerprint — a payment row on ANY SO already carries
  //      this receipt's approval code AND the same amount. A re-photographed
  //      receipt gets a different R2 key and a different sha256 (JPEG
  //      re-encode), but the PRINTED approval code is per-transaction — the
  //      cheapest honest equivalent of the image match.
  const alreadyBookedKeys = new Set<string>();
  try {
    const candidateKeys = receiptIdxs.map((idx) => `scan-jobs/${args.jobId}/${idx}`);
    const { data: lineageRows, error: lineageErr } = await svc
      .from('mfg_sales_order_payments')
      .select('slip_key')
      .in('slip_key', candidateKeys);
    if (lineageErr) {
      console.warn('[scan-job] payment key-lineage check failed:', lineageErr.message);
    } else {
      for (const r of ((lineageRows as Array<Record<string, unknown>> | null) ?? [])) {
        const k = (r.slipKey ?? r.slip_key) as string | undefined;
        if (typeof k === 'string' && k !== '') alreadyBookedKeys.add(k);
      }
    }
  } catch (e) {
    console.warn('[scan-job] payment key-lineage check threw:', (e as Error).message);
  }
  const approvalCode = (parsed.approvalCode ?? '').trim();
  let fingerprintDup = false;
  if (approvalCode && depositCenti > 0) {
    try {
      const { data: fpRows, error: fpErr } = await svc
        .from('mfg_sales_order_payments')
        .select('id')
        .eq('approval_code', approvalCode)
        .eq('amount_centi', depositCenti)
        .limit(1);
      if (fpErr) console.warn('[scan-job] payment fingerprint check failed:', fpErr.message);
      else if ((((fpRows as unknown[] | null) ?? []).length > 0)) fingerprintDup = true;
    } catch (e) {
      console.warn('[scan-job] payment fingerprint check threw:', (e as Error).message);
    }
  }

  let recorded = 0;
  let failed = 0;
  let skippedDuplicate = 0;
  for (let i = 0; i < receiptIdxs.length; i += 1) {
    const idx = receiptIdxs[i];
    const first = i === 0;
    // Prefer REFERENCING the durable enqueue-time copy (same bucket the slip
    // presigner serves); fall back to the provenance receipt copy.
    const jobKey = `scan-jobs/${args.jobId}/${idx}`;
    // A receipt that already backs a payment row books NOTHING — the caller
    // appends the plain "matching payment already recorded" note instead.
    // The fingerprint only vouches for the FIRST receipt (the only one that
    // carries the OCR'd amount + approval code); extras book their 0-amount
    // "please verify" rows as usual.
    if (alreadyBookedKeys.has(jobKey) || (first && fingerprintDup)) {
      skippedDuplicate += 1;
      console.warn('[scan-job] receipt already booked — skipped:', args.docNo, jobKey);
      continue;
    }
    const slipKey = args.storedImageKeys.includes(jobKey)
      ? jobKey
      : (first ? args.receiptImageKey : null);
    // Conservative amounts: first receipt = the OCR'd deposit; anything the
    // OCR could not read books at 0 with a plain "please verify" note.
    const amountCenti = first ? depositCenti : 0;
    const noteParts = ['Recorded from scanned payment receipt'];
    if (first && amountCenti === 0) noteParts.push('amount could not be read — please verify');
    if (!first) noteParts.push('extra receipt — amount not read, please verify');
    if (m.guessed) noteParts.push('method not read — assumed card terminal (Merchant)');
    try {
      const { errorMessage } = await recordSoPaymentRow(svc, {
        docNo: args.docNo,
        paidAt,
        method: m.method,
        merchantProvider: m.merchantProvider,
        installmentMonths: m.installmentMonths,
        onlineType: m.onlineType,
        approvalCode: first ? ((parsed.approvalCode ?? '').trim() || null) : null,
        amountCenti,
        slipKey,
        collectedBy: args.salespersonId,
        note: noteParts.join('; '),
        createdBy: args.salespersonId,
        actorName: args.salespersonName,
        // The first receipt row IS the header deposit — is_deposit stops the
        // list/detail paid-rollup adding the header deposit_centi on top of
        // this ledger row (double count).
        isDeposit: first,
        auditSource: 'automation',
        auditNote: 'Auto: payment recorded from scanned receipt (background scan job)',
      });
      if (errorMessage) {
        failed += 1;
        console.error('[scan-job] receipt payment insert failed:', args.docNo, errorMessage);
      } else {
        recorded += 1;
      }
    } catch (e) {
      failed += 1;
      console.error('[scan-job] receipt payment threw:', args.docNo, (e as Error).message);
    }
  }
  return { recorded, failed, skippedDuplicate };
}

// Extracted slip -> DRAFT SO create body. Mirrors the SHIPPED headless client
// mapping (MobileScan buildPrefill + MobileNewSO createDraftFromPrefill):
// same header fields, same "+60" phone re-attachment, same named-line filter,
// same itemGroup 'others' + null dates (the operator finishes category /
// variants / payments when reviewing the draft). Additions the client flow
// showed on screen instead: the verbatim slip row / fabric code / OCR notes
// ride in the line remark, and the reparseSpec-hardened bedframe numbers seed
// the divanHeight/legHeight/gap variant keys so nothing OCR'd is lost.
// Validated option values (customerType / buildingType / state / venue /
// payment fields) come straight from validateSlip's catalog-bound matches, so
// the create handler's own dropdown re-validation accepts them.
function buildDraftSoBodyFromSlip(
  parsed: ExtractedSlip,
  catalog: Catalog,
  keys: { imageKey: string | null; receiptImageKey: string | null },
): { body: Record<string, unknown> | null; missing: string[] } {
  const missing: string[] = [];
  const customerName = (parsed.customerName ?? '').trim();
  if (!customerName) missing.push('customer name');
  // parsed.phones are already national-significant digits (postProcessSlip).
  const mainPhone = (parsed.phones[0] ?? '').trim();
  if (!mainPhone) missing.push('phone number');
  if (missing.length > 0) return { body: null, missing };

  const skuByCode = new Map(catalog.skus.map((s) => [s.code.toUpperCase(), s]));
  const items: Array<Record<string, unknown>> = [];
  for (const l of parsed.lines ?? []) {
    const code = l.skuMatch?.code ?? '';
    const sku = code ? skuByCode.get(code.toUpperCase()) : undefined;
    // Matched SKU name, else the raw slip text (same seed the client used) —
    // a line counts once it has a name or a matched code (drops blank rows).
    const name = (sku?.name ?? l.rawText ?? '').trim();
    if (!name && !sku) continue;
    const remarkParts: string[] = [];
    if (sku && (l.rawText ?? '').trim() && (l.rawText ?? '').trim() !== name) {
      remarkParts.push(`Slip: ${(l.rawText ?? '').trim()}`);
    }
    if (l.fabricMatch?.code) remarkParts.push(`Fabric: ${l.fabricMatch.code}`);
    if (l.specialsMatch.length > 0) remarkParts.push(`Specials: ${l.specialsMatch.map((s) => s.code).join(', ')}`);
    if (l.notes) remarkParts.push(l.notes);
    const variants: Record<string, unknown> = {};
    if (remarkParts.length > 0) variants.remark = remarkParts.join(' | ');
    // Bedframe numbers (reparseSpec-overruled) -> the same inch-string variant
    // keys the New SO form writes, so the draft's line editor seeds correctly.
    if (l.divanHeightInches != null) variants.divanHeight = `${l.divanHeightInches}"`;
    if (l.noLeg) variants.legHeight = '0"';
    else if (l.legHeightInches != null) variants.legHeight = `${l.legHeightInches}"`;
    if (l.gapInches != null) variants.gap = `${l.gapInches}"`;
    items.push({
      itemCode: sku?.code ?? '',
      // 'others' mirrors the shipped headless client (category-specific
      // machinery — sofa split, variant gates — is the operator's review
      // step, not the background draft's).
      itemGroup: 'others',
      description: name,
      qty: l.qtyGuess > 0 ? l.qtyGuess : 1,
      unitPriceCenti: Math.round(Math.max(0, l.priceRmGuess ?? 0) * 100),
      lineDeliveryDate: null,
      ...(Object.keys(variants).length > 0 ? { variants } : {}),
    });
  }

  // 'One Shot' -> null (no installment term); 'N months' -> N (the client's
  // planToMonths rule).
  const planLabel = parsed.installmentPlanMatch?.value ?? '';
  const planMonthsMatch = /^(\d+)\s*month/i.exec(planLabel.trim());
  const planMonths = planMonthsMatch ? Number(planMonthsMatch[1]) : null;
  const paymentMethod = parsed.paymentMethodMatch?.value ?? null;

  // NOTHING OCR'D IS LOST: fields the model extracted but the draft has no
  // dedicated column for ride in the header note (the draft intentionally
  // nulls the delivery-date columns — "1 month notice" isn't a date — and the
  // slip's written grand total is the operator's cross-check against the line
  // prices, which mostly arrive unpriced).
  const noteParts: string[] = [];
  const remarkNote = (parsed.remarks ?? '').trim();
  if (remarkNote) noteParts.push(remarkNote);
  const slipDelivery = (parsed.deliveryDate ?? '').trim();
  if (slipDelivery) noteParts.push(`Slip delivery: ${slipDelivery}`);
  if (typeof parsed.totalRm === 'number' && parsed.totalRm > 0) {
    noteParts.push(`Slip total: RM${parsed.totalRm}`);
  }

  const body: Record<string, unknown> = {
    customerName,
    debtorName: customerName,
    customerSoNo: (parsed.customerSoRef ?? '').trim() || null,
    phone: `+60${mainPhone.replace(/\s+/g, '')}`,
    customerType: parsed.customerTypeMatch?.value ?? null,
    buildingType: parsed.buildingTypeMatch?.value ?? null,
    note: noteParts.length > 0 ? noteParts.join(' | ') : null,
    address1: (parsed.addressLine1 ?? parsed.address ?? '').trim() || null,
    customerState: parsed.addressStateMatch?.value ?? null,
    city: (parsed.city ?? '').trim() || null,
    postcode: (parsed.postcode ?? '').trim() || null,
    // DRAFT: no dates (the interactive "Save draft" nulls these too).
    internalExpectedDd: null,
    customerDeliveryDate: null,
    emergencyContactPhone: (parsed.phones[1] ?? '').trim()
      ? `+60${(parsed.phones[1] ?? '').replace(/\s+/g, '')}`
      : null,
    // Validated venue only — free-text slip location would bypass the venue
    // master; when null the create core's venue-by-active-project autofill
    // resolves it from the salesperson's current exhibition project.
    venue: parsed.locationMatch?.value ?? null,
    // Payment header fields (validated matches; the operator reviews the
    // draft before it becomes a real order). No payments[] in the create
    // body — the ledger rows are booked AFTER the create by
    // recordScanReceiptPayments (one per classified payment receipt),
    // through the same recordSoPaymentRow core the interactive
    // POST /:docNo/payments route uses.
    paymentMethod,
    merchantProvider: paymentMethod === 'Merchant' ? (parsed.bankMatch?.value ?? null) : null,
    installmentMonths: planMonths,
    approvalCode: (parsed.approvalCode ?? '').trim() || null,
    depositCenti: parsed.depositRm && parsed.depositRm > 0 ? Math.round(parsed.depositRm * 100) : 0,
    // Provenance — the SO detail page serves these back as Order Slip /
    // Payment Receipt proof (same keys the interactive flow carries).
    slipImageKey: keys.imageKey,
    receiptImageKey: keys.receiptImageKey,
    // The whole point: land as DRAFT for the operator to review.
    asDraft: true,
    items,
  };
  return { body, missing: [] };
}

// The waitUntil pipeline — runs AFTER /enqueue has responded. Every failure
// path marks the job 'error' with a SHORT plain-language message (raw details
// go to console.error only). Single Claude vision call; no retries beyond the
// shared anthropicFetchWithRetry, keeping the whole run inside Workers'
// waitUntil budget.
async function runScanJob(
  env: Env,
  job: {
    id: string;
    salesperson: string;
    salespersonId: string;
    salespersonName: string | null;
    houzsUserId: number | null;
    fileBlocks: ContentBlock[];
    uploadedImages: UploadedImage[];
    firstBuffer: ArrayBuffer | null;
    // scan-jobs/{jobId}/{n} keys whose enqueue-time R2 put succeeded — the
    // receipt-payment rows reference these as their slip proof.
    imageKeys: string[];
  },
): Promise<void> {
  const svc = serviceClient(env);
  const touch = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      const { error } = await svc
        .from('scan_jobs')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', job.id);
      if (error) console.error('[scan-job] job update failed:', job.id, error.message);
    } catch (e) {
      console.error('[scan-job] job update threw:', job.id, (e as Error).message);
    }
  };
  const fail = async (plainMsg: string): Promise<void> => {
    await touch({ status: 'error', error: plainMsg });
  };

  try {
    await touch({ status: 'running' });
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('[scan-job] ANTHROPIC_API_KEY missing');
      return await fail(JOB_MSG.noKey);
    }

    // EXACT /extract machinery, service-client flavoured (no request scope in
    // waitUntil; catalog reads are the same data RLS shows any signed-in
    // operator — same precedent as warmCatalogCacheForCron).
    const catalog = await loadCatalog(svc);
    const branding = await getBranding(env);
    const cachedPrefix = buildCachedPrefix(catalog, branding.companyName);
    const inj = await loadPromptInjections(svc, job.salesperson);
    const call = await callClaudeSlipExtract(apiKey, cachedPrefix, inj, job.fileBlocks);
    const parsed = call.parsed;

    // Learning pool + slip/receipt provenance — identical to /extract.
    const imageSha256 = job.firstBuffer ? await sha256Hex(job.firstBuffer) : null;
    const sampleSalesperson = job.salesperson || normalizeRepKey(parsed?.salesRep) || null;
    const { sampleId } = await insertScanSample(svc, {
      imageSha256,
      salesperson: sampleSalesperson,
      parsed,
      errorMsg: call.errorMsg,
      claudeText: call.claudeText,
    });
    if (sampleId) await touch({ sample_id: sampleId });
    const { imageKey, receiptImageKey } = await storeScanImages(
      env.SO_ITEM_PHOTOS, svc, sampleId, job.uploadedImages, parsed,
    );

    if (!parsed) {
      console.error('[scan-job] extraction failed:', job.id, call.errorMsg);
      return await fail(call.timedOut ? JOB_MSG.timeout : JOB_MSG.unreadable);
    }

    await postProcessSlip(parsed, svc, env.GOOGLE_MAPS_API_KEY, catalog);

    // TOTALLY-EMPTY extraction (evidence 2026-07: two prod samples came back
    // with every field null and zero lines — a blank/unreadable photo, not a
    // slip the model half-read). Tell the rep to retake instead of the
    // misleading "could not read the customer name and phone" message.
    if (!parsed.customerName && parsed.phones.length === 0 && parsed.lines.length === 0) {
      return await fail('Nothing could be read from the photo. Please retake a clearer, well-lit photo of the whole slip.');
    }

    // Duplicate-upload warning (owner: 重复上传预警) — same photo scanned
    // again recently, or the same customer/slip already has an SO. The DRAFT
    // is STILL created for review; the flag rides on the job row (mobile
    // surfaces it) and the SO note is prefixed below. Fail-soft throughout.
    const dup = await findDuplicateSo(svc, { imageSha256, excludeSampleId: sampleId, parsed });
    if (dup) await touch({ duplicate_of: dup.docNo });

    const draft = buildDraftSoBodyFromSlip(parsed, catalog, { imageKey, receiptImageKey });
    if (!draft.body) {
      return await fail(
        `The scan could not read the ${draft.missing.join(' and ')} on the slip. Please enter this order manually.`,
      );
    }
    if (dup) {
      const existingNote = typeof draft.body.note === 'string' && draft.body.note.trim() !== ''
        ? ` | ${draft.body.note}`
        : '';
      draft.body.note = `POSSIBLE DUPLICATE of ${dup.docNo}${existingNote}`;
    }

    // PRICING-CRITICAL create — the factored mfg-sales-orders core, replayed
    // with the identities captured at enqueue time. Never reimplemented here.
    const outcome = await createDraftSalesOrder(env, {
      salespersonId: job.salespersonId,
      salespersonName: job.salespersonName,
      houzsUserId: job.houzsUserId,
      body: draft.body,
    });
    const docNo = (outcome.body as { docNo?: unknown }).docNo;
    if (outcome.status === 201 && typeof docNo === 'string' && docNo !== '') {
      // Payments from receipt OCR — one ledger row per classified payment
      // receipt, via the SAME recordSoPaymentRow core the interactive route
      // uses. GUARD: never fail the job — the DRAFT stands; a failure only
      // appends a plain note (job stays done with so_doc_no).
      let paymentNote: string | null = null;
      try {
        const pay = await recordScanReceiptPayments(svc, {
          docNo,
          jobId: job.id,
          parsed,
          uploadedImages: job.uploadedImages,
          storedImageKeys: job.imageKeys,
          receiptImageKey,
          salespersonId: job.salespersonId,
          salespersonName: job.salespersonName,
        });
        if (pay.failed > 0) {
          paymentNote = 'Draft created; the payment could not be recorded — please add it on the order.';
        } else if (pay.skippedDuplicate > 0) {
          // Receipt dedup fired — the money row already exists somewhere, so
          // nothing was booked twice. Plain note per the standing rule.
          paymentNote = 'A matching payment was already recorded, so it was not added again.';
        }
      } catch (e) {
        console.error('[scan-job] receipt payment recording threw:', job.id, (e as Error).message);
        paymentNote = 'Draft created; the payment could not be recorded — please add it on the order.';
      }
      await touch({
        status: 'done',
        so_doc_no: docNo,
        ...(paymentNote ? { error: paymentNote } : {}),
      });
      return;
    }
    console.error(
      '[scan-job] draft create rejected:', job.id, outcome.status,
      JSON.stringify(outcome.body).slice(0, 600),
    );
    // The create core's rejection reasons are already plain sentences (the
    // plain-language-errors standard); fall back to a generic one otherwise.
    const reason =
      typeof outcome.body.reason === 'string' ? outcome.body.reason
      : typeof outcome.body.message === 'string' ? outcome.body.message
      : JOB_MSG.createFallback;
    await fail(reason);
  } catch (e) {
    console.error('[scan-job] pipeline threw:', job.id, e);
    await fail(JOB_MSG.fallback);
  }
}

// ---------------------------------------------------------------------------
// POST /scan-so/enqueue — persist photos + job row, respond FAST, run the
// pipeline in waitUntil. Same multipart contract as /extract.
// ---------------------------------------------------------------------------
scanSo.post('/enqueue', async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return c.json({ error: 'bad_request', reason: `Invalid multipart body: ${(e as Error).message}` }, 400);
  }
  const filesRes = await parseScanFiles(formData);
  if (!filesRes.ok) {
    return c.json({ error: 'bad_request', reason: filesRes.reason }, 400);
  }
  const { fileBlocks, uploadedImages, allFiles, firstBuffer } = filesRes.parsed;
  const repGiven = normalizeRepKey(formData.get('salesperson'));

  // Identities captured while the request is still authed — replayed into the
  // headless SO create. user.id = scm.staff UUID (the SCM bridge identity);
  // houzsUser.id = public users bigint (venue-by-project autofill). Never mix
  // the two (staff-UUID vs bigint trap).
  const user = c.get('user');
  const houzsUser = c.get('houzsUser');
  const houzsUserId =
    houzsUser?.id != null && Number.isFinite(Number(houzsUser.id)) ? Number(houzsUser.id) : null;
  const salespersonName =
    ((user.user_metadata as { name?: string } | undefined)?.name ?? '').trim() || repGiven || null;

  const svc = serviceClient(c.env);

  // 0) HARD REJECT on an exact re-upload (owner 2026-07-04 policy change:
  //    image-hash duplicate = refuse AT UPLOAD, nothing queued). sha256 the
  //    FIRST file (the order slip — the mobile client appends it first) and
  //    run the same 30-day slip-hash -> SO lookup findDuplicateSo rule A uses
  //    (findRecentSoForSlipSha — shared core, not a copy). Synchronous so the
  //    rep hears "already uploaded" on the spot instead of finding a second
  //    draft later. Fail-OPEN: if the lookup itself errors we queue normally
  //    and the background job's soft duplicate warning still applies. Rule B
  //    (same phone + same slip serial / date+total) intentionally STAYS a
  //    soft warning inside the job — a genuine repeat order is legal.
  if (firstBuffer) {
    try {
      const dupDocNo = await findRecentSoForSlipSha(svc, await sha256Hex(firstBuffer), null);
      if (dupDocNo) {
        return c.json(
          { error: 'duplicate_slip', reason: `This slip was already uploaded — it created ${dupDocNo}.` },
          409,
        );
      }
    } catch (e) {
      console.warn('[scan-so enqueue] duplicate check failed (queuing anyway):', (e as Error).message);
    }
  }

  // 1) Job row FIRST — the durable record the phone can poll even if it
  //    disconnects the instant this response is sent.
  const { data: jobRow, error: jobErr } = await svc
    .from('scan_jobs')
    .insert({
      status: 'queued',
      salesperson: repGiven || null,
      salesperson_id: user.id,
      houzs_user_id: houzsUserId,
      image_keys: [],
    })
    .select('id')
    .single();
  const jobId = (jobRow as { id?: string } | null)?.id ?? null;
  if (jobErr || !jobId) {
    if (jobErr && isMissingTable(jobErr)) {
      return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    }
    console.error('[scan-so enqueue] job insert failed:', jobErr?.message);
    return c.json({ error: 'enqueue_failed', reason: 'Could not queue the scan. Please try again.' }, 500);
  }

  // 2) Persist the uploaded photos to R2 (durability/audit) BEFORE responding
  //    — small puts, still fast. Best-effort: the pipeline runs off the
  //    in-memory buffers, so a failed put never blocks the job.
  const imageKeys: string[] = [];
  if (c.env.SO_ITEM_PHOTOS) {
    for (let i = 0; i < allFiles.length; i += 1) {
      const key = `scan-jobs/${jobId}/${i}`;
      try {
        await c.env.SO_ITEM_PHOTOS.put(key, allFiles[i].buffer, {
          httpMetadata: { contentType: allFiles[i].mime },
        });
        imageKeys.push(key);
      } catch (e) {
        console.warn('[scan-so enqueue] R2 put failed:', key, (e as Error).message);
      }
    }
    if (imageKeys.length > 0) {
      await svc
        .from('scan_jobs')
        .update({ image_keys: imageKeys, updated_at: new Date().toISOString() })
        .eq('id', jobId);
    }
  }

  // 3) Run the pipeline AFTER responding — same waitUntil pattern as the
  //    confirm endpoint's fire-and-forget distill.
  const pipeline = runScanJob(c.env, {
    id: jobId,
    salesperson: repGiven,
    salespersonId: user.id,
    salespersonName,
    houzsUserId,
    fileBlocks,
    uploadedImages,
    firstBuffer,
    imageKeys,
  });
  try {
    c.executionCtx.waitUntil(pipeline);
  } catch {
    /* non-Workers runtime (tests) — let the floating promise run */
  }

  return c.json({ job_id: jobId, status: 'queued' }, 202);
});

// ---------------------------------------------------------------------------
// Stale-job reaper — a scan job stuck in queued/running for >3 minutes is
// dead (isolate evicted / Worker DEPLOY killed the waitUntil, pipeline crashed
// without reaching its own error-update). Deploys are the common cause, so a
// stale job is NOT errored on first sight: it gets ONE automatic re-run
// (retry_count 0 → 1, migration 0070) rebuilt from the R2 photo copies the
// enqueue path already persisted (scan-jobs/{jobId}/{n}, image_keys on the
// row). Only a job whose single retry is spent (retry_count >= 1) — or whose
// photos never made it to R2 — is flipped to the terminal error.
//
// Staleness clock = updated_at (NOT created_at): the retry claim stamps
// updated_at = now, giving the re-run its own fresh 3-minute window instead
// of being re-reaped on the next poll. (First attempts are equivalent either
// way — a job's updated_at only moves when the pipeline is actually alive.)
//
// Piggybacked on the two poll endpoints (no cron on this worker); the re-run
// itself rides the poll's executionCtx.waitUntil. Fail-soft — a reaper error
// must never break the poll itself. The claim update is conditional
// (retry_count = 0 AND still queued/running), so two concurrent polls can
// never double-run one job.
// ---------------------------------------------------------------------------
// 3 min (was 10): /extract carries a 110s AbortSignal.timeout, so a job still
// queued/running past 3 minutes is a deploy/isolate-killed zombie, not a
// slow-but-alive call — safe to retry (first pass) / error (terminal pass) at
// 3 min. Both the RETRY-claim pass and the TERMINAL pass derive their cutoff
// from this one constant, so this single change tightens both.
const SCAN_JOB_STALE_MINUTES = 3;
const STALE_JOB_ERROR = 'The scan took too long and was stopped. Please scan this slip again.';

// Rebuild runScanJob's file inputs from the durable R2 copies — the inverse of
// parseScanFiles for a retry (the original in-memory buffers died with the
// isolate). Block order matches upload order because image_keys was appended
// in file order; the stored contentType decides image vs document block, same
// mapping as parseScanFiles. Returns null (caller errors the job) if the
// bucket is unbound or ANY key is missing.
async function loadScanJobFilesFromR2(
  bucket: Env['SO_ITEM_PHOTOS'] | undefined,
  keys: string[],
): Promise<{
  fileBlocks: ContentBlock[];
  uploadedImages: UploadedImage[];
  firstBuffer: ArrayBuffer | null;
} | null> {
  if (!bucket || keys.length === 0) return null;
  const fileBlocks: ContentBlock[] = [];
  const uploadedImages: UploadedImage[] = [];
  let firstBuffer: ArrayBuffer | null = null;
  let blockIndex = 0;
  for (const key of keys) {
    const obj = await bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    if (!firstBuffer) firstBuffer = buf;
    const mime = obj.httpMetadata?.contentType || 'image/jpeg';
    const data = toBase64(buf);
    if (mime === 'application/pdf') {
      fileBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      });
    } else {
      uploadedImages.push({ index: blockIndex, buffer: buf, mime });
      fileBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data },
      });
    }
    blockIndex += 1;
  }
  return { fileBlocks, uploadedImages, firstBuffer };
}

async function reapStaleScanJobs(
  env: Env,
  svc: ReturnType<typeof serviceClient>,
  // The calling poll handler's executionCtx.waitUntil (try/catch-wrapped for
  // non-Workers test runtimes) — the retry pipeline must outlive the poll
  // response, exactly like the enqueue path.
  runInBackground: (p: Promise<unknown>) => void,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - SCAN_JOB_STALE_MINUTES * 60 * 1000).toISOString();

    // 1) RETRY pass — stale first-attempt jobs get one re-run. limit(5) bounds
    //    the work a single poll can pick up; anything left is caught by the
    //    next poll (the screen polls every 4s while jobs are active).
    const { data: retryRows, error: retryErr } = await svc
      .from('scan_jobs')
      .select('id, salesperson, salesperson_id, houzs_user_id, image_keys, retry_count')
      .in('status', ['queued', 'running'])
      .lt('updated_at', cutoff)
      .eq('retry_count', 0)
      .limit(5);
    if (retryErr) {
      // retry_count likely missing (migration 0070 not applied yet) — fall
      // back to the pre-retry blanket reap so stale jobs still terminate
      // instead of spinning forever.
      console.warn('[scan-so jobs] retry pass failed (blanket reap fallback):', retryErr.message);
      await svc
        .from('scan_jobs')
        .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
        .in('status', ['queued', 'running'])
        .lt('updated_at', cutoff);
      return;
    }

    for (const r of (retryRows ?? []) as Array<Record<string, unknown>>) {
      const id = String(r.id ?? '');
      if (!id) continue;
      // CLAIM — conditional update; under concurrent polls Postgres row
      // locking makes exactly one caller see a non-empty result.
      const { data: claimed, error: claimErr } = await svc
        .from('scan_jobs')
        .update({ status: 'queued', retry_count: 1, updated_at: nowIso })
        .eq('id', id)
        .eq('retry_count', 0)
        .in('status', ['queued', 'running'])
        .select('id');
      if (claimErr || !claimed || claimed.length === 0) continue;

      // Dual-read both casings (the #1 recurring result-column bug class).
      const rawKeys = r.imageKeys ?? r.image_keys;
      const imageKeys = Array.isArray(rawKeys) ? rawKeys.map(String) : [];
      const salesperson = typeof r.salesperson === 'string' ? r.salesperson : '';
      const salespersonId = String(r.salespersonId ?? r.salesperson_id ?? '');
      const huRaw = r.houzsUserId ?? r.houzs_user_id;
      const houzsUserId = huRaw != null && Number.isFinite(Number(huRaw)) ? Number(huRaw) : null;

      // Heavy part (R2 reads + the whole pipeline) runs AFTER the poll
      // responds — never inline in the GET.
      runInBackground((async () => {
        const files = salespersonId ? await loadScanJobFilesFromR2(env.SO_ITEM_PHOTOS, imageKeys) : null;
        if (!files) {
          // No durable photos (enqueue-time R2 put failed / bucket unbound) or
          // no replayable identity — the retry cannot run; terminal error now.
          console.warn('[scan-so jobs] retry not replayable, erroring:', id);
          await svc
            .from('scan_jobs')
            .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: new Date().toISOString() })
            .eq('id', id);
          return;
        }
        console.warn('[scan-so jobs] re-running stale job (retry 1/1):', id);
        await runScanJob(env, {
          id,
          salesperson,
          salespersonId,
          // The enqueue-time user_metadata name is not on the row; the
          // normalized rep display name is the closest replay identity.
          salespersonName: salesperson || null,
          houzsUserId,
          fileBlocks: files.fileBlocks,
          uploadedImages: files.uploadedImages,
          firstBuffer: files.firstBuffer,
          imageKeys,
        });
      })());
    }

    // 2) TERMINAL pass — stale jobs whose single retry is already spent.
    await svc
      .from('scan_jobs')
      .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
      .in('status', ['queued', 'running'])
      .lt('updated_at', cutoff)
      .gte('retry_count', 1);
  } catch (e) {
    console.warn('[scan-so jobs] stale-job reaper failed:', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// GET /scan-so/jobs?salesperson= — latest 20 jobs, optionally one rep's
// (normalized + case-insensitive match, same pool rule as the samples).
// ---------------------------------------------------------------------------
scanSo.get('/jobs', async (c) => {
  const rep = normalizeRepKey(c.req.query('salesperson'));
  const svc = serviceClient(c.env);
  await reapStaleScanJobs(c.env, svc, (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      /* non-Workers runtime (tests) — let the floating promise run */
    }
  });
  let q = svc
    .from('scan_jobs')
    .select('id, status, salesperson, so_doc_no, error, sample_id, duplicate_of, image_keys, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (rep) q = q.ilike('salesperson', ilikeExact(rep));
  const { data, error } = await q;
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load scan jobs. Please try again.' }, 500);
  }
  const jobs = ((data as Array<Record<string, unknown>> | null) ?? []).map(jobToJson);
  return c.json({ success: true, data: { jobs } });
});

// ---------------------------------------------------------------------------
// GET /scan-so/jobs/:id — poll one job (status / soDocNo / error).
// ---------------------------------------------------------------------------
scanSo.get('/jobs/:id', async (c) => {
  const id = (c.req.param('id') ?? '').trim();
  if (!id) return c.json({ error: 'bad_request', reason: 'Missing job id.' }, 400);
  const svc = serviceClient(c.env);
  await reapStaleScanJobs(c.env, svc, (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      /* non-Workers runtime (tests) — let the floating promise run */
    }
  });
  const { data, error } = await svc
    .from('scan_jobs')
    .select('id, status, salesperson, so_doc_no, error, sample_id, duplicate_of, image_keys, created_at, updated_at')
    .eq('id', id)
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load the scan job. Please try again.' }, 500);
  }
  if (!data) return c.json({ error: 'not_found', reason: 'Scan job not found.' }, 404);
  return c.json({ success: true, data: { job: jobToJson(data as Record<string, unknown>) } });
});

// ---------------------------------------------------------------------------
// POST /scan-so/jobs/clear-failed — the mobile "Clear" button on Recent scans.
// Deletes terminal status='error' rows (sticky failure cards the rep has read
// and dealt with). SELF-SCOPED: a normal caller only clears rows whose
// salesperson matches their OWN normalized name (the same identity the mobile
// screen scopes its list with — auth.ts stamps user_metadata.name = real name
// ?? email, mirroring the frontend's user.name || user.email); a wildcard-'*'
// caller (owner/admin, checked against houzsUser — NEVER scm.staff.role,
// which is the pinned system row) clears every rep's failed rows. Done rows
// carrying a warning note / duplicateOf are NOT touched — they point at a
// real SO. No in-app confirm needed client-side: plain cleanup of already
// terminal rows; nothing about the drafts themselves changes.
// ---------------------------------------------------------------------------
scanSo.post('/jobs/clear-failed', async (c) => {
  const svc = serviceClient(c.env);
  const houzsUser = c.get('houzsUser');
  const clearsAll =
    houzsUser?.permissions_set?.has('*') || houzsUser?.permissions?.includes('*') || false;
  const caller = normalizeRepKey(
    (c.get('user').user_metadata as { name?: string } | undefined)?.name,
  );
  if (!clearsAll && !caller) {
    return c.json(
      { error: 'bad_request', reason: 'Could not work out which salesperson you are.' },
      400,
    );
  }
  let q = svc.from('scan_jobs').delete().eq('status', 'error');
  if (!clearsAll) q = q.ilike('salesperson', ilikeExact(caller));
  const { error } = await q;
  if (error) {
    if (isMissingTable(error)) {
      return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    }
    console.error('[scan-so jobs] clear-failed failed:', error.message);
    return c.json(
      { error: 'delete_failed', reason: 'Could not clear the failed scans. Please try again.' },
      500,
    );
  }
  return c.json({ success: true });
});

// ===========================================================================
// POST /scan-so/samples/:id/confirm — store the operator-corrected JSON.
// Called by the modal when the operator clicks "Open in New SO"; the
// corrected blob becomes a few-shot example for future extractions.
// ===========================================================================
scanSo.post('/samples/:id/confirm', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'bad_request', reason: 'Missing sample id.' }, 400);

  let body: { corrected?: unknown; salesperson?: unknown };
  try {
    body = (await c.req.json()) as { corrected?: unknown; salesperson?: unknown };
  } catch {
    return c.json({ error: 'bad_request', reason: 'Invalid JSON body.' }, 400);
  }
  if (body.corrected === undefined || body.corrected === null) {
    return c.json({ error: 'bad_request', reason: 'Missing `corrected`.' }, 400);
  }
  // Normalized rep key (trim + single-space) — case/whitespace variants must
  // share one learning pool on write, same as /extract's stamp.
  const repGiven = normalizeRepKey(body.salesperson);

  const svc = serviceClient(c.env);
  const { data: updated, error } = await svc
    .from('so_scan_samples')
    .update({
      corrected: body.corrected,
      status: 'CONFIRMED',
      // Operator-reviewed rep wins over whatever /extract stamped; blank
      // leaves the extract-time value (operator pick or AI detection) alone.
      ...(repGiven ? { salesperson: repGiven } : {}),
    })
    .eq('id', id)
    .select('id, salesperson');

  if (error) {
    if (isMissingTable(error)) {
      return c.json({ error: 'table_missing', reason: TABLE_MISSING_MSG }, 503);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!updated || updated.length === 0) {
    return c.json({ error: 'not_found', reason: 'Sample not found.' }, 404);
  }

  // Fire-and-forget rule distillation — REGENERATES so_scan_rules for this
  // rep (latest ≤50 of their corrected samples) AND the '__GLOBAL__' shared
  // alias dictionary (latest ≤80 corrected samples across ALL reps). Both
  // cheap-skip (<2 samples) without an API call, so firing on every confirm
  // is safe. Sequential to keep it to one Anthropic call at a time. Never
  // blocks/fails the confirm.
  const rep = repGiven || normalizeRepKey((updated[0] as { salesperson?: string | null }).salesperson);
  const distillCompanyName = (await getBranding(c.env)).companyName;
  const distillPromise = (async () => {
    if (rep && !isGlobalKey(rep)) {
      try {
        const r = await distillSalespersonRules(svc, c.env.ANTHROPIC_API_KEY, rep, distillCompanyName);
        if (r.status === 'error') console.warn(`[scan-so distill] ${rep}: ${r.reason}`);
      } catch (e) {
        console.warn(`[scan-so distill] ${rep} threw:`, (e as Error).message);
      }
    }
    try {
      const g = await distillGlobalAliases(svc, c.env.ANTHROPIC_API_KEY, distillCompanyName);
      if (g.status === 'error') console.warn(`[scan-so distill] __GLOBAL__ aliases: ${g.reason}`);
    } catch (e) {
      console.warn('[scan-so distill] __GLOBAL__ aliases threw:', (e as Error).message);
    }
    // Cross-rep shared RULES — regenerated on every confirm too (cheap-skips
    // <3 samples without an API call) so each rep's correction lifts the
    // shared baseline for everyone. Sequential; never blocks the confirm.
    try {
      const gr = await distillGlobalRules(svc, c.env.ANTHROPIC_API_KEY, distillCompanyName);
      if (gr.status === 'error') console.warn(`[scan-so distill] __GLOBAL_RULES__: ${gr.reason}`);
    } catch (e) {
      console.warn('[scan-so distill] __GLOBAL_RULES__ threw:', (e as Error).message);
    }
  })();
  try {
    c.executionCtx.waitUntil(distillPromise);
  } catch {
    /* non-Workers runtime (tests) — let the floating promise run */
  }

  return c.json({ success: true });
});
