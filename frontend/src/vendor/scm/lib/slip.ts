// Vendored SLICE of apps/backend/src/lib/slip.ts — the payment-slip presigned
// GET + the init→PUT→confirm upload sequence the SO PaymentsTable +
// SlipUploadField use.
//
// HOUZS VENDOR NOTES:
//   - The token + base URL come from the vendored authed-fetch boundary
//     (localStorage['auth:token'] + VITE_API_URL ?? worker, + /api/scm),
//     replacing 2990's supabase.auth.getSession() + bare VITE_API_URL.
//   - The slip schema types (SlipUrlResponse / SlipInit* / ALLOWED_SLIP_MIMES /
//     MAX_SLIP_SIZE_BYTES) lived in @2990s/shared/schemas (not vendored); they
//     are inlined here and re-exported so SlipUploadField + PaymentsTable can
//     import them from this module instead.

import { humanApiError } from './authed-fetch';

const API_URL =
  ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL
    || 'https://autocount-sync-api.houzs-erp.workers.dev') + '/api/scm';

const token = (): string => {
  const t = localStorage.getItem('auth:token');
  if (!t) throw new Error('not_authenticated');
  return t;
};

/* ── Inlined slip schema (was @2990s/shared/schemas) ─────────────────────── */
export type SlipUrlResponse = { url: string; contentType: string };
export type SlipInitRequest = {
  fileSize: number;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  contentHash: string;
};
export type SlipInitResponse = { uploadSessionId: string; putUrl: string; r2Key: string };
export type SlipConfirmResponse = { ok: boolean };

export const ALLOWED_SLIP_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
] as const;
export const MAX_SLIP_SIZE_BYTES = 5 * 1024 * 1024;

/** Presigned GET URL for a manufacturing Sales Order's payment slip. */
export async function fetchSoSlipUrl(docNo: string): Promise<SlipUrlResponse> {
  const res = await fetch(`${API_URL}/mfg-sales-orders/${encodeURIComponent(docNo)}/slip-url`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  return res.json() as Promise<SlipUrlResponse>;
}

/** Presigned GET URL for a single SO payment row's slip. */
export async function fetchPaymentSlipUrl(
  docNo: string,
  paymentId: string,
): Promise<SlipUrlResponse> {
  const res = await fetch(
    `${API_URL}/mfg-sales-orders/${encodeURIComponent(docNo)}/payments/${encodeURIComponent(paymentId)}/slip-url`,
    { headers: { authorization: `Bearer ${token()}` } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  return res.json() as Promise<SlipUrlResponse>;
}

/** Authed GET of a scanned "Original Slip" image (GET /scan-so/slip-image?key=…)
 *  as a blob → object URL the SO detail page hands to <img src>. Mirrors the
 *  bearer-token proxy fetch used for payment slips; the caller is responsible
 *  for URL.revokeObjectURL() when the image is unmounted. */
export async function fetchScanSlipImageBlobUrl(key: string): Promise<string> {
  const res = await fetch(`${API_URL}/scan-so/slip-image?key=${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${token()}` },
  });
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
};

export async function scanPaymentReceipt(file: File): Promise<ScanPaymentReceipt> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_URL}/scan-payment/extract`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}` },
    body: form,
  });
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
  const res = await fetch(`${API_URL}/slips/init`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  return res.json() as Promise<SlipInitResponse>;
}

async function putToR2(putUrl: string, file: File): Promise<void> {
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) {
    throw new Error(humanApiError(res.status, ''));
  }
}

async function confirmUpload(sessionId: string): Promise<SlipConfirmResponse> {
  const res = await fetch(`${API_URL}/slips/${sessionId}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(humanApiError(res.status, text));
  }
  return res.json() as Promise<SlipConfirmResponse>;
}

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
      await putToR2(init.putUrl, opts.file);
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
