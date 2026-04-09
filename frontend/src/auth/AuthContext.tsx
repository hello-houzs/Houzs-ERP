import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, tokenStore, onUnauthorized } from "../api/client";
import type { AuthUser } from "../types";

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  hasUsers: boolean | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: (email: string, name: string, password: string) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  /** True if the current user has the given permission. */
  can: (perm: string) => boolean;
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
    try {
      const res = await api.get<{ user: AuthUser }>("/api/auth/me");
      setState((prev) => ({ ...prev, user: res.user, loading: false }));
    } catch {
      tokenStore.clear();
      setState((prev) => ({ ...prev, user: null, loading: false }));
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
    async (email: string, password: string) => {
      const res = await api.post<{ token: string }>("/api/auth/login", {
        email,
        password,
      });
      tokenStore.set(res.token);
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

  const can = useCallback(
    (perm: string) => {
      const u = state.user;
      if (!u) return false;
      if (u.permissions.includes("*")) return true;
      return u.permissions.includes(perm);
    },
    [state.user]
  );

  const reload = useCallback(async () => {
    await fetchMe();
  }, [fetchMe]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        logout,
        bootstrap,
        acceptInvite,
        can,
        reload,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
