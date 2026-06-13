import {
  cacheable,
  getCached,
  setCached,
  getInflight,
  setInflight,
  invalidateForMutation,
} from "./cache";

const baseUrl = (import.meta.env.VITE_API_URL as string) || "";

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

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...(opts?.headers || {}),
    },
  });
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
    throw new Error(`${res.status}: ${body || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
  const p = request<T>(path).then((data) => {
    if (data !== undefined) setCached(path, data);
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
