// SKU Costing master data store — real data from Supplier Price List costing sheet.
// localStorage-backed with subscriber pattern.

import { useSyncExternalStore } from "react";
import skuMaster from "@/data/sku-master.json";

// ─── Types ────────────────────────────────────────────────────────────────────

// Item groups as they appear in real Excel data
export const SKU_ITEM_GROUPS = [
  "MATTRESS", "BEDFRAME", "SOFA", "ACC", "BEDLINES", "DINING",
  "CARPET", "DIFFUSER", "TRANS", "OTHER",
] as const;
export type SKUItemGroup = typeof SKU_ITEM_GROUPS[number];

// Brand inferred from item-code prefix; best-effort only.
export type SKUBrand =
  | "AKEMI" | "ZANOTTI" | "ERGOTEX" | "DUNLOPILLO" | "HOUZS"
  | "MYLATEX" | "GETHA" | "AERO" | "THL3" | "JM" | "TNS" | "NAKI"
  | "CARRESS" | "NICOLLO" | "ARMANI" | "DORSETTLOFT" | "ANNEX"
  | "MAJESTIC" | "TODERN" | "LAVEO" | "BEST" | "RED_SOFA" | "C_AND_C"
  | "OTHER";

export interface SKUCosting {
  id: string;
  itemCode: string;         // unique — was "sku"
  description: string;
  itemGroup: SKUItemGroup;
  uom: string;              // UNIT, SET, PAIR, PCS, etc.
  supplier: string;         // creditor code (e.g. "400-Z001")
  barCode: string;
  costPrice: number;        // FixedPrice from costing sheet
  sellingPrice: number;     // derived from most-recent SO line (0 if never sold)
  brand: SKUBrand;
  lastUpdated: string;      // ISO
  notes?: string;
}

// ─── Derived helpers ─────────────────────────────────────────────────────────

export function marginAmount(s: Pick<SKUCosting, "sellingPrice" | "costPrice">): number {
  return s.sellingPrice - s.costPrice;
}

export function marginPct(s: Pick<SKUCosting, "sellingPrice" | "costPrice">): number {
  if (s.sellingPrice <= 0) return 0;
  return (marginAmount(s) / s.sellingPrice) * 100;
}

// ─── Seed from Excel ──────────────────────────────────────────────────────────

interface RawSKU {
  id: string;
  itemCode: string;
  uom: string;
  supplier: string;
  itemGroup: string;
  description: string;
  barCode: string;
  costPrice: number;
  brand: string;
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
  sellingPrice: 0, // filled lazily from SO lines; see so-store.getLatestSellPrice
  brand: r.brand as SKUBrand,
  lastUpdated: "2026-04-01T00:00:00",
  notes: "",
}));

// ─── localStorage persistence ──────────────────────────────────────────────────

const K = "houzs-sku-costings-v4";
let listeners: (() => void)[] = [];
let cached: SKUCosting[] | null = null;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function read(): SKUCosting[] {
  if (typeof window === "undefined") return seedSKUs;
  const raw = localStorage.getItem(K);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through to migration */ }
  }

  // Migration: if current key empty, try older keys (v3, v2, v1) and merge user-edited
  // costPrice/sellingPrice/notes forward onto the new seed
  const LEGACY_KEYS = ["houzs-sku-costings-v3", "houzs-sku-costings-v2", "houzs-sku-costings-v1", "houzs-sku-costings"];
  for (const lk of LEGACY_KEYS) {
    const old = localStorage.getItem(lk);
    if (!old) continue;
    try {
      const oldArr: SKUCosting[] = JSON.parse(old);
      const byCode = new Map(oldArr.map((s) => [s.itemCode, s]));
      const merged = seedSKUs.map((s) => {
        const prev = byCode.get(s.itemCode);
        if (!prev) return s;
        return {
          ...s,
          costPrice: prev.costPrice > 0 ? prev.costPrice : s.costPrice,
          sellingPrice: prev.sellingPrice > 0 ? prev.sellingPrice : s.sellingPrice,
          notes: prev.notes ?? s.notes,
          lastUpdated: prev.lastUpdated ?? s.lastUpdated,
        };
      });
      localStorage.setItem(K, JSON.stringify(merged));
      return merged;
    } catch { /* try next legacy key */ }
  }

  localStorage.setItem(K, JSON.stringify(seedSKUs));
  return seedSKUs;
}

function write(skus: SKUCosting[]) {
  cached = skus;
  localStorage.setItem(K, JSON.stringify(skus));
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function getSnapshot(): SKUCosting[] {
  if (!cached) cached = read();
  return cached;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSKUCostings(): SKUCosting[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => seedSKUs);
}

// Synchronous accessor for cost lookup (used by so-store when computing margins)
export function getAllSKUsSync(): SKUCosting[] {
  if (!cached) cached = read();
  return cached;
}

export function getCostByItemCode(itemCode: string): number {
  const skus = getAllSKUsSync();
  const hit = skus.find((s) => s.itemCode === itemCode);
  return hit?.costPrice ?? 0;
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function addSKU(sku: Omit<SKUCosting, "id">): string {
  const id = uid();
  const all = read();
  all.push({ ...sku, id });
  write(all);
  return id;
}

export function updateSKU(id: string, patch: Partial<SKUCosting>) {
  const all = read();
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  write(all);
}

export function removeSKU(id: string) {
  const all = read().filter((s) => s.id !== id);
  write(all);
}

export function resetSKUCostings() {
  cached = null;
  localStorage.removeItem(K);
  listeners.forEach((fn) => fn());
}
