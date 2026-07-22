// Active-company store — Phase 0c of the multi-company merge.
//
// Holds the id of the company the top-bar switcher currently has selected,
// persisted so it survives a reload AND the next login (see the two stores
// described below, and the note on why the key is user-scoped). The authed fetch
// layers (src/api/client.ts and src/vendor/scm/lib/authed-fetch.ts) read the
// stored id and, WHEN SET, stamp an `X-Company-Id` header on every request so
// the backend's companyContext middleware resolves that company. When UNSET
// (the pre-activation default, and any single-company install) NO header is
// sent and the backend falls back to its hostname default — so single-company
// Houzs is behaviourally unchanged.
//
// Plain module + a tiny pub/sub so it's readable synchronously from the
// non-React fetch modules AND subscribable from React via useSyncExternalStore.
// Every request path, including the vendored SCM clients, reads through this
// module so another signed-in tab cannot silently change this tab's tenant
// header.
//
// ── WHY THE KEY IS SCOPED BY USER, NOT BY TOKEN ────────────────────────────
// An earlier revision keyed the stored id on a hash of the bearer token. A
// token changes on EVERY login, so the key changed on every login and the
// user's company selection was silently dropped each time — while the switcher
// still rendered a company name. Silently reverting a user's tenant is the one
// failure mode this module exists to prevent, so the durable record is now
// keyed by the /auth/me user id, which is stable across re-logins:
//
//   localStorage   houzs.activeCompanyId.v2   {"u<userId>": <companyId>}
//                  Durable, survives logout/login and browser restart.
//   sessionStorage houzs.activeCompanyId.tab  {"user":<id|null>,"company":<id>}
//                  THIS TAB's answer. sessionStorage is per-tab and survives a
//                  reload, so a second tab signed in as somebody else can never
//                  steer this tab's header, and the header is available
//                  synchronously on reload before /auth/me resolves.
//
// The user id only becomes known when /auth/me resolves, so a brand-new tab
// (or the first render after a login) has no answer yet and sends NO header —
// the backend hostname default, which is the same thing an unset selection has
// always meant. AuthContext calls adoptActiveCompanyForUser() the moment the
// id is known, before the app mounts, so no page ever renders under the wrong
// company.

export const ACTIVE_COMPANY_KEY = "houzs.activeCompanyId";
// Concatenation, not a template literal: the browser-storage registry test
// resolves `const X = "a" + "b"` when it inventories literal keys, and a
// template expression would make these two keys invisible to that audit.
/** Durable per-user record. */
export const ACTIVE_COMPANY_BY_USER_KEY = ACTIVE_COMPANY_KEY + ".v2";
/** This tab's resolved pick. */
export const ACTIVE_COMPANY_TAB_KEY = ACTIVE_COMPANY_KEY + ".tab";

type TabPick = { user: number | null; company: number };

/** Who this tab is signed in as, once /auth/me has said so. */
let boundUserId: number | null = null;

