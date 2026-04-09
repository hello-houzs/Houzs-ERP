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
    throw new Error(`${res.status}: ${body || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  baseUrl,
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, b?: any) =>
    request<T>(p, { method: "POST", body: b ? JSON.stringify(b) : undefined }),
  patch: <T>(p: string, b: any) =>
    request<T>(p, { method: "PATCH", body: JSON.stringify(b) }),
  put: <T>(p: string, b: any) =>
    request<T>(p, { method: "PUT", body: JSON.stringify(b) }),
  del: <T>(p: string) => request<T>(p, { method: "DELETE" }),

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
};

export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
