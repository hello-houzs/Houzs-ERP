import {
  cacheable,
  getCached,
  setCached,
  getInflight,
  setInflight,
  invalidateForMutation,
  currentEpoch,
  invalidatedSince,
} from "./cache";
// Multi-company (Phase 0c): stamp the active company on every request. Returns
// {} when no company is selected (single-company / pre-activation), so the
// backend falls back to its hostname default and nothing changes.
import { companyHeader } from "../lib/activeCompany";
// The token's storage key + the read that knows about BOTH backing stores.
// Shared with the vendored SCM fetch layer — see lib/authToken.
import { AUTH_TOKEN_KEY as TOKEN_KEY, readAuthToken } from "../lib/authToken";

// Production default is SAME-ORIGIN: /api/* is proxied to the Worker by the
// Pages Function (functions/api/[[path]].ts). Calling the Worker's
// *.workers.dev origin directly broke for field staff on Malaysian mobile
// carriers that intermittently block that domain (2026-07-09 driver login
// timeouts). VITE_API_URL still overrides (the staging Pages build points at
// the staging Worker); local `vite dev` has no proxy, so dev builds keep the
// absolute workers.dev fallback.
const baseUrl =
  (import.meta.env.VITE_API_URL as string) ||
  (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

// Token storage — the writer. The AuthContext writes here on login/logout.
// The READ lives in lib/authToken so the vendored SCM layer shares it verbatim
// rather than re-deriving which store the token is in.
export const tokenStore = {
  get: readAuthToken,
  /** persistent = true (Remember me) → localStorage, survives browser close.
   *  persistent = false → sessionStorage, cleared when the tab/app closes. */
  set(token: string, persistent = true) {
    try {
      if (persistent) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.removeItem(TOKEN_KEY);
      } else {
        sessionStorage.setItem(TOKEN_KEY, token);
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {}
  },
};

/**
 * Listeners for unauthenticated responses. The AuthContext subscribes
 * to these to log the user out and bounce them back to the login page
 * the moment any request returns 401.
 */
type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

/**
 * Listeners for 403 responses. ToastProvider subscribes so any
 * permission-denied response surfaces a single, friendly toast even
 * if the calling page silently swallows the error.
 */
type ForbiddenListener = (message: string) => void;
const forbiddenListeners = new Set<ForbiddenListener>();
export function onForbidden(fn: ForbiddenListener): () => void {
  forbiddenListeners.add(fn);
  return () => forbiddenListeners.delete(fn);
}

function extractErrorMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {}
  return "";
}

/** Thrown when the server returns a non-OK HTTP status. Distinct from a
 *  network/timeout failure so request() knows NOT to retry it — a 403/404/500
 *  is a real answer, not a transient hang. Message keeps the historic
 *  `"<status>: <body>"` shape that callers and toasts parse. */
/* Turn an HTTP failure into ONE plain-language sentence for the user — never a
   raw "<status>: <json>" dump. Prefer the human message the server already put
   in the JSON body ({error|message|detail}); otherwise map the status code.
   The 503 wording keeps the "briefly unavailable / try again in a moment"
   phrases that isColdPool503() matches on, so cold-pool retry still works. */
/* A machine CODE, not a sentence: snake_case with no spaces. The backend sends
   these in `error` alongside a human `message` (see middleware/idempotency.ts).
   Returning one verbatim shows the operator literal "idempotency_in_flight",
   which is exactly the DB-internals leak this function exists to prevent. */
const isErrorCode = (s: string) => /^[a-z][a-z0-9_]*$/.test(s);

/* Curated plain-language text for codes worth their own wording. Mirrors the
   SCM client's ERROR_CODE_MESSAGES (vendor/scm/lib/authed-fetch.ts); an
   uncurated code falls back to the body's `message`, then the status map. */
const ERROR_CODE_MESSAGES: Record<string, string> = {
  // The idempotency middleware's in-flight 409: this exact write is ALREADY
  // running. That is not a failure and must never read like one — telling the
  // operator it failed invites the double-submit the key exists to prevent.
  idempotency_in_flight:
    "This is already going through — give it a moment, then refresh to check. Please don't send it again.",
};

export function humanHttpMessage(status: number, body: string): string {
  const t = (body ?? "").trim();
  if (t && (t.startsWith("{") || t.startsWith("["))) {
    try {
      const j = JSON.parse(t) as { error?: unknown; message?: unknown; detail?: unknown };
      // A code-shaped `error` is looked up, never shown raw; a sentence-shaped
      // `error` keeps the historic behaviour of being surfaced as-is.
      if (typeof j?.error === "string" && isErrorCode(j.error.trim())) {
        const mapped = ERROR_CODE_MESSAGES[j.error.trim()];
        if (mapped) return mapped;
        const fallback = j?.message ?? j?.detail;
        if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
      } else {
        const m = j?.error ?? j?.message ?? j?.detail;
        if (typeof m === "string" && m.trim()) return m.trim();
      }
    } catch { /* not json — fall through to the status map */ }
  } else if (t && t.length <= 200 && !t.startsWith("<") && !/^\d+\s*:/.test(t)) {
    return t; // a short, human-ish plain-text body (not HTML, not a code dump)
  }
  switch (status) {
    case 400: return "Something in that request wasn't right. Please check and try again.";
    case 401: return "Your session has expired. Please sign in again.";
    case 403: return "You don't have permission to do that.";
    case 404: return "We couldn't find what you were looking for.";
    case 409: return "That conflicts with existing data. Please refresh and try again.";
    case 413: return "That file is too large.";
    case 422: return "Some details couldn't be saved. Please check them and try again.";
    case 429: return "Too many attempts. Please wait a moment and try again.";
    case 503: return "The service is briefly unavailable. Please try again in a moment.";
    default:
      return status >= 500
        ? "Something went wrong on our end. Please try again."
        : "Something went wrong. Please try again.";
  }
}

class HttpError extends Error {
  readonly isHttp = true;
  readonly rawBody: string;
  constructor(public readonly status: number, body: string) {
    super(humanHttpMessage(status, body));
    this.rawBody = body;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Binary upload / download / blob fetches below bypass request()'s GET cap, so
// a stalled Hyperdrive cold-start would hang the UI forever (staff stares at a
// spinner with no way out). Give each its own AbortSignal deadline — generous
// for uploads (large bodies over slow links), tighter for downloads/blobs — and
// translate a timeout into a plain-language retryable error. A caller's own
// abort (if any) is never rewritten.
const UPLOAD_TIMEOUT_MS = 120_000;
const BINARY_GET_TIMEOUT_MS = 60_000;

function binarySignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined; // pre-2022 browsers
  }
}

async function binaryFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const caller = init.signal;
  try {
    return await fetch(url, { ...init, signal: caller ?? binarySignal(timeoutMs) });
  } catch (e) {
    if (!caller && e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error("The server took too long to respond. Please check your connection and try again.");
    }
    throw e;
  }
}

