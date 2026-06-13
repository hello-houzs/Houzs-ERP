// Lightweight SWR-style cache for api.get(): short-TTL memory cache +
// in-flight request dedup + cross-tab invalidation. Pattern lifted from
// Hookka ERP's cached-fetch layer, trimmed to what Houzs needs today.
//
// Effect: navigating between pages re-renders instantly from cache instead
// of refetching every panel (the old useQuery refetched on every mount),
// and double-mounted components share one network request. Mutations
// (post/patch/put/del in client.ts) invalidate the whole resource family
// (`/api/projects/123/archive` clears every `/api/projects*` entry) in this
// tab and, via BroadcastChannel, in every other open tab.

const TTL_MS = 15_000;

// Never cache: auth probes (login state must always be live), the project
// chat/activity feed (polled every 3s — staleness would delay messages),
// and presence (who-is-online must stay live).
const NEVER_CACHE = [/^\/api\/auth\//, /\/activity(\?|$)/, /^\/api\/presence/];

type Entry = { at: number; data: unknown };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

let bc: BroadcastChannel | null = null;
try {
  bc = new BroadcastChannel("houzs-api-cache");
  bc.onmessage = (e: MessageEvent) => {
    if (e.data && e.data.t === "inv") invalidateLocal(String(e.data.p));
  };
} catch {
  bc = null; // older browsers: cache still works, just not cross-tab
}

export function cacheable(path: string): boolean {
  return !NEVER_CACHE.some((r) => r.test(path));
}

export function getCached<T>(path: string): T | undefined {
  const e = store.get(path);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) {
    store.delete(path);
    return undefined;
  }
  return e.data as T;
}

export function setCached(path: string, data: unknown): void {
  store.set(path, { at: Date.now(), data });
}

export function getInflight<T>(path: string): Promise<T> | undefined {
  return inflight.get(path) as Promise<T> | undefined;
}

export function setInflight(path: string, p: Promise<unknown>): void {
  inflight.set(path, p);
  p.finally(() => inflight.delete(path)).catch(() => {});
}

function invalidateLocal(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

/** Drop every cached GET whose path starts with `prefix`, in all tabs. */
export function invalidate(prefix: string): void {
  invalidateLocal(prefix);
  try {
    bc?.postMessage({ t: "inv", p: prefix });
  } catch {}
}

/** A mutation on `/api/<resource>/...` invalidates that whole resource. */
export function invalidateForMutation(path: string): void {
  const m = path.match(/^(\/api\/[^/?]+)/);
  if (m) invalidate(m[1]);
}
