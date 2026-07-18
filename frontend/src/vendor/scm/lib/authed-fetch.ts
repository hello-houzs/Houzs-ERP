// ---------------------------------------------------------------------------
// authedFetch — the single authenticated fetch for the whole frontend data
// layer. Previously copy-pasted into 24 query modules (10 subtly-different
// variants); consolidated here so the auth header, the short-stock 409
// "ship anyway?" retry, and the sofa whole-set hard-block all live in ONE place.
//
// The 409 handling is a safe superset: it only triggers on a 409 whose body
// carries `short_stock` / `sofa_no_batch` / `sofa_partial_set`, which only the
// ship/mutation endpoints return — read-only callers never hit it, so adopting
// this universally changes nothing for them.
//
// ── HOUZS VENDOR ADAPTATION (only the boundary changed) ────────────────────
//   • API_URL now points at the Houzs Worker + the /api/scm mount (2990's
//     routes were ported there), with a build-time VITE_API_URL override.
//   • The bearer token comes from Houzs's JWT store via readAuthToken()
//     instead of supabase.auth.getSession(); the supabase import and the 401
//     refresh/redirect recovery are removed — a 401 just throws.
//   Everything else (409 short-stock prompt, sofa hard-block, humanApiError)
//   is kept verbatim.
// ---------------------------------------------------------------------------

import { serviceConfirm } from './dialog-service';
// Imported, NOT re-inlined as localStorage.getItem('auth:token'). Houzs stores
// session-only logins (Remember me unchecked, and the owner's view-as hand-off)
// in sessionStorage, so a localStorage-only read returns "" for a perfectly
// authenticated user and every /scm/* page throws not_authenticated. This is
// the vendor auth boundary — it is exactly where the host's answer belongs.
import { readAuthToken } from '../../../lib/authToken';

// `||` not `??`: the CI build inlines VITE_API_URL as an EMPTY STRING when the
// repo var is unset, and `'' ?? default` keeps `''`. PROD fallback is now
// same-origin — /api/* is proxied to the Worker by the Pages Function
// (functions/api/[[path]].ts), avoiding *.workers.dev carrier blocking; local
// `vite dev` has no proxy, so dev keeps the absolute Worker URL.
/* EXPORTED so a caller that must bypass authedFetch (a raw byte stream, which
   this helper JSON-parses) can reuse this base instead of declaring its own.
   `||` not `??` is load-bearing — an empty-string VITE_API_URL must fall back
   to the worker, and `??` would keep the empty string. slip.ts and
   verified-save.ts still declare their own copies of this constant; converging
   those two onto this export is a follow-up, deliberately not done here — both
   carry the same `||` fix today and re-testing their upload paths is outside a
   fleet PR. */