const validId = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function readByUser(): Record<string, number> {
  try {
    const raw = localStorage.getItem(ACTIVE_COMPANY_BY_USER_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^u\d+$/.test(key) && validId(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeByUser(userId: number, companyId: number | null): void {
  try {
    const next = readByUser();
    if (companyId === null) delete next[`u${userId}`];
    else next[`u${userId}`] = companyId;
    localStorage.setItem(ACTIVE_COMPANY_BY_USER_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled (private mode): the tab pick below still works for this
    // session; only durability across a restart is lost.
  }
}

function readTabPick(): TabPick | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_COMPANY_TAB_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const pick = parsed as Partial<TabPick>;
    if (!validId(pick.company)) return null;
    const user = pick.user === null || validId(pick.user) ? pick.user ?? null : null;
    return { user, company: pick.company };
  } catch {
    return null;
  }
}

function writeTabPick(pick: TabPick | null): void {
  try {
    if (pick === null) sessionStorage.removeItem(ACTIVE_COMPANY_TAB_KEY);
    else sessionStorage.setItem(ACTIVE_COMPANY_TAB_KEY, JSON.stringify(pick));
  } catch {}
}

/** Drop the ownerless pre-v2 keys: the original origin-wide
 *  `houzs.activeCompanyId` and the short-lived `houzs.activeCompanyId:<token
 *  hash>` variants. They are deliberately NOT migrated into the per-user map —
 *  neither one records WHOSE selection it was, and seeding the wrong user's
 *  tenant is exactly the failure this module must not commit. A user re-picks
 *  once; until then the switcher shows the company the backend actually
 *  resolved, never a guess. */
function purgeLegacyKeys(): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null) continue;
      if (key === ACTIVE_COMPANY_KEY || key.startsWith(`${ACTIVE_COMPANY_KEY}:`)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {}
}

function read(): number | null {
  return readTabPick()?.company ?? null;
}

export type ActiveCompanyChangeSource = "same-tab" | "storage";
type ActiveCompanyListener = (source: ActiveCompanyChangeSource) => void;
const listeners = new Set<ActiveCompanyListener>();

function emit(source: ActiveCompanyChangeSource): void {
  for (const fn of listeners) fn(source);
}

// A `storage` event fires only in the OTHER tabs, and the durable map is shared
// by every signed-in user on this browser. React ONLY when the entry for the
// user this tab is signed in as actually changed — another account switching
// company in its own tab must not reload this one.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== ACTIVE_COMPANY_BY_USER_KEY) return;
    const pick = readTabPick();
    if (pick?.user == null) return;
    const durable = readByUser()[`u${pick.user}`] ?? null;
    if (durable === null || durable === pick.company) return;
    writeTabPick({ user: pick.user, company: durable });
    emit("storage");
  });
}

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

/** Set (or clear, with null) the active company and notify subscribers.
 *  Writes the durable per-user record too, so the pick survives the next login
 *  instead of dying with this token. */
export function setActiveCompanyId(id: number | null): void {
  const user = readTabPick()?.user ?? boundUserId;
  if (id === null) writeTabPick(null);
  else writeTabPick({ user, company: id });
  if (user !== null) writeByUser(user, id);
  emit("same-tab");
}

/**
 * Called the moment /auth/me tells us WHO this tab is. Adopts that user's
 * durable pick when this tab has none, and discards a pick left behind by a
 * different account. Returns the resolved id so callers do not have to re-read.
 */
export function adoptActiveCompanyForUser(userId: number): number | null {
  purgeLegacyKeys();
  boundUserId = userId;
  const pick = readTabPick();
  const durable = readByUser()[`u${userId}`] ?? null;

  // This tab already made a pick as this user (e.g. a reload) — keep it, and
  // make sure the durable record agrees.
  if (pick && pick.user === userId) {
    if (durable !== pick.company) writeByUser(userId, pick.company);
    return pick.company;
  }

  // A pick with no owner can only have come from this same tab before the id
  // was known, so it belongs to this user; claim it. A pick owned by SOMEBODY
  // ELSE is discarded rather than inherited.
  const claimed = pick && pick.user === null ? pick.company : durable;
  const before = pick?.company ?? null;
  if (claimed === null) {
    if (pick) writeTabPick(null);
  } else {
    writeTabPick({ user: userId, company: claimed });
    writeByUser(userId, claimed);
  }
  if (before !== claimed) emit("same-tab");
  return claimed;
}

/** Forget who this tab is. The durable per-user record is deliberately kept —
 *  it is the thing that makes a selection survive the next login. */
export function releaseActiveCompanyBinding(): void {
  boundUserId = null;
}

export function subscribeActiveCompany(fn: ActiveCompanyListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True when SOMEBODY on this browser has ever picked a company. Lets a caller
 *  tell "single-company install, nothing to pick" apart from "multi-company
 *  install, this tab has not resolved its tenant yet" — two states that both
 *  read as `getActiveCompanyId() === null`. */
export function hasStoredCompanySelection(): boolean {
  return Object.keys(readByUser()).length > 0;
}

/** Stable snapshot for useSyncExternalStore. */
export function getActiveCompanySnapshot(): number | null {
  return read();
}
