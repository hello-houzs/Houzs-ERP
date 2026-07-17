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
