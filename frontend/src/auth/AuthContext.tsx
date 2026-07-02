import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, tokenStore, onUnauthorized } from "../api/client";
import type { AccessLevel, AuthUser } from "../types";

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  hasUsers: boolean | null;
}

/** Login either completes, or stops at a 2FA challenge that needs a code. */
export type LoginResult = { kind: "ok" } | { kind: "totp"; challenge: string };

interface AuthContextValue extends AuthState {
  login: (email: string, password: string, remember?: boolean) => Promise<LoginResult>;
  /** Second step of a 2FA login — exchange the challenge + code for a session. */
  verifyTotpLogin: (challenge: string, code: string, remember?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: (email: string, name: string, password: string) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  /** True if the current user has the given permission. O(1) via Set. */
  can: (perm: string) => boolean;
  /** True if the user has at least one of `perms`. Short-circuits. */
  canAny: (perms: readonly string[]) => boolean;
  /** True if the user has every perm in `perms`. */
  canAll: (perms: readonly string[]) => boolean;
  /**
   * Read the user's access level for a given page (mig 073). The `*`
   * wildcard short-circuits to "full"; otherwise reads from
   * `user.page_access[page]`. Missing key → "none".
   */
  pageAccess: (page: string) => AccessLevel;
  /** Reload /me — useful after role/permission changes. */
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    hasUsers: null,
  });

  const fetchMe = useCallback(async () => {
    // Validate the stored token. CRUCIAL: only a genuine 401 means the session is
    // gone — clear it and show login. A transient failure (cold-pool 503, a brief
    // network drop, a timeout) must NOT wipe a still-valid 7-day session, or the
    // user is logged out every time the app cold-starts. Retry a few times, and if
    // it still fails, keep the token so a later reload re-validates in place.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await api.get<{ user: AuthUser }>("/api/auth/me");
        setState((prev) => ({ ...prev, user: res.user, loading: false }));
        return;
      } catch (e) {
        if ((e as { status?: number })?.status === 401) {
          tokenStore.clear();
          setState((prev) => ({ ...prev, user: null, loading: false }));
          return;
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        // Transient + exhausted: keep the token (do NOT log the user out); just
        // drop the loading gate. A reload once the server is reachable restores them.
        setState((prev) => ({ ...prev, loading: false }));
        return;
      }
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get<{ has_users: boolean }>("/api/auth/status");
      setState((prev) => ({ ...prev, hasUsers: res.has_users }));
    } catch {
      setState((prev) => ({ ...prev, hasUsers: null }));
    }
  }, []);

  // Boot: check if there are users at all, and try to validate any
  // existing token.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchStatus();
      if (cancelled) return;
      const token = tokenStore.get();
      if (!token) {
        setState((prev) => ({ ...prev, loading: false }));
        return;
      }
      await fetchMe();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMe, fetchStatus]);

  // Listen for global 401s — clear token + bounce.
  useEffect(() => {
    return onUnauthorized(() => {
      tokenStore.clear();
      setState((prev) => ({ ...prev, user: null }));
    });
  }, []);

  const login = useCallback(
    async (email: string, password: string, remember = true): Promise<LoginResult> => {
      const res = await api.post<{ token?: string; totp_required?: boolean; challenge?: string }>(
        "/api/auth/login",
        { email, password },
      );
      // 2FA accounts get a challenge instead of a token — the caller collects a
      // code and calls verifyTotpLogin. No token is stored yet.
      if (res.totp_required && res.challenge) {
        return { kind: "totp", challenge: res.challenge };
      }
      // remember → persist in localStorage (survives close); else session-only.
      tokenStore.set(res.token!, remember);
      await fetchMe();
      await fetchStatus();
      return { kind: "ok" };
    },
    [fetchMe, fetchStatus]
  );

  const verifyTotpLogin = useCallback(
    async (challenge: string, code: string, remember = true) => {
      const res = await api.post<{ token: string }>("/api/auth/totp/login", {
        challenge,
        code,
      });
      tokenStore.set(res.token, remember);
      await fetchMe();
      await fetchStatus();
    },
    [fetchMe, fetchStatus]
  );

  const bootstrap = useCallback(
    async (email: string, name: string, password: string) => {
      const res = await api.post<{ token: string }>("/api/auth/bootstrap", {
        email,
        name,
        password,
      });
      tokenStore.set(res.token);
      await fetchMe();
      await fetchStatus();
    },
    [fetchMe, fetchStatus]
  );

  const acceptInvite = useCallback(
    async (token: string, name: string, password: string) => {
      const res = await api.post<{ token: string }>("/api/auth/accept-invite", {
        token,
        name,
        password,
      });
      tokenStore.set(res.token);
      await fetchMe();
      await fetchStatus();
    },
    [fetchMe, fetchStatus]
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } catch {}
    tokenStore.clear();
    setState((prev) => ({ ...prev, user: null }));
  }, []);

  // Pre-compute a Set so every can() / canAny() / canAll() call is
  // O(1). Rebuilt only when the actual permissions array reference
  // changes (i.e. login / logout / role-update via reload()).
  const permSet = useMemo(
    () => new Set(state.user?.permissions ?? []),
    [state.user?.permissions],
  );

  const can = useCallback(
    (perm: string) => permSet.has("*") || permSet.has(perm),
    [permSet],
  );

  const canAny = useCallback(
    (perms: readonly string[]) => {
      if (permSet.has("*")) return true;
      for (const p of perms) if (permSet.has(p)) return true;
      return false;
    },
    [permSet],
  );

  const canAll = useCallback(
    (perms: readonly string[]) => {
      if (permSet.has("*")) return true;
      for (const p of perms) if (!permSet.has(p)) return false;
      return true;
    },
    [permSet],
  );

  const pageAccess = useCallback(
    (page: string): AccessLevel => {
      if (permSet.has("*")) return "full";
      return (state.user?.page_access?.[page] ?? "none") as AccessLevel;
    },
    [permSet, state.user?.page_access],
  );

  const reload = useCallback(async () => {
    await fetchMe();
  }, [fetchMe]);

  // Memoize the context value so consumers don't re-render whenever
  // AuthProvider rerenders for unrelated reasons (status poll, etc.).
  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      verifyTotpLogin,
      logout,
      bootstrap,
      acceptInvite,
      can,
      canAny,
      canAll,
      pageAccess,
      reload,
    }),
    [
      state,
      login,
      verifyTotpLogin,
      logout,
      bootstrap,
      acceptInvite,
      can,
      canAny,
      canAll,
      pageAccess,
      reload,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
