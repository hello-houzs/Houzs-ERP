// Where the bearer token lives — the single answer, for both the Houzs-native
// fetch layer (src/api/client.ts) and the vendored SCM one (src/vendor/scm/...).
//
// There are TWO backing stores, because login offers a choice:
//   • "Remember me" checked  → localStorage   (survives browser close)
//   • unchecked              → sessionStorage (dies with the tab)
//   • the owner's view-as hand-off (src/main.tsx) → sessionStorage, always
// A reader that knows about only one of them is not reading "the token", it is
// reading "the token IF the user happened to tick a box". Every reader must go
// through readAuthToken so that choice stays invisible to callers.
//
// This module exists because the vendored layer read localStorage directly and
// five call sites went silently unauthenticated for session-only logins, taking
// the whole /scm/* surface down with a raw `not_authenticated`. Do not inline
// `localStorage.getItem('auth:token')` anywhere — call this instead.

export const AUTH_TOKEN_KEY = "auth:token";

type AuthTokenListener = (token: string) => void;
const authTokenListeners = new Set<AuthTokenListener>();

/** The current bearer token, from whichever store login put it in. "" = none. */
export function readAuthToken(): string {
  try {
    return (
      localStorage.getItem(AUTH_TOKEN_KEY) ||
      sessionStorage.getItem(AUTH_TOKEN_KEY) ||
      ""
    );
  } catch {
    return "";
  }
}

/** Subscribe to explicit token lifecycle changes made through tokenStore. */
export function subscribeAuthTokenChange(listener: AuthTokenListener): () => void {
  authTokenListeners.add(listener);
  return () => authTokenListeners.delete(listener);
}

function emitAuthTokenChange(): void {
  const token = readAuthToken();
  for (const listener of authTokenListeners) listener(token);
}

// localStorage is shared by every tab, but a `storage` event is delivered only
// to the OTHER documents. Re-emit it into this module's lifecycle so a login,
// logout or impersonation in tab A immediately invalidates tab B's user-scoped
// caches. sessionStorage is tab-local and deliberately has no cross-tab event.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === AUTH_TOKEN_KEY) emitAuthTokenChange();
  });
}

/** Store a token in exactly one backing store, then notify session-scoped caches. */
export function writeAuthToken(token: string, persistent = true): void {
  try {
    if (persistent) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
    } else {
      sessionStorage.setItem(AUTH_TOKEN_KEY, token);
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {}
  emitAuthTokenChange();
}

/** Clear both backing stores, then notify session-scoped caches. */
export function clearAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {}
  emitAuthTokenChange();
}