// GET resilience for the Hyperdrive cold-start stall. When the pooled DB
// connection is cold the Worker can hang until the runtime kills it (~30s),
// which the browser surfaces as an opaque "Failed to fetch". GETs are
// idempotent, so each attempt is capped with an AbortController and retried:
// the cap sits ABOVE the ~20s cold-start but BELOW the 30s hang-kill, so a
// slow-but-working query still completes (we never fast-fail it — see
// backend db/pg.ts "fix slow queries, not by capping") and only a true hang
// is aborted, then retried once the connection has had a moment to warm.
// Mutations are NOT retried (not idempotent).
const GET_TIMEOUT_MS = 27_000;
/* Mutations used to be left UNCAPPED — a hung save spun forever and the
   operator walked away believing it had gone through ("人家以为做成功了，然后
   才发现没有" — owner, 2026-07-19). A save must fail LOUDLY, never quietly, so
   a mutation now gets its own deadline and a plain-language failure.
   Deliberately higher than the GET cap: a save legitimately does more work
   (document-number mint, line writes, stock moves) and must not be aborted
   while it is still making progress. This is safe to add ONLY because the
   idempotency middleware landed first — see the message split in request(),
   which is where the abort-a-committed-write hazard is actually handled. */
const MUTATION_TIMEOUT_MS = 45_000;
// Cold-start ride-through (2026-07-04): a Worker isolate that just restarted
// (deploy) OR woke from idle (first user in the morning) opens COLD Hyperdrive
// connections; for a few seconds requests answer 503 "briefly unavailable"
// before self-healing. HOOKKA rarely shows this because it stays warm under
// steady daily traffic — Houzs, under active dev + lighter traffic, hits the
// cold window more. We can't shorten the window (the pg connection layer is the
// months-proven HOOKKA config and MUST NOT gain retries/pool — 2026-06-13), so
// we widen the CLIENT's patience: 4 spaced retries (~10s) rides out a typical
// cold window silently instead of dumping "Couldn't load" on the first tap.
const GET_RETRIES = 4;
// A cold Hyperdrive pool answers with a 503 carrying a "database is briefly
// unavailable" body — raised by the connection layer BEFORE the handler/DB is
// touched, so the request never executed. That makes it safe to retry even for
// a mutation (no double-write). We retry ONLY this specific cold-pool 503; every
// other 503 and all 4xx/5xx still surface as-is.
const COLD_POOL_RETRIES = 4;
const isColdPool503 = (e: HttpError) =>
  e.status === 503 &&
  /briefly unavailable|warming up|try again in a moment/i.test(String(e.message || ""));

