// Client-side events store: mockEvents + user-added + per-event overrides,
// persisted in localStorage and reactive via a subscriber registry.
//
//   useAllEvents() → HouzsEvent[]        — reactive read
//   addEvent(e)                          — append a new event
//   updateEvent(a42, changes)            — patch an existing event
//   deleteUserEvent(a42)                 — remove a user-added event
//   resetUserData()                      — clear both stores
//
// Overrides let us edit fields on seeded mock events too (e.g. drag dates
// in the PM Dashboard), without mutating the module-level mockEvents array.

import { useSyncExternalStore } from "react";
import { mockEvents, type HouzsEvent } from "./mock-data";

const USER_KEY = "houzs-user-events-v1";
const OVERRIDE_KEY = "houzs-event-overrides-v1";

type Overrides = Record<string, Partial<HouzsEvent>>;

const listeners = new Set<() => void>();
let cached: HouzsEvent[] | null = null;
function emit() { cached = null; listeners.forEach((l) => l()); }

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function readUserEvents(): HouzsEvent[] {
  if (typeof window === "undefined") return [];
  return safeParse<HouzsEvent[]>(localStorage.getItem(USER_KEY), []);
}
function writeUserEvents(arr: HouzsEvent[]) {
  localStorage.setItem(USER_KEY, JSON.stringify(arr));
  emit();
}
function readOverrides(): Overrides {
  if (typeof window === "undefined") return {};
  return safeParse<Overrides>(localStorage.getItem(OVERRIDE_KEY), {});
}
function writeOverrides(o: Overrides) {
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(o));
  emit();
}

function daysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 1;
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}

function merge(): HouzsEvent[] {
  const userEvents = readUserEvents();
  const overrides = readOverrides();
  const all = [...mockEvents, ...userEvents];
  return all.map((e) => {
    const o = overrides[e.a42];
    if (!o) return e;
    const merged: HouzsEvent = { ...e, ...o };
    // auto-recompute durationDays if dates changed
    if (o.startDate || o.endDate) {
      merged.durationDays = daysBetween(merged.startDate, merged.endDate);
    }
    return merged;
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = () => { cached = null; cb(); };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): HouzsEvent[] {
  if (!cached) cached = merge();
  return cached;
}

function getServerSnapshot(): HouzsEvent[] {
  return mockEvents;
}

/** Reactive hook — subscribes to store mutations + storage events from other tabs. */
export function useAllEvents(): HouzsEvent[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Find one event by a42 including user-added and overrides. */
export function findEventMerged(a42: string): HouzsEvent | undefined {
  return merge().find((e) => e.a42 === a42);
}

/** Append a new user-authored event. */
export function addEvent(e: HouzsEvent) {
  const arr = readUserEvents();
  // prevent dupes by a42
  if (arr.some((x) => x.a42 === e.a42) || mockEvents.some((x) => x.a42 === e.a42)) {
    throw new Error(`Event with A42 "${e.a42}" already exists`);
  }
  arr.push(e);
  writeUserEvents(arr);
}

/** Patch fields on any event (mock or user-added). Auto-recomputes durationDays when dates change. */
export function updateEvent(a42: string, changes: Partial<HouzsEvent>) {
  // If it's a user event, update in place; otherwise store as override.
  const userArr = readUserEvents();
  const uidx = userArr.findIndex((e) => e.a42 === a42);
  if (uidx >= 0) {
    const next = { ...userArr[uidx], ...changes };
    if (changes.startDate || changes.endDate) {
      next.durationDays = daysBetween(next.startDate, next.endDate);
    }
    userArr[uidx] = next;
    writeUserEvents(userArr);
    return;
  }
  const o = readOverrides();
  o[a42] = { ...(o[a42] ?? {}), ...changes };
  writeOverrides(o);
}

/** Remove a user-added event. Mock events cannot be deleted, only overridden. */
export function deleteUserEvent(a42: string) {
  const arr = readUserEvents().filter((e) => e.a42 !== a42);
  writeUserEvents(arr);
}

/** Nuke all user data (both stores). */
export function resetUserData() {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(OVERRIDE_KEY);
  emit();
}

/** Build a canonical A42 key from the parts. */
export function buildA42(parts: {
  year: number; month: string; organizer: string; state: string; venue: string; brand: string;
}): string {
  const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const monthNum = (() => {
    const months = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
    const idx = months.indexOf(parts.month.toUpperCase());
    return idx >= 0 ? String(idx + 1).padStart(2, "0") : "00";
  })();
  return `${parts.year}-${monthNum}-${parts.organizer.toUpperCase()}-${parts.state.toUpperCase()}-${compact(parts.venue)}-${parts.brand.toUpperCase()}`;
}