export const API_URL =
  (import.meta.env.VITE_API_URL ||
    (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) +
  '/api/scm';

/* ── Request timeout (ported from 2990 b9d0035c) ───────────────────────────
   A fetch with no timeout hangs the UI forever on a stalled connection — the
   operator stares at "Loading…" with no way out (OCR / slow report endpoints
   are the worst). Apply a default deadline when the caller didn't pass its OWN
   AbortSignal (uploads / cancellable flows control their own); OCR/scan paths
   (/scan-so/extract etc.) get a longer one. A timeout becomes a plain-language
   error; a caller-initiated abort is never rewritten.
   NB: `path` here is the segment AFTER the /api/scm mount, so the /scan- test
   still matches the vendored scan endpoints. */
function timeoutSignal(path: string): AbortSignal | undefined {
  const ms = /\/scan-/.test(path) ? 120_000 : 30_000;
  try { return AbortSignal.timeout(ms); } catch { return undefined; } // pre-2022 browsers
}

async function fetchWithTimeout(url: string, init: RequestInit, path: string): Promise<Response> {
  const callerSignal = init.signal;
  try {
    return await fetch(url, { ...init, signal: callerSignal ?? timeoutSignal(path) });
  } catch (e) {
    if (!callerSignal && e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('The request took too long — please check your connection and try again.');
    }
    throw e;
  }
}

/* Drop-ship confirm (port of 2990 07c45728) — when a sofa ship is blocked
   because no batch is received yet (sofa_no_batch) BUT every affected line is
   bound to a PO (canDropship), the supplier can ship direct. Render the
   approved "Ship as drop-ship?" dialog (incoming PO + ETA + affected codes)
   and, on confirm, the caller replays the request with dropShip:true (stock
   goes negative against the expected batch, nets out + stamps the batch on
   receipt). Returns true on confirm. */
type DropshipOffender = { itemCode: string; soItemId: string | null; poNumber: string | null; eta: string | null };
async function confirmDropship(raw: string): Promise<boolean> {
  try {
    const jsonStart = raw.indexOf('{');
    const body = JSON.parse(raw.slice(jsonStart)) as { dropship?: DropshipOffender[] };
    const offenders = body.dropship ?? [];
    // One bullet per distinct incoming PO: the bound batch + ETA + the sofa
    // codes that ride it. Group by PO so a multi-line set reads as one
    // incoming batch.
    const byPo = new Map<string, { eta: string | null; codes: Set<string> }>();
    for (const o of offenders) {
      if (!o.poNumber) continue;
      const g = byPo.get(o.poNumber) ?? { eta: o.eta, codes: new Set<string>() };
      if (o.itemCode) g.codes.add(o.itemCode);
      byPo.set(o.poNumber, g);
    }
    const poLines = [...byPo.entries()].map(([po, g]) => {
      const eta = g.eta ? `ETA ${g.eta}` : 'ETA not set';
      return `• Incoming PO ${po} (${eta})\n   Sofa: ${[...g.codes].join(', ')}`;
    }).join('\n\n');
    const codes = [...new Set(offenders.map((o) => o.itemCode).filter(Boolean))].join(', ');
    return await serviceConfirm({
      title: 'Ship as drop-ship?',
      body:
        `No batch has been received yet for this sofa set — the supplier ships ` +
        `it direct to the customer.\n\n${poLines}\n\n` +
        `Stock will go negative against ${byPo.size === 1 ? `batch ${[...byPo.keys()][0]}` : 'the incoming batches'}. ` +
        `It nets out and the batch number stamps onto this Delivery Order when ` +
        `the Goods Received Note arrives.\n\nAffected: ${codes}`,
      confirmLabel: 'Confirm drop-ship',
      danger: true,
    });
  } catch {
    return false;
  }
}

/* Edge #J — render the shortage detail out of a 409 short_stock body and ask
   the operator whether to ship anyway (stock goes negative). Returns true on
   confirm; replays the request with confirmShortStock:true. */
async function confirmShortStock(raw: string): Promise<boolean> {
  try {
    const jsonStart = raw.indexOf('{');
    const body = JSON.parse(raw.slice(jsonStart)) as {
      shortages?: Array<{
        itemCode: string; warehouseName: string | null;
        needed: number; available: number; short: number;
        alternatives?: Array<{ warehouseCode: string | null; warehouseName: string | null; available: number }>;
      }>;
    };
    const lines = (body.shortages ?? []).map((s) => {
      const alts = (s.alternatives ?? []).slice(0, 3)
        .map((a) => `${a.warehouseCode ?? a.warehouseName ?? '?'} (${a.available})`)
        .join(', ');
      const altHint = alts ? `\n   Other warehouses: ${alts}` : '';
      return `• ${s.itemCode}\n   At ${s.warehouseName ?? 'this warehouse'}: need ${s.needed}, available ${s.available} (short ${s.short})${altHint}`;
    }).join('\n\n');
    return await serviceConfirm({
      title: 'Stock not enough at the selected warehouse',
      body: `${lines}\n\nShip anyway? (Stock will go negative.)`,
      confirmLabel: 'Ship anyway',
      danger: true,
    });
  } catch {
    return false;
  }
}

export async function authedFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readAuthToken();
  if (!token) throw new Error('not_authenticated');
  // Only stamp content-type: application/json for string bodies (JSON
  // payloads). For FormData (multipart upload) the browser sets the
  // boundary-aware content-type itself — overriding it here breaks the
  // multipart parse on the Worker side (parseBody returns {} → 400).
  // Multi-company (Phase 0c): stamp the active company on every SCM request so
  // the backend's companyContext resolves it. The id is written by the top-bar
  // switcher (src/lib/activeCompany.ts) under 'houzs.activeCompanyId'; read the
  // localStorage key DIRECTLY here to keep this vendored file self-contained
  // (same style as the auth:token read above). Absent → NO header → backend
  // falls back to its hostname default, so single-company Houzs is unchanged.
  const activeCompanyId = (() => {
    try {
      const raw = localStorage.getItem('houzs.activeCompanyId');
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? String(n) : null;
    } catch {
      return null;
    }
  })();
  const headers = {
    ...(init?.headers ?? {}),
    authorization: `Bearer ${token}`,
    ...(activeCompanyId ? { 'X-Company-Id': activeCompanyId } : {}),
    ...(typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {}),
  };
  // Weak-wifi / Hyperdrive cold-start resilience (ported from HOOKKA
  // 2026-06-30 + our core api-client): a transient 503 or network drop on an
  // idempotent GET self-heals on retry instead of surfacing as a failed mobile
  // list. GETs only (mutations aren't safe to replay).
  // Cold-start ride-through (2026-07-04): widened 2→4 to MATCH the desktop
  // api-client (GET_RETRIES=4 / COLD_POOL_RETRIES=4, sw v142). The mobile SCM
  // screens (Orders/SO/Service/Delivery) go through THIS helper, not the core
  // client — the earlier widen missed them, so a cold window still dumped
  // "Couldn't load orders" here. ~10s of spaced retries now rides it out.
  const isGet = !init?.method || String(init.method).toUpperCase() === 'GET';
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchWithTimeout(`${API_URL}${path}`, { ...init, headers }, path);
    } catch (e) {
      if (isGet && attempt < 4) { await new Promise((r) => setTimeout(r, 600 + attempt * 1200)); continue; }
      throw e;
    }
    if (res.status === 503 && isGet && attempt < 4) { await new Promise((r) => setTimeout(r, 600 + attempt * 1200)); continue; }
    // Cold Hyperdrive pool answers 503 with a "database briefly unavailable" body
    // BEFORE the handler/DB runs, so a mutation never executed → safe to retry
    // (no double-write). Retry ONLY this specific cold-pool 503 for mutations, so
    // an SO save early after idle self-heals instead of dumping a raw 503.
    if (res.status === 503 && !isGet && attempt < 4) {
      const warmText = await res.clone().text().catch(() => '');
      if (/briefly unavailable|warming up|try again in a moment/i.test(warmText)) {
        await new Promise((r) => setTimeout(r, 600 + attempt * 1200)); continue;
      }
    }
    break;
  }

  /* Confirmable-409 loop (port of 2990 c3068b28) — a single DO save can trip
     MORE THAN ONE guard at once: short_stock (negative stock) AND sofa_no_batch
     (drop-ship). Each confirm must STACK its flag onto the SAME body — earlier
     one-shot blocks each spread the ORIGINAL init.body, so a drop-ship replay
     dropped a just-confirmed confirmShortStock and the stock guard re-fired
     ("Save failed: Stock not enough" right after Confirm drop-ship). Loop,
     accumulating flags, until the server accepts, the operator declines, or a
     non-confirmable 409 falls through to the terminal handling below. The
     `!== true` guards stop a re-prompt if the flag is already set (a server
     that STILL 409s despite the flag breaks out, no infinite loop); 4-iteration
     cap is a backstop. Body-bearing (mutation) requests only. */
  if (res.status === 409 && typeof init?.body === 'string') {
    let mergedBody: Record<string, unknown> | null = null;
    try { mergedBody = JSON.parse(init.body) as Record<string, unknown>; } catch { mergedBody = null; }
    for (let guard = 0; mergedBody && guard < 4 && res.status === 409; guard++) {
      const text = await res.clone().text();
      if (text.includes('"short_stock"') && mergedBody.confirmShortStock !== true) {
        if (!(await confirmShortStock(text))) break;            // declined → terminal error below
        mergedBody = { ...mergedBody, confirmShortStock: true };
      } else if (
        text.includes('"sofa_no_batch"') && text.includes('"canDropship":true') &&
        mergedBody.dropShip !== true
      ) {
        // Declined drop-ship — deliberate operator choice. Throw a marker the
        // page's onError swallows (mirrors the silent short_stock decline).
        if (!(await confirmDropship(text))) throw new Error('declined_dropship:"sofa_no_batch"');
        mergedBody = { ...mergedBody, dropShip: true };
      } else {
        break; // non-confirmable 409 (no-PO no-batch / partial_set / already-flagged)
      }
      res = await fetchWithTimeout(`${API_URL}${path}`, { ...init, headers, body: JSON.stringify(mergedBody) }, path);
    }
  }

  /* Sofa whole-set HARD block — a sofa set must ship complete from ONE batch.
     A no-PO sofa_no_batch (canDropship absent/false) can't drop-ship, so
     surface the server's plain-English reason (no "ship anyway" retry). */
  if (res.status === 409) {
    const text = await res.clone().text();
    if (text.includes('"sofa_no_batch"')) {
      let msg = "This sofa set can't ship yet — no single production batch on hand covers the whole set. Wait until one complete batch is received.";
      try { const b = JSON.parse(text) as { message?: string }; if (b?.message) msg = b.message; } catch { /* keep fallback */ }
      throw new Error(msg);
    }
    if (text.includes('"sofa_partial_set"')) {
      let msg = "A sofa set must ship whole from one batch — this delivery leaves part of the set behind. Include the rest of the set, or ship none of it.";
      try { const b = JSON.parse(text) as { message?: string }; if (b?.message) msg = b.message; } catch { /* keep fallback */ }
      throw new Error(msg);
    }
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    // Plain-language message for the operator (Wei Siang 2026-06-08: every error
    // shown must be 白话文 — no HTTP codes, no raw JSON, no DB internals). The
    // raw status/body are preserved on the error object for logging / Sentry.
    const err = new Error(humanApiError(res.status, body)) as Error & { status?: number; body?: string };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** One reason a save was rejected, as the backend's aggregated `validation_failed`
 *  response carries them (backend so-save-problems.ts). `line` is the offending
 *  item code; `field` the concrete input to fix. */
export type SaveProblem = { code: string; message: string; line?: string; field?: string };

/** Pull the aggregated problem list out of an API error body (the raw JSON string
 *  authed-fetch stashes on `err.body`). Returns null when the body isn't a
 *  `validation_failed` envelope — callers then fall back to the single message.
 *  Lets a surface render EVERY reason at once (owner 2026-07-18) instead of the
 *  one-at-a-time sequence the backend used to return. */
export function parseSaveProblems(body: string | undefined | null): SaveProblem[] | null {
  if (!body) return null;
  try {
    const j = JSON.parse(body) as { problems?: unknown };
    if (!Array.isArray(j.problems) || j.problems.length === 0) return null;
    return j.problems
      .filter((p): p is SaveProblem => !!p && typeof (p as SaveProblem).message === 'string')
      .map((p) => ({ code: String(p.code ?? ''), message: p.message, line: p.line, field: p.field }));
  } catch {
    return null;
  }
}

/** Build an operator-friendly message from an API failure. Surfaces the
 *  server's own reason ONLY when it's already a plain sentence; otherwise maps
 *  the HTTP status to plain words. Never leaks JSON / SQL / status codes. */
const ERROR_CODE_MESSAGES: Record<string, string> = {
  // Aggregated save gate (backend so-save-problems.ts). A surface that renders
  // the `problems` list itself never reaches this; it's the single-line fallback
  // for surfaces that only read the message.
  validation_failed: 'Some details need fixing before this can be saved.',
  // The idempotency middleware's in-flight 409 (backend/src/middleware/
  // idempotency.ts): the SAME key is already running, i.e. this exact write is
  // mid-flight. That is NOT an error and must never read like one — without this
  // entry it fell through to the generic 409 ("That clashes with something
  // already in the system"), which reads as "it failed, do it again" and invites
  // the very double-submit the key exists to stop.
  //
  // WIDENED 2026-07-17 (fix/so-idempotency): the old wording said "payment",
  // correct while only money call sites sent a key. SO CREATE now sends one, and
  // an order is not a payment — a rep re-pressing Create would have been told a
  // payment was going through, which is simply false and reads as a bug. The
  // sentence is now subject-free so it is true for every opted-in surface;
  // re-read this if a surface ever needs a subject-specific line.
  idempotency_in_flight:
    "This is already going through — give it a moment, then refresh to check. Please don't send it again.",
  duplicate_code:   'That code is already in use. Please choose a different one.',
  phone_required:   'A phone number is required.',
  not_found:        'That item could no longer be found. Please refresh.',
  forbidden:        "You don't have permission to do that.",
  invalid_json:     'Something went wrong sending the request. Please try again.',
  // SO gates — curate the code so the operator never sees the raw sentence's
  // wording drift (owner 2026-07-14: Houzs Processing Date needs only 30%).
  processing_date_unpaid: 'A Processing Date needs at least 30% of the order total collected first.',
  // Defence-in-depth: the SO form blocks this before the request (shared
  // soDateGuardError), so this fires only if a surface forgets the client gate.
  processing_date_remove_forbidden:
    'Only a Super Admin can remove the Processing Date. Removing it pulls the order back out of Proceed — ask a Super Admin to do it.',
  so_sofa_no_other_main:  "A sofa order can't be mixed with bedframe or mattress items — use a separate order.",
  // 2990-owned orders. The live mirror re-applies 2990's version of the order on
  // every sync, so a change saved here would be undone within seconds with
  // nothing shown to the operator — the backend refuses instead of letting them
  // believe it saved.
  so_owned_by_2990:
    'This order belongs to 2990 and can only be changed in 2990. Any change made here would be undone automatically.',
  so_create_blocked_2990:
    'New orders for 2990 have to be created in 2990. An order created here would take a number 2990 is about to use, and would be overwritten.',
  // The add-on amount is folded into the line's selling price and never prints
  // as its own figure, so the description is the only thing on the customer's
  // document that says what the extra charge was for. Naming the field is the
  // whole message here — "add a description" is not actionable if you don't
  // know which box.
  extra_addon_needs_description:
    'A special add-on charge needs a description. Fill in "Describe the special order..." next to the extra charge, or clear the amount.',
};

export function humanApiError(status: number, body: string): string {
  try {
    // 0. Aggregated save gate (validation_failed) — surface EVERY reason at once
    //    as its own line, so a surface that only shows a single string (mobile
    //    error line, PDF, a plain banner) still lists them all instead of one.
    //    Surfaces that render a real list use parseSaveProblems directly.
    const problems = parseSaveProblems(body);
    if (problems && problems.length > 0) {
      return problems.length === 1
        ? problems[0]!.message
        : problems.map((p) => `• ${p.message}`).join('\n');
    }
    const j = JSON.parse(body) as { error?: unknown; reason?: unknown; message?: unknown };
    // 1. Known error code → curated plain message.
    if (typeof j.error === 'string') {
      const mapped = ERROR_CODE_MESSAGES[j.error];
      if (mapped) return mapped;
    }
    // 2. Server reason, but only if it's already a plain sentence (no internals).
    const r = (typeof j.reason === 'string' ? j.reason : typeof j.message === 'string' ? j.message : '') as string;
    // Skip nested JSON blobs (e.g. the raw GoTrue "session_not_found" body the
    // auth middleware forwards verbatim in `reason`) — those must never reach an
    // operator. The `{`-prefix + `error_code` guards catch them; 401s then fall
    // through to the friendly "session has expired" status message below.
    if (
      r && r.length < 200 && !r.trim().startsWith('{') &&
      !/violates|constraint|null value|column|relation|syntax|PGRST|error_code|\b\d{5}\b/i.test(r)
    ) {
      return r;
    }
  } catch { /* body wasn't JSON — fall through to the status map */ }
  if (status === 401) return 'Your session has expired — please sign in again.';
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return 'That item could no longer be found — it may have been changed or removed. Please refresh.';
  if (status === 409) return 'That clashes with something already in the system. Please refresh and check.';
  if (status === 400 || status === 422) return "Some of the details weren't accepted. Please check what you entered and try again.";
  if (status >= 500) return 'The system hit a problem. Please try again — if it keeps happening, let IT know.';
  return 'Something went wrong. Please try again.';
}
