// Active-company store — Phase 0c of the multi-company merge.
//
// Holds the id of the company the top-bar switcher currently has selected,
// persisted to localStorage so it survives a reload. The two authed fetch
// layers (src/api/client.ts and src/vendor/scm/lib/authed-fetch.ts) read the
// stored id and, WHEN SET, stamp an `X-Company-Id` header on every request so
// the backend's companyContext middleware resolves that company. When UNSET
// (the pre-activation default, and any single-company install) NO header is
// sent and the backend falls back to its hostname default — so single-company
// Houzs is behaviourally unchanged.
//
// Plain module + a tiny pub/sub so it's readable synchronously from the
// non-React fetch modules AND subscribable from React via useSyncExternalStore.
// The localStorage KEY is duplicated (not imported) inside the vendored
// authed-fetch to keep that vendored file self-contained — keep them in sync.

export const ACTIVE_COMPANY_KEY = "houzs.activeCompanyId";

function read(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_COMPANY_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/** Current active company id, or null when unset (→ no X-Company-Id header). */
export function getActiveCompanyId(): number | null {
  return read();
}

/** Header object to spread into a fetch init — `{}` when unset, so a plain
 *  `{ ...headers, ...companyHeader() }` is a no-op on single-company installs. */
export function companyHeader(): Record<string, string> {
  const id = read();
  return id !== null ? { "X-Company-Id": String(id) } : {};
}

/** Set (or clear, with null) the active company and notify subscribers. */
export function setActiveCompanyId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_COMPANY_KEY);
    else localStorage.setItem(ACTIVE_COMPANY_KEY, String(id));
  } catch {}
  for (const fn of listeners) fn();
}

export function subscribeActiveCompany(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stable snapshot for useSyncExternalStore. */
export function getActiveCompanySnapshot(): number | null {
  return read();
}
