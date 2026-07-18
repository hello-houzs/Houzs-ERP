// Minimal fetch client for the Customer Portal. All requests carry a
// per-case token in the Authorization header. The token is read from
// the URL (/portal/case/:token) by the page component and passed in
// here explicitly — we deliberately do not persist it in localStorage
// so the auth is scoped exactly to whoever has the link.
//
// `baseUrl` resolves to the Worker at build time via VITE_API_URL
// (see frontend/.env.production). On dev it's empty so the Vite
// proxy handles forwarding.
import { humanHttpMessage } from "../api/client";

// PROD default is same-origin — /api/* is proxied to the Worker by the Pages
// Function (functions/api/[[path]].ts); portal links open on customers'
// phones, where *.workers.dev is unreliable on some MY carriers.
import { API_ORIGIN } from "../lib/apiBase";

const baseUrl = API_ORIGIN;

function url(path: string): string {
  return path.startsWith("http") ? path : `${baseUrl}${path}`;
}

export class PortalApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// No timeout here means a stalled Hyperdrive cold-start hangs the portal
// forever (the customer stares at a spinner). Cap each fetch with an
// AbortSignal — generous for binary uploads, tighter for JSON/blob — and turn
// a timeout into a plain-language, retryable error.
const PORTAL_UPLOAD_TIMEOUT_MS = 120_000;
const PORTAL_TIMEOUT_MS = 60_000;

function portalSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined; // pre-2022 browsers
  }
}

async function portalFetch(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: portalSignal(timeoutMs) });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new PortalApiError(0, "The server took too long to respond. Please check your connection and try again.");
    }
    throw e;
  }
}

async function req<T>(
  method: string,
  path: string,
  token: string | null,
  body?: any,
  isBinary = false
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (!isBinary && body !== undefined) headers["Content-Type"] = "application/json";
  const res = await portalFetch(url(path), {
    method,
    headers,
    body: isBinary ? (body as ArrayBuffer) : body !== undefined ? JSON.stringify(body) : undefined,
  }, isBinary ? PORTAL_UPLOAD_TIMEOUT_MS : PORTAL_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Plain-language message for the customer — never a raw status code, JSON
    // blob, or HTML error page (humanHttpMessage prefers the server's own
    // {error|message|detail} sentence, else maps the status to plain words).
    throw new PortalApiError(res.status, humanHttpMessage(res.status, text));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const portalApi = {
  get:  <T>(path: string, token: string) => req<T>("GET", path, token),
  post: <T>(path: string, token: string | null, body?: any) => req<T>("POST", path, token, body),
  put:  <T>(path: string, token: string | null, body?: any) => req<T>("PUT", path, token, body),

  putBinary: async <T>(path: string, token: string, body: ArrayBuffer, contentType: string): Promise<T> => {
    const res = await portalFetch(url(path), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
      },
      body,
    }, PORTAL_UPLOAD_TIMEOUT_MS);
    if (!res.ok) throw new PortalApiError(res.status, humanHttpMessage(res.status, await res.text().catch(() => "")));
    return (await res.json()) as T;
  },

  async fetchBlobUrl(path: string, token: string): Promise<string> {
    const res = await portalFetch(url(path), { headers: { Authorization: `Bearer ${token}` } }, PORTAL_TIMEOUT_MS);
    if (!res.ok) throw new PortalApiError(res.status, humanHttpMessage(res.status, ""));
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
};
