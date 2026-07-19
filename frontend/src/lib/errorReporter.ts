// ---------------------------------------------------------------------------
// Self-hosted client error reporter (owner ruling: no Sentry).
//
// Every uncaught frontend error becomes a row in the backend's client_errors
// table (POST /api/client-errors) so IT hears about white-screens from the
// daily digest instead of from a user's complaint. Three capture paths feed it:
//   1. window "error"            -- uncaught synchronous errors
//   2. window "unhandledrejection" -- unawaited promise failures (the classic
//      "read {success,data} without unwrapping" class often dies here)
//   3. reportClientError()       -- called by ChunkReloadBoundary's
//      componentDidCatch for render crashes React catches before the window
//      ever sees them
//
// PRIME DIRECTIVE: reporting must NEVER change behaviour.
//   - Every entry point is wrapped so a reporter bug is swallowed, not thrown.
//   - An error raised INSIDE the reporter is dropped, never re-reported (the
//     `inReporter` latch) -- no feedback loops.
//   - The boundary still renders its fallback, the console still logs; this
//     module only ADDS a network side-channel.
//
// PRIVACY: an event carries message, stack (capped 4KB), route PATHNAME ONLY
// (never the query string -- reset/invite tokens and filter data live there),
// build id, userAgent, timestamp. No form values, no request bodies, no
// tokens. Identity is NOT sent -- the server stamps user/company from the
// session and ignores anything else.
//
// TRANSPORT: batch + debounce. Events queue and flush after 10s or at 10
// queued, POSTed with the same bearer + company header the app's fetch layer
// uses, keepalive:true so a tab close doesn't lose the batch. A flush failure
// drops the batch silently -- this is telemetry, not business data.
//
// STORM CONTROL (client side; the server dedups again on top):
//   - per-signature cap: the same message+route reports at most 10 times per
//     page load, so a render loop cannot chew bandwidth
//   - session cap: at most 100 events per page load, total
//
// PROD-BUILD ONLY: dev builds point their API at the deployed Worker (see
// api/client.ts baseUrl), so reporting from `vite dev` would pollute real
// telemetry with localhost experiments. Staging Pages builds are prod builds,
// so the pipeline is still exercised before production.
// ---------------------------------------------------------------------------

import { api } from "../api/client";
import { readAuthToken } from "./authToken";
import { companyHeader } from "./activeCompany";

declare const __BUILD_ID__: string;
const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

const FLUSH_MS = 10_000;
const FLUSH_AT = 10; // queue length that triggers an immediate flush
const MAX_STACK = 4000; // server re-caps at 4096
const MAX_MESSAGE = 500;
const PER_SIGNATURE_CAP = 10;
const SESSION_CAP = 100;

interface ErrorEventPayload {
  message: string;
  stack?: string;
  route: string;
  buildId: string;
  userAgent: string;
  occurredAt: string;
}

const queue: ErrorEventPayload[] = [];
const signatureCounts = new Map<string, number>();
let sessionCount = 0;
let flushTimer: number | null = null;
let installed = false;
// Latch: true while reporter code is on the stack, so an error the reporter
// itself raises can never re-enter capture (the no-loop guarantee).
let inReporter = false;

// Benign browser noise with no fix on our side. Deliberately tiny -- every
// entry here is an error IT will never see, so it must be provably harmless.
const IGNORED = [
  /^ResizeObserver loop/i,
  // Cross-origin scripts surface as exactly this string with no stack; there
  // is nothing actionable in it.
  /^Script error\.?$/i,
];

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err).slice(0, MAX_MESSAGE);
  } catch {
    return String(err);
  }
}

function toStack(err: unknown): string | undefined {
  if (err instanceof Error && err.stack) return err.stack.slice(0, MAX_STACK);
  return undefined;
}