async function handleResponse<T>(res: Response, path: string, method = "GET"): Promise<T> {
  if (res.status === 401) {
    // Don't fire on the auth probe endpoints themselves — they're allowed
    // to return 401 without booting the user.
    const isAuthProbe =
      path.startsWith("/api/auth/me") ||
      path.startsWith("/api/auth/login") ||
      path.startsWith("/api/auth/bootstrap") ||
      path.startsWith("/api/auth/accept-invite") ||
      path.startsWith("/api/auth/status");
    if (!isAuthProbe) {
      for (const fn of unauthorizedListeners) fn();
    }
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {}
    if (res.status === 403) {
      const msg = extractErrorMessage(body) || "You don't have permission to do that";
      /* "Off, not hide": a 403 on a background GET read is a query the UI
         shouldn't have fired for this user — it must NEVER surface as a toast
         (that was the "Forbidden: missing …" storm). Only a user-initiated
         write (POST/PATCH/PUT/DELETE) that gets denied shows the toast. The
         proper fix for a leaked read is to gate that query's `enabled:` so it
         never fires; this global guard is the belt-and-braces safety net. */
      if (method !== "GET") {
        for (const fn of forbiddenListeners) fn(msg);
      } else if (import.meta.env?.DEV) {
        console.warn(`[403 suppressed] GET ${path} — gate this query's enabled: ${msg}`);
      }
    }
    throw new HttpError(res.status, body || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// RUM-lite: warn in the console on any request slower than this, so a
// future slow endpoint surfaces itself (the "find the next slow thing" signal —
// how this whole perf campaign started). Pure observability, no behaviour change.
const SLOW_FETCH_MS = 800;

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = tokenStore.get();
  const method = (opts?.method || "GET").toUpperCase();
  const retries = method === "GET" ? GET_RETRIES : 0;
  const isGet = method === "GET";
  // Whether THIS request carried an idempotency key decides what we may honestly
  // tell the operator when it times out — see the two messages below.
  const hasIdemKey = Boolean(
    (opts?.headers as Record<string, string> | undefined)?.["Idempotency-Key"],
  );

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      isGet ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS,
    );
    const startedAt = performance.now();
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...opts,
        signal: ctrl.signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
          ...companyHeader(),
          ...(opts?.headers || {}),
        },
      });
      const ms = Math.round(performance.now() - startedAt);
      if (ms >= SLOW_FETCH_MS) console.warn(`[perf] slow ${method} ${path} — ${ms}ms`);
      return await handleResponse<T>(res, path, method);
    } catch (e) {
      // A 503 is the server's "transient — try again" contract; retry it for
      // idempotent GETs (within the GET budget) so a cold-start / connection
      // blip self-heals instead of surfacing as "Failed to load". Every other
      // HTTP answer (500, 4xx) is a real result — surfaced as-is so genuine
      // errors fail fast and are never masked.
      if (e instanceof HttpError) {
        if (e.status === 503 && method === "GET" && attempt < retries) {
          await sleep(600 + attempt * 1200);
          continue;
        }
        // Cold-pool 503 (DB not yet touched) is safe to retry for mutations too,
        // so a save early after idle doesn't dump a raw 503 on the user.
        if (isColdPool503(e) && method !== "GET" && attempt < COLD_POOL_RETRIES) {
          await sleep(600 + attempt * 1200);
          continue;
        }
        throw e;
      }
      // Network drop or our abort-timeout: retry idempotent GETs, since a
      // cold Hyperdrive connection has usually warmed by the next attempt.
      if (attempt < retries) {
        await sleep(600 + attempt * 1200);
        continue;
      }
      /* The save did not come back. NEVER fail quietly here (owner ruling
         2026-07-19): the operator must be told, in plain words, that it did not
         go through and what to do next.

         The two wordings are NOT cosmetic. Aborting a POST does not abort the
         Worker — the write may already have committed server-side. So:
         • with an Idempotency-Key, a retry REPLAYS the first response instead
           of creating a second document, so "try again" is safe advice;
         • without one, "try again" is how you get a duplicate sales order, so
           we tell them to CHECK first. Telling the truth about our uncertainty
           beats a confident instruction that mints a duplicate. */
      if (!isGet) {
        throw new Error(
          hasIdemKey
            ? "That took too long and didn't go through. Please try saving again."
            : "That took too long and we couldn't confirm whether it saved. Please refresh and check before trying again — saving twice may create a duplicate.",
        );
      }
      throw new Error(
        "Network error — the server took too long to respond. Please try again."
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * GET with the SWR cache: serve fresh-enough cached payloads instantly,
 * join an identical in-flight request instead of duplicating it, and
 * fall through to the network otherwise. Mutations below invalidate the
 * touched resource family so the next read is fresh.
 */
function cachedGet<T>(path: string): Promise<T> {
  if (!cacheable(path)) return request<T>(path);
  const hit = getCached<T>(path);
  if (hit !== undefined) return Promise.resolve(hit);
  const joined = getInflight<T>(path);
  if (joined) return joined;
  // Capture the invalidation clock at request start. If a mutation invalidates
  // this resource family while the request is in flight, we must NOT cache the
  // (now-stale) response when it resolves.
  const startedEpoch = currentEpoch();
  const p = request<T>(path).then((data) => {
    if (data !== undefined && !invalidatedSince(path, startedEpoch)) setCached(path, data);
    return data;
  });
  setInflight(path, p);
  return p;
}

function mutate<T>(path: string, opts: RequestInit): Promise<T> {
  return request<T>(path, opts).then((r) => {
    invalidateForMutation(path);
    return r;
  });
}

/** Per-call mutation options. `idempotencyKey` opts this write into the backend
 *  idempotency middleware, so a retry replays the first response instead of
 *  creating a second document. Mint it with newIdempotencyKey/useIdempotencyKey
 *  from lib/idempotency — read that module's rules first: a key minted per
 *  CLICK is a fix that does nothing, and a key derived from the PAYLOAD is a fix
 *  that loses money. */
export type MutateOpts = { idempotencyKey?: string };

const idemHeader = (o?: MutateOpts) =>
  o?.idempotencyKey ? { "Idempotency-Key": o.idempotencyKey } : undefined;

export const api = {
  baseUrl,
  get: <T>(p: string) => cachedGet<T>(p),
  post: <T>(p: string, b?: any, o?: MutateOpts) =>
    mutate<T>(p, {
      method: "POST",
      body: b ? JSON.stringify(b) : undefined,
      headers: idemHeader(o),
    }),
  patch: <T>(p: string, b: any, o?: MutateOpts) =>
    mutate<T>(p, { method: "PATCH", body: JSON.stringify(b), headers: idemHeader(o) }),
  put: <T>(p: string, b: any, o?: MutateOpts) =>
    mutate<T>(p, { method: "PUT", body: JSON.stringify(b), headers: idemHeader(o) }),
  del: <T>(p: string, o?: MutateOpts) =>
    mutate<T>(p, { method: "DELETE", headers: idemHeader(o) }),

  /**
   * Raw binary upload — used for POD photos and signatures. Skips the
   * default Content-Type: application/json header.
   */
  async putBinary<T>(path: string, body: Blob | ArrayBuffer, contentType: string): Promise<T> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      method: "PUT",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": contentType,
        ...companyHeader(),
      },
      body,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new HttpError(res.status, txt || res.statusText);
    }
    return (await res.json()) as T;
  },

  /**
   * Raw binary POST — same contract as putBinary but for endpoints that
   * create-or-replace via POST (e.g. the Branding logo upload).
   */
  async postBinary<T>(path: string, body: Blob | ArrayBuffer, contentType: string): Promise<T> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": contentType,
        ...companyHeader(),
      },
      body,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new HttpError(res.status, txt || res.statusText);
    }
    return (await res.json()) as T;
  },

  /**
   * Multipart upload — POSTs a FormData with one or more files under
   * `fieldName`. Crucially we do NOT set Content-Type: the browser must set
   * `multipart/form-data; boundary=…` itself, so we only attach the bearer.
   * Mirrors putBinary's auth + error handling. Used for the SCM SO / CO
   * per-line photo endpoints (each POST takes a single `file`, so the typical
   * caller loops uploadFile per staged photo).
   */
  async uploadFiles<T>(path: string, files: File[], fieldName = "files"): Promise<T> {
    const token = tokenStore.get();
    const form = new FormData();
    for (const f of files) form.append(fieldName, f);
    const res = await binaryFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...companyHeader() },
      body: form,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new HttpError(res.status, txt || res.statusText);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  },

  /** Single-file multipart upload (one `fieldName` part). Thin wrapper over
   *  uploadFiles for the common one-file-per-request routes. */
  uploadFile<T>(path: string, file: File, fieldName = "file"): Promise<T> {
    return this.uploadFiles<T>(path, [file], fieldName);
  },

  /**
   * Fetches a protected asset (e.g. R2-backed POD photo) as a blob URL,
   * because <img src> can't pass the Authorization header.
   */
  async fetchBlobUrl(path: string): Promise<string> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...companyHeader() },
    }, BINARY_GET_TIMEOUT_MS);
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },

  /**
   * Fetch an auth-protected HTML document and open it in a new tab via
   * blob: URL. Used for the ASSR print/PDF view where we can't just
   * window.open() the endpoint directly (no way to attach the bearer).
   */
  /**
   * Download a server-generated file (e.g. CSV export) honoring the
   * bearer token. Browsers can't attach Authorization to a plain
   * <a download>, so we fetch + blob: + click an off-DOM anchor.
   */
  async downloadFile(path: string, fallbackName = "download"): Promise<void> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...companyHeader() },
    }, BINARY_GET_TIMEOUT_MS);
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : fallbackName;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  async openHtml(path: string): Promise<void> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...companyHeader() },
    }, BINARY_GET_TIMEOUT_MS);
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    const html = await res.text();
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    // Revoke after the new tab has had time to parse; instant revoke breaks some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
