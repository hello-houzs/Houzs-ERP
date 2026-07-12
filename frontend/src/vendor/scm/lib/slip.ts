// Vendored SLICE of apps/backend/src/lib/slip.ts — the payment-slip fetch +
// the init→upload→confirm sequence the SO PaymentsTable + SlipUploadField use.
//
// HOUZS VENDOR NOTES:
//   - The token + base URL come from the vendored authed-fetch boundary
//     (localStorage['auth:token'] + VITE_API_URL ?? worker, + /api/scm),
//     replacing 2990's supabase.auth.getSession() + bare VITE_API_URL.
//   - The slip schema types (SlipUrlResponse / SlipInit* / ALLOWED_SLIP_MIMES /
//     MAX_SLIP_SIZE_BYTES) lived in @2990s/shared/schemas (not vendored); they
//     are inlined here and re-exported so SlipUploadField + PaymentsTable can
//     import them from this module instead.
//   - OPERATIONAL DEVIATION from 2990 (2026-07-04, precedent: the
//     VITE_API_URL `||` fix): 2990 uploads via a browser presigned R2 PUT and
//     views via presigned GET URLs. Houzs prod never provisioned the R2
//     S3-API creds those need (every /slips/init 500'd), so this lib now
//     drives the Worker-proxy flow instead:
//       upload: POST /slips/init (no putUrl) → POST /slips/:id/upload (raw
//               binary) → POST /slips/:id/confirm — same session vocabulary,
//               bytes proxied through the Worker's SLIPS binding.
//       view:   /slip-url routes STREAM the object; fetchSoSlipUrl /
//               fetchPaymentSlipUrl blob-fetch it and return an object URL,
//               so their {url, contentType} contract to callers is unchanged.
//     Callers (SlipUploadField, PaymentsTable, MobileNewSO PayCard,
//     MobilePOD) are untouched — uploadSlipFull keeps its signature and the
//     'init'|'put'|'confirm' phase vocabulary.

import { humanApiError } from './authed-fetch';

const API_URL =
  ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL
    || (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) + '/api/scm';

const token = (): string => {
  const t = localStorage.getItem('auth:token');
  if (!t) throw new Error('not_authenticated');
  return t;
};

/* These slip fetches go straight to fetch(), bypassing authedFetch's deadline,
   so a stalled cold-start / slow upload hangs the upload UI forever. Cap each
   one — generous for the image OCR + binary uploads, tighter for the slip
   GETs / confirm — and turn a timeout into a plain-language retryable error. */
const SLIP_UPLOAD_TIMEOUT_MS = 120_000;
const SLIP_TIMEOUT_MS = 60_000;

async function slipFetch(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(timeoutMs); } catch { signal = undefined; } // pre-2022 browsers
  try {
    return await fetch(input, { ...init, signal });
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('The request took too long — please check your connection and try again.');
    }
    throw e;
  }
}

/* ── Inlined slip schema (was @2990s/shared/schemas) ─────────────────────── */
export type SlipUrlResponse = { url: string; contentType: string };
export type SlipInitRequest = {
  fileSize: number;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  contentHash: string;
};
/* Proxy-upload deviation: init returns NO putUrl — the bytes go to
   POST /slips/:id/upload instead of a presigned R2 PUT. */
export type SlipInitResponse = { uploadSessionId: string; r2Key: string };
export type SlipConfirmResponse = { ok: boolean };

export const ALLOWED_SLIP_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
] as const;
export const MAX_SLIP_SIZE_BYTES = 5 * 1024 * 1024;

/* Proxy-view deviation (see header): the /slip-url routes now STREAM the slip
   bytes through the Worker (authed) instead of returning a presigned R2 URL.
   Blob-fetch + object URL keeps the {url, contentType} contract for callers
   (<img src>, <a href target=_blank>, window.open all take blob: URLs). The
   object URLs are never revoked here — same accepted trade-off as
   fetchScanSlipImageBlobUrl's callers that view-then-navigate. */
