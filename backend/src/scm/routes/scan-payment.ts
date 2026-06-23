// ---------------------------------------------------------------------------
// /scan-payment — Claude-powered OCR for Malaysian bank card-terminal / EPP
// receipts uploaded as a payment row's SLIP. One upload, both uses: the image
// is the slip AND the OCR source. The Payments panel POSTs it here in parallel
// with the slip upload and fill-blanks-only auto-fills that row's draft fields.
//
// Extraction-only — no samples, no learning, no few-shot, no R2 persistence
// (that's the slip-upload path's job). A sibling of scan-so.ts but deliberately
// MINIMAL: it mirrors scan-so's Anthropic fetch + toBase64 + stripJsonFences
// plumbing (helpers inlined here, NOT imported, so scan-so's exports stay
// narrow) and snaps every *Match to the LIVE active so_dropdown_options just
// like scan-so's validateSlip.
//
// OWNER'S RECORDING CONVENTION (authoritative — from a real recorded payment):
// a card-terminal EPP receipt is booked as Method = Installment with the tenure
// in months (their screenshot: "Installment / 6m", Approval Code 009498, a
// Maybank EPP receipt totalling MYR 4980). So an EPP/installment receipt maps to
// paymentMethodMatch = the Installment method value + installmentPlanMatch = the
// N-month value. A plain card swipe with NO tenure → Merchant + bank. DuitNow /
// transfer / TNG / cheque → Online + sub-type. Cash → Cash.
//
// Endpoint:
//   POST /scan-payment/extract   — multipart image/pdf → validated JSON
//     { paymentMethodMatch, bankMatch, onlineTypeMatch, installmentPlanMatch,
//       approvalCode, amountRm }
//   each *Match = { value, confidence, reason } | null, snapped to the live
//   active so_dropdown_options (categories payment_method / payment_merchant /
//   online_type / installment_plan); any value not in the live list is cleared.
//
// Auth: supabaseAuth on the whole router (same as scan-so). The catalog read
// uses the middleware-attached c.get('supabase') (scm-scoped, RLS applies).
// ANTHROPIC_API_KEY is OPTIONAL on the Houzs Env — when absent /extract returns
// 503 anthropic_key_missing and never breaks the worker or tsc.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

// scm-scoped, loosely-typed client (matches scm/env.ts Variables.supabase).
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const scanPayment = new Hono<{ Bindings: Env; Variables: Variables }>();
scanPayment.use('*', supabaseAuth);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ArrayBuffer -> base64 (chunked; Workers have no Node Buffer). Inlined from
// scan-so.ts's toBase64 — kept private so scan-so's surface doesn't widen.
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

// Claude sometimes wraps JSON in fences or adds a preamble — take the first `{`
// to the last `}`. Inlined verbatim from scan-so.ts's stripJsonFences.
function stripJsonFences(text: string): string {
  let trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const fenceMatch = trimmed.match(fenceRe);
  if (fenceMatch?.[1]) trimmed = fenceMatch[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1).trim();
  }
  return trimmed;
}

// ===========================================================================
// Live payment vocabularies — the four payment-cascade categories the
// Payments panel actually cascades over. Pulled live + active-only from
// so_dropdown_options on every /extract (mirrors scan-so's loadCatalog).
// ===========================================================================
const OPTION_CATEGORIES = [
  'payment_method',     // L1 — Merchant / Online / Installment / Cash
  'payment_merchant',   // L2 merchant banks (MBB / CIMB / Public / …)
  'online_type',        // L2 online sub-types (Bank Transfer / TNG / Cheque / DuitNow)
  'installment_plan',   // L2 plans (One-off / 3 / 6 / 12 / 24 / 36 months)
] as const;
type OptionCategory = (typeof OPTION_CATEGORIES)[number];
type CatalogOption = { value: string; label: string };
type CatalogOptions = Record<OptionCategory, CatalogOption[]>;

const emptyOptions = (): CatalogOptions => ({
  payment_method:   [],
  payment_merchant: [],
  online_type:      [],
  installment_plan: [],
});

