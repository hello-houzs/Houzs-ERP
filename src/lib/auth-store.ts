// Auth store — tracks the currently logged-in user (by id) in localStorage.
// Pattern mirrors events-store: useSyncExternalStore + listeners Set + cached value.

import { useSyncExternalStore } from "react";
import { type SalesMember } from "./sales-store";

const KEY = "houzs-current-user-id";
const DEFAULT_ID = "dir-kingsley"; // out-of-box default

// ─── Internal subscriber registry ────────────────────────────────────────────

const listeners = new Set<() => void>();
let cached: string | null | undefined = undefined; // undefined = not yet read

function emit() {
  cached = undefined;
  listeners.forEach((l) => l());
}

function readRaw(): string | null {
  if (typeof window === "undefined") return DEFAULT_ID;
  const v = localStorage.getItem(KEY);
  // First-time seed: write the default so the app works out of the box
  if (v === null) {
    localStorage.setItem(KEY, DEFAULT_ID);
    return DEFAULT_ID;
  }
  return v;
}

function getSnapshot(): string | null {
  if (cached === undefined) cached = readRaw();
  return cached;
}

function getServerSnapshot(): string | null {
  return DEFAULT_ID;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // Also react to changes from other tabs
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) { cached = undefined; cb(); }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Reactive hook: returns the current user id (or null if signed out). */
export function useCurrentUserId(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Write a new current user id (or null to sign out). */
export function setCurrentUserId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id === null) {
    localStorage.removeItem(KEY);
  } else {
    localStorage.setItem(KEY, id);
  }
  emit();
}

/** Sign out the current user. */
export function logout(): void {
  setCurrentUserId(null);
}

// ─── Permission helpers (pure functions, no hooks) ────────────────────────────

export function isAdmin(user: SalesMember | null | undefined): boolean {
  return user?.position === "Sales Director";
}

/**
 * Full access — Sales Director, PIC, or assigned sales member.
 * Can see everything on the event including financials, workflow, setup info.
 */
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

/**
 * Returns true if the event is currently live (started but not yet ended).
 * Uses ISO yyyy-mm-dd dates.
 */
export function isEventLive(event: { startDate: string; endDate: string }): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return event.startDate <= today && today <= event.endDate;
}

/**
 * Limited access — ANY active sales member can view the event ONLY while the
 * event is currently live. They see a restricted UI: chat + floorplan only.
 * Use canViewFullEvent() to decide whether to show full details.
 */
export function canViewEvent(
  user: SalesMember | null | undefined,
  event: { assignedSales?: string[]; pic?: string; startDate: string; endDate: string },
): boolean {
  if (canViewFullEvent(user, event)) return true;
  // Any active sales member gets limited access (chat + floorplan) during live events
  if (user && user.status === "ACTIVE" && isEventLive(event)) return true;
  return false;
}

export function canViewFinance(user: SalesMember | null | undefined): boolean {
  return isAdmin(user);
}

// ─── Composite hook ───────────────────────────────────────────────────────────

/**
 * Returns the full SalesMember object for the current user, or null.
 * Reads directly from localStorage (not via useSalesMembers hook) to avoid
 * double-subscription and infinite re-render risk.
 */
export function useCurrentUser(): SalesMember | null {
  const id = useCurrentUserId();
  // We intentionally read the sales members store snapshot directly (not
  // via useSalesMembers) so we don't add a second subscription here.
  // This is safe because any sales-member change that affects the current user
  // would also trigger a page refresh via the sales-store listeners anyway.
  if (!id || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("houzs_sales_members");
    if (!raw) return null;
    const members: SalesMember[] = JSON.parse(raw);
    return members.find((m) => m.id === id) ?? null;
  } catch {
    return null;
  }
}