async function fetchSlipAsObjectUrl(path: string): Promise<SlipUrlResponse> {
  const res = await slipFetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token()}` },
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), contentType };
}

/** A manufacturing Sales Order's payment slip, as a blob object URL. */
export async function fetchSoSlipUrl(docNo: string): Promise<SlipUrlResponse> {
  return fetchSlipAsObjectUrl(`/mfg-sales-orders/${encodeURIComponent(docNo)}/slip-url`);
}

/** A single SO payment row's slip, as a blob object URL. */
export async function fetchPaymentSlipUrl(
  docNo: string,
  paymentId: string,
): Promise<SlipUrlResponse> {
  return fetchSlipAsObjectUrl(
    `/mfg-sales-orders/${encodeURIComponent(docNo)}/payments/${encodeURIComponent(paymentId)}/slip-url`,
  );
}

/** Authed GET of a scanned "Original Slip" image (GET /scan-so/slip-image?key=…)
 *  as a blob → object URL the SO detail page hands to <img src>. Mirrors the
 *  bearer-token proxy fetch used for payment slips; the caller is responsible
 *  for URL.revokeObjectURL() when the image is unmounted. */
export async function fetchScanSlipImageBlobUrl(key: string): Promise<string> {
  const res = await slipFetch(`${API_URL}/scan-so/slip-image?key=${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${token()}` },
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/* ── Card-terminal / EPP receipt OCR (POST /scan-payment/extract) ─────────────
   The receipt IS the payment row's slip. The Payments panel POSTs the uploaded
   IMAGE here in parallel with the slip upload; the validated matches fill-blanks
   the row's draft fields. Each *Match value is snapped server-side to the live
   active so_dropdown_options (any value not in the list is cleared to null), so
   the caller can trust value || '' directly. Multipart field name: `file`. */
export type ScanPaymentMatch = { value: string; confidence: number; reason: string };
export type ScanPaymentReceipt = {
  paymentMethodMatch:   ScanPaymentMatch | null;
  bankMatch:            ScanPaymentMatch | null;
  onlineTypeMatch:      ScanPaymentMatch | null;
  installmentPlanMatch: ScanPaymentMatch | null;
  approvalCode:         string | null;
  amountRm:             number | null;
  /* Spec 2 (2026-06-24) — the receipt's SWIPE date (YYYY-MM-DD) → the payment
     row's paid_at. THIS CAN BE A PAST DATE (the salesperson may open the SO a
     few days after collecting the money), so the caller must NOT clamp it to
     today. null when the OCR read no date. */
  paidAt:               string | null;
};

export async function scanPaymentReceipt(file: File): Promise<ScanPaymentReceipt> {
  const form = new FormData();
  form.append('file', file);
  const res = await slipFetch(`${API_URL}/scan-payment/extract`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}` },
    body: form,
  }, SLIP_UPLOAD_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  const json = (await res.json()) as { data?: { extracted?: ScanPaymentReceipt } };
  const extracted = json.data?.extracted;
  if (!extracted) throw new Error('scan_payment_no_data');
  return extracted;
}

export async function sha256Hex(file: File | Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function initSlipUpload(file: File): Promise<SlipInitResponse> {
  const hash = await sha256Hex(file);
  const body: SlipInitRequest = {
    fileSize: file.size,
    contentType: file.type as SlipInitRequest['contentType'],
    contentHash: hash,
  };
  const res = await slipFetch(`${API_URL}/slips/init`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  return res.json() as Promise<SlipInitResponse>;
}

/* Proxy-upload deviation (replaces 2990's putToR2 presigned PUT): raw binary
   POST to the Worker, which writes through its SLIPS binding. Authed like
   every other API call — no presigned URL, no R2 S3 creds. */
async function uploadSlipBytes(sessionId: string, file: File): Promise<void> {
  const res = await slipFetch(`${API_URL}/slips/${encodeURIComponent(sessionId)}/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': file.type,
    },
    body: file,
  }, SLIP_UPLOAD_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
}

async function confirmUpload(sessionId: string): Promise<SlipConfirmResponse> {
  const res = await slipFetch(`${API_URL}/slips/${sessionId}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}` },
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  return res.json() as Promise<SlipConfirmResponse>;
}

/* 'put' kept in the phase vocabulary (SlipUploadField's busy states key off
   it) even though the transfer is now a Worker-proxy POST, not an R2 PUT. */
export type SlipUploadPhase = 'init' | 'put' | 'confirm';

export interface UploadSlipOptions {
  file: File;
  onProgress?: (phase: SlipUploadPhase) => void;
}

export interface UploadSlipResult {
  uploadSessionId: string;
  r2Key: string;
}

export async function uploadSlipFull(opts: UploadSlipOptions): Promise<UploadSlipResult> {
  opts.onProgress?.('init');
  const init = await initSlipUpload(opts.file);

  opts.onProgress?.('put');
  let putErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await uploadSlipBytes(init.uploadSessionId, opts.file);
      putErr = undefined;
      break;
    } catch (err) {
      putErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (putErr) throw putErr;

  opts.onProgress?.('confirm');
  await confirmUpload(init.uploadSessionId);
  return { uploadSessionId: init.uploadSessionId, r2Key: init.r2Key };
}