async function loadOptions(sb: SupabaseClient): Promise<CatalogOptions> {
  const options = emptyOptions();
  const { data } = await sb
    .from('so_dropdown_options')
    .select('category, value, label')
    .eq('active', true)
    .in('category', OPTION_CATEGORIES as unknown as string[])
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true })
    .limit(2000);
  for (const row of (data as Array<{ category: string; value: string; label: string }> | null) ?? []) {
    if ((OPTION_CATEGORIES as readonly string[]).includes(row.category)) {
      options[row.category as OptionCategory].push({ value: row.value, label: row.label });
    }
  }
  return options;
}

function formatOptions(o: CatalogOptions): string {
  const lines: string[] = [];
  const section = (title: string, cat: OptionCategory) => {
    lines.push(`=== ${title} (allowed values: value | label) ===`);
    const rows = o[cat];
    if (rows.length === 0) lines.push('—');
    for (const r of rows) lines.push(`${r.value} | ${r.label}`);
    lines.push('');
  };
  section('PAYMENT METHODS',   'payment_method');
  section('MERCHANT BANKS',    'payment_merchant');
  section('ONLINE TYPES',      'online_type');
  section('INSTALLMENT PLANS', 'installment_plan');
  return lines.join('\n').trimEnd();
}

// ===========================================================================
// Prompt — extraction-only, baked with the owner's EPP→Installment convention.
// ===========================================================================
const SYSTEM_PROMPT = `You read a single MALAYSIAN bank CARD-TERMINAL / payment receipt and extract the payment fields for ONE payment row at 2990's Home, a Malaysian furniture retailer. The image is usually a thermal card-machine slip (Maybank / CIMB / Public Bank / HLB / RHB terminal), an EPP (Easy Payment Plan / installment) approval slip, a DuitNow / bank-transfer / e-wallet (Touch 'n Go) confirmation, a cheque, or a cash receipt.

A reference list of ALLOWED VALUES follows this prompt (PAYMENT METHODS, MERCHANT BANKS, ONLINE TYPES, INSTALLMENT PLANS). Each row is "value | label". Every match you return MUST be the VALUE (left side), copied character-for-character from the list. NEVER invent a value outside the list; when you cannot find a defensible match, return null for that field.

HOW TO CLASSIFY THE RECEIPT
===========================
Decide the top-level method (paymentMethodMatch — one of PAYMENT METHODS):

1. CARD-TERMINAL EPP / INSTALLMENT receipt → method = the "Installment" value.
   Recognise it by an installment/EPP tenure on the slip: a "TENURE", "06 MONTHS" / "6 MTHS", "MONTHLY REPAYMENT" / "MONTHLY INSTALMENT" line, the words "EPP" / "EASY PAYMENT PLAN" / "INSTALMENT" / "ANSURAN", or a plan/package code with a month count. In this house an EPP card receipt is RECORDED as method = Installment with the tenure in months — so:
     • paymentMethodMatch.value = the Installment value.
     • installmentPlanMatch.value = the matching N-month value from INSTALLMENT PLANS (e.g. "06 MONTHS"/"6 MTHS" → the 6-month value, "12" → the 12-month value). Map the printed tenure to the closest N-month list entry.
   (Do NOT set bankMatch for an EPP receipt — bankMatch is only used when the method ends up Merchant.)

2. PLAIN CARD SWIPE with NO tenure (a normal credit/debit sale, "SALE" / "APPROVED", no EPP / no months) → method = the "Merchant" value, and set bankMatch to the issuing/terminal bank from MERCHANT BANKS (Maybank → the MBB value, Public Bank → the Public value, CIMB → CIMB, Hong Leong → HLB, RHB → RHB). installmentPlanMatch = null.

3. DUITNOW / BANK TRANSFER / TOUCH 'N GO (TNG) / E-WALLET / CHEQUE → method = the "Online" value, and set onlineTypeMatch to the matching ONLINE TYPES value (DuitNow → the DuitNow value, an IBG/instant transfer → the Bank Transfer value, Touch 'n Go / TNG → the TNG value, a cheque → the Cheque value). bankMatch and installmentPlanMatch = null.

4. CASH receipt → method = the "Cash" value. All other matches = null.

FIELDS
======
- paymentMethodMatch — the method value chosen by the rules above.
- bankMatch — a MERCHANT BANKS value. ONLY meaningful when the method is Merchant (rule 2). Leave null otherwise (including for EPP/Installment receipts).
- onlineTypeMatch — an ONLINE TYPES value. ONLY meaningful when the method is Online (rule 3). Leave null otherwise.
- installmentPlanMatch — an INSTALLMENT PLANS value (the tenure in months). ONLY meaningful when the method is Installment (rule 1). Leave null otherwise.
- approvalCode — the receipt's "APPROVAL CODE" / "APPROVAL NO" / "APPR CODE" / "AUTH CODE" / "KOD KELULUSAN", as the bare alphanumeric string (e.g. "APPROVAL CODE 009498" → "009498"). Strip labels/brackets. null when absent.
- amountRm — the charged TOTAL as a NUMBER in RM: the "TOTAL", "CARD TOTAL", "AMOUNT", "JUMLAH", or "SALE AMOUNT" the customer was charged (e.g. "RM 4,980.00" → 4980). For an EPP receipt this is the full financed amount (the TOTAL), NOT the monthly repayment. null when no total is readable.

Each *Match returns { "value": <exact list value>, "confidence": 0-1, "reason": <short why> } or null. Use confidence 0.9+ only when the receipt clearly identifies one specific list row; 0.5-0.8 when plausible but ambiguous; below 0.5 prefer null.

Example A — a Maybank EPP slip with "TENURE 06 MONTHS", "APPROVAL CODE 009498", "TOTAL RM 4,980.00": paymentMethodMatch.value = the Installment value, installmentPlanMatch.value = the 6-month value, bankMatch = null, onlineTypeMatch = null, approvalCode = "009498", amountRm = 4980.
Example B — a plain Public Bank "SALE / APPROVED" swipe, no tenure, "APPROVAL CODE 028471", "TOTAL RM 1,200.00": paymentMethodMatch.value = the Merchant value, bankMatch.value = the Public value, installmentPlanMatch = null, approvalCode = "028471", amountRm = 1200.
Example C — a DuitNow transfer confirmation for RM 550.50: paymentMethodMatch.value = the Online value, onlineTypeMatch.value = the DuitNow value, bankMatch = null, installmentPlanMatch = null, approvalCode = null (unless a reference number is clearly an approval code), amountRm = 550.5.

OUTPUT
======
Return STRICT JSON, no markdown fences, no prose:
{
  "paymentMethodMatch":   { "value": string, "confidence": number, "reason": string } | null,
  "bankMatch":            { "value": string, "confidence": number, "reason": string } | null,
  "onlineTypeMatch":      { "value": string, "confidence": number, "reason": string } | null,
  "installmentPlanMatch": { "value": string, "confidence": number, "reason": string } | null,
  "approvalCode": string | null,
  "amountRm": number | null
}`;

