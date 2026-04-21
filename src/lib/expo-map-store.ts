// Expo map / competitor tracking store.
// During an exhibition, staff record competitor booths spotted at the venue.
//
// Pattern: localStorage + useSyncExternalStore (mirrors events-store.ts)
// Photos stored via photos-store with workflowKey = `expo:${id}`

import { useSyncExternalStore } from "react";

const KEY = "houzs-competitors-v1";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompetitorEntry {
  id: string;
  eventA42: string;
  boothNo: string;         // competitor's booth number at the fair
  brand: string;           // competitor brand e.g. "King Koil"
  company?: string;        // company name
  notes?: string;
  recordedById: string;
  recordedByName: string;
  recordedAt: string;      // ISO timestamp
  // files via photos-store with workflowKey = `expo:${id}`
}

// ─── Internal store machinery ─────────────────────────────────────────────────

const listeners = new Set<() => void>();
let cached: CompetitorEntry[] | null = null;

function emit() {
  cached = null;
  listeners.forEach((l) => l());
}

function safeParse(raw: string | null): CompetitorEntry[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as CompetitorEntry[]; } catch { return []; }
}

function readAll(): CompetitorEntry[] {
  if (typeof window === "undefined") return [];
  return safeParse(localStorage.getItem(KEY));
}

function writeAll(entries: CompetitorEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(entries));
  emit();
}

function getSnapshot(): CompetitorEntry[] {
  if (!cached) cached = readAll();
  return cached;
}

function getServerSnapshot(): CompetitorEntry[] {
  return [];
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) { cached = null; cb(); }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Reactive hook — returns competitors for a specific event. */
export function useCompetitors(eventA42: string): CompetitorEntry[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return all.filter((e) => e.eventA42 === eventA42);
}

export function addCompetitor(
  eventA42: string,
  entry: Omit<CompetitorEntry, "id" | "eventA42" | "recordedAt">,
): CompetitorEntry {
  const record: CompetitorEntry = {
    ...entry,
    id: crypto.randomUUID(),
    eventA42,
    recordedAt: new Date().toISOString(),
  };
  const all = readAll();
  all.push(record);
  writeAll(all);
  return record;
}

export function updateCompetitor(id: string, patch: Partial<CompetitorEntry>): void {
  const all = readAll();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  writeAll(all);
}

export function removeCompetitor(id: string): void {
  const all = readAll().filter((e) => e.id !== id);
  writeAll(all);
}
