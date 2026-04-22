// Events store — D1-backed via /api/events, with localStorage cache for
// instant paint + offline fallback. Pattern mirrors so-store.ts and
// sku-costing-store.ts.
//
//   useAllEvents() → HouzsEvent[]        — reactive hook
//   findEventMerged(a42) → HouzsEvent?
//   addEvent(e)                          — POST /api/events
//   updateEvent(a42, changes)            — PATCH /api/events/:a42
//   deleteUserEvent(a42)                 — DELETE /api/events/:a42
//   resetUserData()                      — clear cache + refetch
//   buildA42(parts) → string             — utility for composing the key

import { useSyncExternalStore } from "react";
import { type HouzsEvent } from "./mock-data";

const CACHE_KEY = "houzs-events-cache-v1";

const listeners = new Set<() => void>();
let cached: HouzsEvent[] | null = null;
let fetching = false;
let bootstrapped = false;

function emit() { listeners.forEach((l) => l()); }

function readCache(): HouzsEvent[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function writeCache(arr: HouzsEvent[]) {
  cached = arr;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(arr)); } catch { /* quota */ }
  emit();
}

async function fetchAllFromApi(): Promise<void> {
  if (fetching) return;
  fetching = true;
  try {
    const r = await fetch("/api/events", { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as HouzsEvent[];
    writeCache(data);
  } catch (e) {
    console.warn("[events-store] API fetch failed, using cache:", e);
  } finally {
    fetching = false;
  }
}

function bootstrap() {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;
  fetchAllFromApi();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === CACHE_KEY) { cached = null; cb(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

function getSnapshot(): HouzsEvent[] {
  if (!cached) cached = readCache();
  return cached;
}

function getServerSnapshot(): HouzsEvent[] { return []; }

function daysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 1;
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}

// ─── Public hooks + accessors ─────────────────────────────────────────────────

export function useAllEvents(): HouzsEvent[] {
  if (typeof window !== "undefined") bootstrap();
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Non-reactive accessor — used by callers that don't want a subscription. */
export function findEventMerged(a42: string): HouzsEvent | undefined {
  if (!cached) cached = readCache();
  return cached.find((e) => e.a42 === a42);
}

// ─── Mutations (optimistic: cache first, then API) ───────────────────────────

export async function addEvent(e: HouzsEvent): Promise<void> {
  if (!cached) cached = readCache();
  if (cached.some((x) => x.a42 === e.a42)) {
    throw new Error(`Event with A42 "${e.a42}" already exists`);
  }
  // Recompute durationDays defensively
  const complete: HouzsEvent = { ...e, durationDays: daysBetween(e.startDate, e.endDate) };
  writeCache([...cached, complete]);
  try {
    await fetch("/api/events", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(complete),
    });
  } catch (err) {
    console.warn("[events-store] addEvent API failed, kept optimistic:", err);
  }
}

export async function updateEvent(a42: string, changes: Partial<HouzsEvent>): Promise<void> {
  if (!cached) cached = readCache();
  const idx = cached.findIndex((e) => e.a42 === a42);
  if (idx < 0) return;
  const merged = { ...cached[idx], ...changes };
  if (changes.startDate || changes.endDate) {
    merged.durationDays = daysBetween(merged.startDate, merged.endDate);
  }
  const next = [...cached];
  next[idx] = merged;
  writeCache(next);
  try {
    await fetch(`/api/events/${encodeURIComponent(a42)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...changes,
        ...(changes.startDate || changes.endDate ? { durationDays: merged.durationDays } : {}),
      }),
    });
  } catch (err) {
    console.warn("[events-store] updateEvent API failed, kept optimistic:", err);
  }
}

export async function deleteUserEvent(a42: string): Promise<void> {
  if (!cached) cached = readCache();
  writeCache(cached.filter((e) => e.a42 !== a42));
  try {
    await fetch(`/api/events/${encodeURIComponent(a42)}`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch (err) {
    console.warn("[events-store] deleteEvent API failed:", err);
  }
}

export async function resetUserData(): Promise<void> {
  cached = null;
  if (typeof window !== "undefined") localStorage.removeItem(CACHE_KEY);
  emit();
  await fetchAllFromApi();
}

// ─── A42 composition helper (unchanged) ───────────────────────────────────────

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