// ===========================================================================
// Types + normalisation
// ===========================================================================
type OptionMatch = { value: string; confidence: number; reason: string };
type ExtractedReceipt = {
  paymentMethodMatch: OptionMatch | null;
  bankMatch: OptionMatch | null;
  onlineTypeMatch: OptionMatch | null;
  installmentPlanMatch: OptionMatch | null;
  approvalCode: string | null;
  amountRm: number | null;
};

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
};

type Warning = { field: string; value: string; message: string };

// Coerce Claude's output into the ExtractedReceipt shape — tolerate omitted
// fields, wrong primitive types, and a { code } key in place of { value }.
function normalizeReceipt(raw: unknown): ExtractedReceipt {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
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
  return {
    paymentMethodMatch:   optionMatch(r.paymentMethodMatch),
    bankMatch:            optionMatch(r.bankMatch),
    onlineTypeMatch:      optionMatch(r.onlineTypeMatch),
    installmentPlanMatch: optionMatch(r.installmentPlanMatch),
    approvalCode:         str(r.approvalCode),
    amountRm:             num(r.amountRm),
  };
}

// Never-invent enforcement (server-side, same as scan-so's validateSlip): a
// match value outside the ACTIVE allowed list is cleared to null; on hit the
// value is snapped to the canonical casing.
function validateReceipt(rec: ExtractedReceipt, options: CatalogOptions): Warning[] {
  const warnings: Warning[] = [];
  const fields: Array<{
    field: keyof Pick<ExtractedReceipt,
      'paymentMethodMatch' | 'bankMatch' | 'onlineTypeMatch' | 'installmentPlanMatch'>;
    category: OptionCategory;
  }> = [
    { field: 'paymentMethodMatch',   category: 'payment_method' },
    { field: 'bankMatch',            category: 'payment_merchant' },
    { field: 'onlineTypeMatch',      category: 'online_type' },
    { field: 'installmentPlanMatch', category: 'installment_plan' },
  ];
  for (const { field, category } of fields) {
    const m = rec[field];
    if (!m) continue;
    const canon = new Map(options[category].map((o) => [o.value.toUpperCase(), o.value]));
    const hit = canon.get(m.value.toUpperCase());
    if (hit) {
      m.value = hit;
    } else {
      warnings.push({
        field,
        value: m.value,
        message: `Suggested ${category.replace(/_/g, ' ')} not in the active list — cleared.`,
      });
      rec[field] = null;
    }
  }
  return warnings;
}

