// SKU Costing store — API-backed with localStorage cache fallback.
// GET  /api/skus    → list
// POST /api/skus    → upsert (used by addSKU + updateSKU merge)
// PATCH /api/skus   → partial update
// DELETE /api/skus/:id

import { useSyncExternalStore, useEffect } from "react";
import skuMaster from "@/data/sku-master.json";

// ─── Types ────────────────────────────────────────────────────────────────────

export const SKU_ITEM_GROUPS = [
  "MATTRESS", "BEDFRAME", "SOFA", "ACC", "BEDLINES", "DINING",
  "CARPET", "DIFFUSER", "TRANS", "OTHER",
] as const;
export type SKUItemGroup = typeof SKU_ITEM_GROUPS[number];

export type SKUBrand =
  | "AKEMI" | "ZANOTTI" | "ERGOTEX" | "DUNLOPILLO" | "HOUZS"
  | "MYLATEX" | "GETHA" | "AERO" | "THL3" | "JM" | "TNS" | "NAKI"
  | "CARRESS" | "NICOLLO" | "ARMANI" | "DORSETTLOFT" | "ANNEX"
  | "MAJESTIC" | "TODERN" | "LAVEO" | "BEST" | "RED_SOFA" | "C_AND_C"
  | "OTHER";

export interface SKUCosting {
  id: string;
  itemCode: string;
  description: string;
  itemGroup: SKUItemGroup;
  uom: string;
  supplier: string;
  barCode: string;
  costPrice: number;
  sellingPrice: number;
  brand: SKUBrand;
  lastUpdated: string;
  notes?: string;
}

export function marginAmount(s: Pick<SKUCosting, "sellingPrice" | "costPrice">): number {
  return s.sellingPrice - s.costPrice;
}
export function marginPct(s: Pick<SKUCosting, "sellingPrice" | "costPrice">): number {
  if (s.sellingPrice <= 0) return 0;
  return (marginAmount(s) / s.sellingPrice) * 100;
}

// ─── Seed (used for initial offline snapshot only) ───────────────────────────

interface RawSKU {
  id: string; itemCode: string; uom: string; supplier: string; itemGroup: string;
  description: string; barCode: string; costPrice: number; brand: string;
}
const seedSKUs: SKUCosting[] = (skuMaster as RawSKU[]).map((r) => ({
  id: r.id,
  itemCode: r.itemCode,
  description: r.description,
  itemGroup: (SKU_ITEM_GROUPS as readonly string[]).includes(r.itemGroup)
    ? (r.itemGroup as SKUItemGroup) : "OTHER",
  uom: r.uom || "UNIT",
  supplier: r.supplier,
  barCode: r.barCode,
  costPrice: r.costPrice,
  sellingPrice: 0,
  brand: r.brand as SKUBrand,
  lastUpdated: "2026-04-22T00:00:00",
  notes: "",
}));

// ─── Cache (localStorage) + in-memory store ──────────────────────────────────

const CACHE_KEY = "houzs-sku-costings-cache-v1";
let listeners: (() => void)[] = [];
let cached: SKUCosting[] | null = null;
let fetching = false;

function readCache(): SKUCosting[] {
  if (typeof window === "undefined") return seedSKUs;
  const raw = localStorage.getItem(CACHE_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return seedSKUs; // first load before API responds
}

function writeCache(data: SKUCosting[]) {
  cached = data;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* quota */ }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function snapshot(): SKUCosting[] {
  if (!cached) cached = readCache();
  return cached;
}

async function fetchAllFromApi(): Promise<void> {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch("/api/skus");
    if (!res.ok) throw new Error(`${res.status}`);
    const data = (await res.json()) as SKUCosting[];
    writeCache(data);
  } catch (e) {
    // API not reachable (local dev without functions) — keep cached
    console.warn("[sku-store] API fetch failed, using cache:", e);
  } finally {
    fetching = false;
  }
}

// Kick off fetch on first hook mount
let bootstrapped = false;
function bootstrap() {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;
  fetchAllFromApi();
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useSKUCostings(): SKUCosting[] {
  useEffect(() => { bootstrap(); }, []);
  return useSyncExternalStore(subscribe, snapshot, () => seedSKUs);
}

// Sync accessor for cost lookup (no re-render subscription)
export function getAllSKUsSync(): SKUCosting[] {
  if (!cached) cached = readCache();
  return cached;
}

export function getCostByItemCode(itemCode: string): number {
  const skus = getAllSKUsSync();
  return skus.find((s) => s.itemCode === itemCode)?.costPrice ?? 0;
}

// ─── Mutations — write to API + update cache ────────────────────────────────

export async function addSKU(sku: Omit<SKUCosting, "id">): Promise<string> {
  const res = await fetch("/api/skus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sku),
  });
  const saved = (await res.json()) as SKUCosting;
  const next = [...snapshot().filter((s) => s.itemCode !== saved.itemCode), saved];
  writeCache(next);
  return saved.id;
}

export async function updateSKU(id: string, patch: Partial<SKUCosting>): Promise<void> {
  // Optimistic update
  const existing = snapshot().find((s) => s.id === id);
  if (existing) {
    const merged = { ...existing, ...patch };
    writeCache(snapshot().map((s) => s.id === id ? merged : s));
  }
  try {
    await fetch("/api/skus", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
  } catch (e) {
    console.warn("[sku-store] updateSKU failed, kept optimistic update:", e);
  }
}

export async function removeSKU(id: string): Promise<void> {
  writeCache(snapshot().filter((s) => s.id !== id)); // optimistic
  try {
    await fetch(`/api/skus/${id}`, { method: "DELETE" });
  } catch (e) {
    console.warn("[sku-store] removeSKU failed:", e);
  }
}

export async function resetSKUCostings(): Promise<void> {
  cached = null;
  localStorage.removeItem(CACHE_KEY);
  listeners.forEach((fn) => fn());
  await fetchAllFromApi();
}