function enqueue(message: string, stack: string | undefined): void {
  const msg = (message || "").trim().slice(0, MAX_MESSAGE);
  if (!msg) return;
  if (IGNORED.some((re) => re.test(msg))) return;
  if (sessionCount >= SESSION_CAP) return;

  // Pathname only. location.pathname cannot carry a query string, but be
  // explicit so a future caller passing a full URL is still safe.
  const route = window.location.pathname.split("?")[0].split("#")[0];

  const sig = `${msg}|${route}`;
  const n = signatureCounts.get(sig) ?? 0;
  if (n >= PER_SIGNATURE_CAP) return;
  signatureCounts.set(sig, n + 1);
  sessionCount++;

  queue.push({
    message: msg,
    stack,
    route,
    buildId: BUILD_ID,
    userAgent: navigator.userAgent.slice(0, 400),
    occurredAt: new Date().toISOString(),
  });

  if (queue.length >= FLUSH_AT) {
    flush();
  } else if (flushTimer === null) {
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_MS);
  }
}

function flush(): void {
  if (queue.length === 0) return;
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  const token = readAuthToken();
  if (!token) {
    // No session -> the endpoint would 401. Drop rather than hold: a login
    // screen's errors are not worth a growing in-memory queue.
    queue.length = 0;
    return;
  }
  const events = queue.splice(0, queue.length);
  try {
    // Raw fetch on purpose, NOT api.post(): the app client retries, fires 401
    // logout + 403 toast listeners, and invalidates SWR caches -- all behaviour
    // changes a crash reporter must never cause. keepalive lets the batch
    // survive a tab close / the reload the user is about to click.
    void fetch(`${api.baseUrl}/api/client-errors`, {
      method: "POST",
      keepalive: true,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...companyHeader(),
      },
      body: JSON.stringify({ events }),
    }).catch(() => {
      // Server unreachable / 4xx / 5xx: drop. Telemetry loss is acceptable;
      // retry loops against a down backend are not.
    });
  } catch {
    // Even building the request must never throw into app code.
  }
}

/**
 * Report an error that was already caught elsewhere (the React error
 * boundary). Safe to call from anywhere: never throws, never loops, no-ops in
 * dev builds and before install.
 */
export function reportClientError(err: unknown, context?: string): void {
  if (!installed || inReporter) return;
  inReporter = true;
  try {
    const base = toMessage(err);
    enqueue(context ? `[${context}] ${base}` : base, toStack(err));
  } catch {
    // A reporter bug is dropped, never surfaced.
  } finally {
    inReporter = false;
  }
}

/**
 * Install the window-level capture (error + unhandledrejection). Call once at
 * boot, before React renders, so even a crash during the first render is
 * captured. Idempotent; no-ops on dev builds.
 */
export function installGlobalErrorReporting(): void {
  if (installed || !import.meta.env.PROD) return;
  installed = true;

  window.addEventListener("error", (event: Event) => {
    if (inReporter) return;
    inReporter = true;
    try {
      const ev = event as globalThis.ErrorEvent;
      // Non-capture listener: resource load failures (img/script tags) do not
      // bubble to window, so only real script errors arrive here.
      const err = ev.error ?? ev.message;
      enqueue(toMessage(err), toStack(ev.error));
    } catch {
      // dropped
    } finally {
      inReporter = false;
    }
  });

  window.addEventListener("unhandledrejection", (event: Event) => {
    if (inReporter) return;
    inReporter = true;
    try {
      const reason = (event as PromiseRejectionEvent).reason;
      enqueue(toMessage(reason), toStack(reason));
    } catch {
      // dropped
    } finally {
      inReporter = false;
    }
  });

  // Last-chance flush when the page is going away (covers the user smashing
  // reload on a white screen -- exactly the moment we most need the report).
  window.addEventListener("pagehide", () => {
    try {
      flush();
    } catch {
      // dropped
    }
  });
  document.addEventListener("visibilitychange", () => {
    try {
      if (document.visibilityState === "hidden") flush();
    } catch {
      // dropped
    }
  });
}