// ===========================================================================
// POST /scan-payment/extract
// ===========================================================================
scanPayment.post('/extract', async (c) => {
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

  // Accept the receipt under any field name ("file" is what the frontend
  // sends). First file wins — one receipt per payment row.
  // (entries cast to unknown: workers-types narrows the value to string,
  // which breaks the instanceof check — same cast as scan-so.ts.)
  let file: File | null = null;
  for (const [, v] of formData.entries() as Iterable<[string, unknown]>) {
    if (v instanceof File && v.size > 0) { file = v; break; }
  }
  if (!file) {
    return c.json({ error: 'bad_request', reason: 'No file uploaded.' }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return c.json(
      { error: 'bad_request', reason: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.` },
      400,
    );
  }

  const mime = file.type || '';
  const name = (file.name || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  const isImage =
    IMAGE_MIMES.has(mime) ||
    name.endsWith('.jpg') || name.endsWith('.jpeg') ||
    name.endsWith('.png') || name.endsWith('.webp');
  if (!isPdf && !isImage) {
    return c.json(
      { error: 'bad_request', reason: `Unsupported file type "${mime || name}". Use JPEG / PNG / WEBP / PDF.` },
      400,
    );
  }

  const buf = await file.arrayBuffer();
  const data = toBase64(buf);
  type ContentBlock = Record<string, unknown>;
  const fileBlock: ContentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: IMAGE_MIMES.has(mime)
            ? mime
            : name.endsWith('.png') ? 'image/png'
            : name.endsWith('.webp') ? 'image/webp'
            : 'image/jpeg',
          data,
        },
      };

  // Live active payment vocabularies via the user-scoped client (RLS applies).
  const sb = c.get('supabase');
  const options = await loadOptions(sb);
  const optionsText = formatOptions(options);

  let errorMsg: string | null = null;
  let parsed: ExtractedReceipt | null = null;
  let claudeText = '';

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        // temperature=0 — deterministic OCR (same lesson as scan-so).
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `${SYSTEM_PROMPT}\n\nALLOWED VALUES\n==============\n${optionsText}` },
              fileBlock,
              {
                type: 'text',
                text:
                  'Extract the payment receipt above using the rules + allowed values. ' +
                  "OUTPUT FORMAT: Your response must be VALID JSON ONLY. Do NOT write any preamble, explanation, or chain-of-thought. Do NOT wrap in markdown fences. The very first character of your response must be '{' and the very last must be '}'.",
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
        const firstText = parsedResp.content?.find((b) => b.type === 'text')?.text ?? '';
        claudeText = stripJsonFences(firstText);
        try {
          parsed = normalizeReceipt(JSON.parse(claudeText));
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    errorMsg = `Network/fetch error: ${(e as Error).message}`;
  }

  if (!parsed) {
    return c.json({ error: 'extract_failed', reason: errorMsg ?? 'Extraction failed.' }, 502);
  }

  const warnings = validateReceipt(parsed, options);

  return c.json({
    success: true,
    data: {
      extracted: parsed,
      warnings,
    },
  });
});

export default scanPayment;
