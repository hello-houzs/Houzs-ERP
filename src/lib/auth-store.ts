// Auth store — API-backed via /api/auth/me.
// Keeps the same external surface (useCurrentUser, isAdmin, canViewFinance, ...)
// so existing pages don't need to change, but now the source of truth is the
// server cookie session, not localStorage.

import { useSyncExternalStore, useCallback } from "react";
import { type SalesMember } from "./sales-store";
import { BRANDS, type Brand } from "./mock-data";
import { authApi, type CurrentUser } from "./auth-api";

// ─── Internal store ──────────────────────────────────────────────────────────

type AuthState = {
  status: "loading" | "authenticated" | "guest";
  user: CurrentUser | null;
};

let state: AuthState = { status: "loading", user: null };
const listeners = new Set<() => void>();
let bootstrapped = false;

function emit() { listeners.forEach((l) => l()); }

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): AuthState { return state; }
function getServerSnapshot(): AuthState { return { status: "loading", user: null }; }

async function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  const r = await authApi.me();
  if (r.ok) state = { status: "authenticated", user: r.data };
  else state = { status: "guest", user: null };
  emit();
}

export async function refreshCurrentUser(): Promise<void> {
  const r = await authApi.me();
  if (r.ok) state = { status: "authenticated", user: r.data };
  else state = { status: "guest", user: null };
  emit();
}

// ─── Public hooks ─────────────────────────────────────────────────────────────

export function useAuthState(): AuthState {
  if (typeof window !== "undefined") bootstrap();
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Returns the current authenticated user as a SalesMember-compatible shape,
 *  or null while loading / signed out. Callers that just need permission
 *  helpers can use this directly. */
export function useCurrentUser(): SalesMember | null {
  const { user } = useAuthState();
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    code: user.code,
    phone: user.phone,
    email: user.email,
    ic: "",
    position: user.position,
    parentId: user.parentId,
    additionalParentIds: user.additionalParentIds,
    joinDate: user.joinDate,
    status: user.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    assignedBrands: user.assignedBrands as Brand[],
    commissionTiers: user.commissionTiers,
    minRate: user.minRate,
  };
}

/** Just the string id, for code paths that previously took `useCurrentUserId()`. */
export function useCurrentUserId(): string | null {
  return useCurrentUser()?.id ?? null;
}

// ─── Imperative actions ──────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<{ ok: true; mustChangePassword: boolean } | { ok: false; error: string }> {
  const r = await authApi.login(email, password);
  if (!r.ok) return { ok: false, error: r.error };
  // Re-hydrate to pick up full user shape with isAdmin flag
  await refreshCurrentUser();
  return { ok: true, mustChangePassword: r.data.user.mustChangePassword };
}

export async function logout(): Promise<void> {
  await authApi.logout();
  state = { status: "guest", user: null };
  emit();
}

export async function impersonate(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await authApi.impersonate(userId);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshCurrentUser();
  return { ok: true };
}

export async function stopImpersonate(): Promise<void> {
  await authApi.stopImpersonate();
  await refreshCurrentUser();
}

// Expose hook for pages that need the full action set in one place.
export function useAuth() {
  const { status, user } = useAuthState();
  return {
    status,
    user,
    isAdmin: user?.isAdmin ?? false,
    isImpersonating: !!user?.impersonatedBy,
    impersonatedBy: user?.impersonatedBy ?? null,
    login: useCallback(login, []),
    logout: useCallback(logout, []),
    impersonate: useCallback(impersonate, []),
    stopImpersonate: useCallback(stopImpersonate, []),
    refresh: useCallback(refreshCurrentUser, []),
  };
}

// ─── Permission helpers (unchanged, pure functions) ──────────────────────────
// These work with SalesMember shape from useCurrentUser(), so callers are
// drop-in compatible.

// Admin = any of:
//   • Sales Director (legacy — existing sales bosses)
//   • Super Admin (HQ department)
// Until Phase 2 role-permission matrix lands this is the canonical check.
export function isAdmin(user: SalesMember | null | undefined): boolean {
  if (!user) return false;
  return user.position === "Sales Director" || user.position === "Super Admin";
}

function readAllMembers(): SalesMember[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem("houzs_sales_members");
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function getDownlineIds(userId: string, members: SalesMember[]): Set<string> {
  const childrenMap = new Map<string, SalesMember[]>();
  for (const m of members) {
    const parents = new Set<string>();
    if (m.parentId) parents.add(m.parentId);
    for (const pid of m.additionalParentIds ?? []) parents.add(pid);
    for (const p of parents) {
      if (!childrenMap.has(p)) childrenMap.set(p, []);
      childrenMap.get(p)!.push(m);
    }
  }
  const result = new Set<string>([userId]);
  const stack: string[] = [userId];
  while (stack.length) {
    const id = stack.pop()!;
    const kids = childrenMap.get(id) ?? [];
    for (const k of kids) if (!result.has(k.id)) { result.add(k.id); stack.push(k.id); }
  }
  return result;
}

export function getDownlineNames(userId: string, members: SalesMember[]): Set<string> {
  const ids = getDownlineIds(userId, members);
  const names = new Set<string>();
  for (const m of members) if (ids.has(m.id)) names.add(m.name.toUpperCase());
  return names;
}

export function canViewFullEvent(
  user: SalesMember | null | undefined,
  event: { assignedSales?: string[]; pic?: string },
): boolean {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (event.assignedSales?.includes(user.id)) return true;
  if (event.pic && user.name.toUpperCase() === event.pic.toUpperCase()) return true;
  return false;
}

export function isEventLive(event: { startDate: string; endDate: string }): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return event.startDate <= today && today <= event.endDate;
}

export function canViewEvent(
  user: SalesMember | null | undefined,
  event: { assignedSales?: string[]; pic?: string; startDate: string; endDate: string },
): boolean {
  if (canViewFullEvent(user, event)) return true;
  if (user && user.status === "ACTIVE" && isEventLive(event)) return true;
  return false;
}

export function canViewFinance(user: SalesMember | null | undefined): boolean {
  return isAdmin(user);
}

export function getAccessibleBrands(user: SalesMember | null | undefined): Brand[] {
  if (!user) return [];
  if (isAdmin(user)) return [...BRANDS];
  return user.assignedBrands ?? [];
}

export function canAccessBrand(user: SalesMember | null | undefined, brand: Brand): boolean {
  if (isAdmin(user)) return true;
  return (user?.assignedBrands ?? []).includes(brand);
}

// ─── Legacy (no-op setters kept so old imports don't break) ──────────────────

/** @deprecated — current user is now server-session-driven; this is a no-op. */
export function setCurrentUserId(_id: string | null): void {
  console.warn("[auth-store] setCurrentUserId is deprecated; use login/logout/impersonate");
}

// Re-export readAllMembers in case anything still uses it (hookka-era)
export { readAllMembers };
