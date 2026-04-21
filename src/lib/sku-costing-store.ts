// SKU Costing master data store — localStorage-backed with subscriber pattern.
// Mirrors the pattern in sales-store.ts exactly.

import { useSyncExternalStore } from "react";
import type { Brand } from "./mock-data";
import type { SOCategory } from "./so-store";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SKUCosting {
  id: string;
  sku: string;               // unique
  description: string;
  brand: Brand;
  category: SOCategory;
  supplier?: string;
  costPrice: number;         // total cost per unit
  sellingPrice: number;      // SRP per unit
  lastUpdated: string;       // ISO datetime
  notes?: string;
}

// Derived: marginAmount = sellingPrice - costPrice
//          marginPct    = marginAmount / sellingPrice * 100

export function marginAmount(s: SKUCosting): number {
  return s.sellingPrice - s.costPrice;
}

export function marginPct(s: SKUCosting): number {
  if (s.sellingPrice === 0) return 0;
  return (marginAmount(s) / s.sellingPrice) * 100;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Seed data ────────────────────────────────────────────────────────────────

const seedSKUs: SKUCosting[] = [
  // ── AKEMI ─────────────────────────────────────────────────────────────────
  {
    id: "sku-001", sku: "AK-Q-PURELATEX", description: "Akemi Pure Latex Queen Mattress",
    brand: "AKEMI", category: "Mattress", supplier: "Latex Systems Sdn Bhd",
    costPrice: 2100, sellingPrice: 4600, lastUpdated: "2025-01-15T09:00:00", notes: "",
  },
  {
    id: "sku-002", sku: "AK-K-PURELATEX", description: "Akemi Pure Latex King Mattress",
    brand: "AKEMI", category: "Mattress", supplier: "Latex Systems Sdn Bhd",
    costPrice: 2600, sellingPrice: 5600, lastUpdated: "2025-01-15T09:00:00", notes: "",
  },
  {
    id: "sku-003", sku: "AK-S-ORTHO", description: "Akemi Ortho Single Mattress",
    brand: "AKEMI", category: "Mattress", supplier: "Foam Tech Industries",
    costPrice: 780, sellingPrice: 1800, lastUpdated: "2025-01-20T10:00:00", notes: "",
  },
  {
    id: "sku-004", sku: "AK-Q-BF-NORDIC", description: "Akemi Nordic Queen Bedframe",
    brand: "AKEMI", category: "Bedframe", supplier: "Furniture Link Sdn Bhd",
    costPrice: 1350, sellingPrice: 2800, lastUpdated: "2025-02-01T08:00:00", notes: "",
  },
  {
    id: "sku-005", sku: "AK-K-BF-NORDIC", description: "Akemi Nordic King Bedframe",
    brand: "AKEMI", category: "Bedframe", supplier: "Furniture Link Sdn Bhd",
    costPrice: 1650, sellingPrice: 3400, lastUpdated: "2025-02-01T08:00:00", notes: "",
  },
  {
    id: "sku-006", sku: "AK-PILLOW-HYDRO", description: "Akemi Hydro Cool Pillow",
    brand: "AKEMI", category: "Pillow", supplier: "Comfort Fibre Co",
    costPrice: 110, sellingPrice: 280, lastUpdated: "2025-02-10T11:00:00", notes: "",
  },
  {
    id: "sku-007", sku: "AK-ACC-PROTECT", description: "Akemi Waterproof Mattress Protector Single",
    brand: "AKEMI", category: "Accessories", supplier: "Comfort Fibre Co",
    costPrice: 68, sellingPrice: 160, lastUpdated: "2025-02-10T11:00:00", notes: "",
  },

  // ── ZANOTTI ───────────────────────────────────────────────────────────────
  {
    id: "sku-008", sku: "ZNT-K-DELUXE", description: "Zanotti King Deluxe Mattress",
    brand: "ZANOTTI", category: "Mattress", supplier: "Zanotti MY Distribution",
    costPrice: 2800, sellingPrice: 5800, lastUpdated: "2025-01-10T09:30:00", notes: "Premium import SKU",
  },
  {
    id: "sku-009", sku: "ZNT-Q-SIGNATURE", description: "Zanotti Queen Signature Mattress",
    brand: "ZANOTTI", category: "Mattress", supplier: "Zanotti MY Distribution",
    costPrice: 1950, sellingPrice: 4200, lastUpdated: "2025-01-10T09:30:00", notes: "",
  },
  {
    id: "sku-010", sku: "ZNT-K-BF-ELENA", description: "Zanotti Elena King Bedframe",
    brand: "ZANOTTI", category: "Bedframe", supplier: "Zanotti MY Distribution",
    costPrice: 1600, sellingPrice: 3200, lastUpdated: "2025-02-05T14:00:00", notes: "",
  },
  {
    id: "sku-011", sku: "ZNT-PIL-LATEX", description: "Zanotti Latex Pillow Pair",
    brand: "ZANOTTI", category: "Pillow", supplier: "Zanotti MY Distribution",
    costPrice: 160, sellingPrice: 380, lastUpdated: "2025-02-05T14:00:00", notes: "Sold as pair",
  },
  {
    id: "sku-012", sku: "ZNT-TOP-COOL", description: "Zanotti CoolGel Topper Queen",
    brand: "ZANOTTI", category: "Topper", supplier: "Zanotti MY Distribution",
    costPrice: 420, sellingPrice: 890, lastUpdated: "2025-02-05T14:00:00", notes: "",
  },

  // ── DUNLOPILLO ────────────────────────────────────────────────────────────
  {
    id: "sku-013", sku: "DUN-K-CLASSIC", description: "Dunlopillo Classic King Mattress",
    brand: "DUNLOPILLO", category: "Mattress", supplier: "Dunlopillo Malaysia",
    costPrice: 1850, sellingPrice: 3900, lastUpdated: "2025-01-12T10:00:00", notes: "",
  },
  {
    id: "sku-014", sku: "DUN-Q-HERITAGE", description: "Dunlopillo Heritage Queen Mattress",
    brand: "DUNLOPILLO", category: "Mattress", supplier: "Dunlopillo Malaysia",
    costPrice: 1500, sellingPrice: 3200, lastUpdated: "2025-01-12T10:00:00", notes: "",
  },
  {
    id: "sku-015", sku: "DUN-TOP-LATEX", description: "Dunlopillo Natural Latex Topper King",
    brand: "DUNLOPILLO", category: "Topper", supplier: "Dunlopillo Malaysia",
    costPrice: 580, sellingPrice: 1200, lastUpdated: "2025-03-01T09:00:00", notes: "",
  },
  {
    id: "sku-016", sku: "DUN-S-CLASSIC", description: "Dunlopillo Classic Single Mattress",
    brand: "DUNLOPILLO", category: "Mattress", supplier: "Dunlopillo Malaysia",
    costPrice: 720, sellingPrice: 1600, lastUpdated: "2025-01-12T10:00:00", notes: "",
  },

  // ── ERGOTEX ───────────────────────────────────────────────────────────────
  {
    id: "sku-017", sku: "ERG-Q-ERGO1000", description: "Ergotex Ergo 1000 Queen Mattress",
    brand: "ERGOTEX", category: "Mattress", supplier: "Ergotex Sdn Bhd",
    costPrice: 2200, sellingPrice: 4800, lastUpdated: "2025-01-18T11:30:00", notes: "",
  },
  {
    id: "sku-018", sku: "ERG-K-ERGO2000", description: "Ergotex Ergo 2000 King Mattress",
    brand: "ERGOTEX", category: "Mattress", supplier: "Ergotex Sdn Bhd",
    costPrice: 2900, sellingPrice: 6200, lastUpdated: "2025-01-18T11:30:00", notes: "High-end pocket spring",
  },
  {
    id: "sku-019", sku: "ERG-Q-BF-POSTURE", description: "Ergotex Posture Queen Bedframe",
    brand: "ERGOTEX", category: "Bedframe", supplier: "Ergotex Sdn Bhd",
    costPrice: 1900, sellingPrice: 3800, lastUpdated: "2025-03-10T10:00:00", notes: "",
  },
  {
    id: "sku-020", sku: "ERG-PIL-MEMORY", description: "Ergotex Memory Foam Pillow",
    brand: "ERGOTEX", category: "Pillow", supplier: "Ergotex Sdn Bhd",
    costPrice: 130, sellingPrice: 320, lastUpdated: "2025-03-10T10:00:00", notes: "",
  },
];

// ─── localStorage persistence ──────────────────────────────────────────────────

const K = "houzs-sku-costings-v1";
let listeners: (() => void)[] = [];
let cached: SKUCosting[] | null = null;

function read(): SKUCosting[] {
  if (typeof window === "undefined") return seedSKUs;
  const raw = localStorage.getItem(K);
  if (!raw) { localStorage.setItem(K, JSON.stringify(seedSKUs)); return seedSKUs; }
  try { return JSON.parse(raw); } catch { return seedSKUs; }
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
