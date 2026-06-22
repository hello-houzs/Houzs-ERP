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

// Cloudflare Pages does NOT proxy /api/* (see public/_redirects) — a relative
// base returns SPA HTML to JSON fetches ("Unexpected token '<'"). Default to the
// Worker's absolute URL so the app works even if VITE_API_URL is unset at build
// (the gitignored .env.production went missing, which broke every API call).
const baseUrl =
  (import.meta.env.VITE_API_URL as string) ||
  "https://autocount-sync-api.houzs-erp.workers.dev";

// Token storage — single source of truth for the bearer token. The
// AuthContext writes here on login/logout; everything else reads.
const TOKEN_KEY = "auth:token";

export const tokenStore = {
  get(): string {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
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
class HttpError extends Error {
  readonly isHttp = true;
  constructor(public readonly status: number, body: string) {
    super(`${status}: ${body}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GET resilience for the Hyperdrive cold-start stall. When the pooled DB
// connection is cold the Worker can hang until the runtime kills it (~30s),
// which the browser surfaces as an opaque "Failed to fetch". GETs are
// idempotent, so each attempt is capped with an AbortController and retried:
// the cap sits ABOVE the ~20s cold-start but BELOW the 30s hang-kill, so a
// slow-but-working query still completes (we never fast-fail it — see
// backend db/pg.ts "fix slow queries, not by capping") and only a true hang
// is aborted, then retried once the connection has had a moment to warm.
// Mutations are NOT retried (not idempotent) and are left uncapped.
const GET_TIMEOUT_MS = 27_000;
const GET_RETRIES = 2;

async function handleResponse<T>(res: Response, path: string): Promise<T> {
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
      for (const fn of forbiddenListeners) fn(msg);
    }
    throw new HttpError(res.status, body || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = tokenStore.get();
  const method = (opts?.method || "GET").toUpperCase();
  const retries = method === "GET" ? GET_RETRIES : 0;

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer =
      method === "GET" ? setTimeout(() => ctrl.abort(), GET_TIMEOUT_MS) : null;
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...opts,
        signal: ctrl.signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
          ...(opts?.headers || {}),
        },
      });
      return await handleResponse<T>(res, path);
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
        throw e;
      }
      // Network drop or our abort-timeout: retry idempotent GETs, since a
      // cold Hyperdrive connection has usually warmed by the next attempt.
      if (attempt < retries) {
        await sleep(600 + attempt * 1200);
        continue;
      }
      throw new Error(
        "Network error — the server took too long to respond. Please try again."
      );
    } finally {
      if (timer) clearTimeout(timer);
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

export const api = {
  baseUrl,
  get: <T>(p: string) => cachedGet<T>(p),
  post: <T>(p: string, b?: any) =>
    mutate<T>(p, { method: "POST", body: b ? JSON.stringify(b) : undefined }),
  patch: <T>(p: string, b: any) =>
    mutate<T>(p, { method: "PATCH", body: JSON.stringify(b) }),
  put: <T>(p: string, b: any) =>
    mutate<T>(p, { method: "PUT", body: JSON.stringify(b) }),
  del: <T>(p: string) => mutate<T>(p, { method: "DELETE" }),

  /**
   * Raw binary upload — used for POD photos and signatures. Skips the
   * default Content-Type: application/json header.
   */
  async putBinary<T>(path: string, body: Blob | ArrayBuffer, contentType: string): Promise<T> {
    const token = tokenStore.get();
    const res = await fetch(`${baseUrl}${path}`, {
      method: "PUT",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": contentType,
      },
      body,
    });
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new Error(`${res.status}: ${txt || res.statusText}`);
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
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new Error(`${res.status}: ${txt || res.statusText}`);
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
    const res = await fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
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
    const res = await fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
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
    const res = await fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
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
