// Sales Order line-item store — localStorage-backed with subscriber pattern.
// Mirrors the pattern in sales-store.ts exactly.

import { useSyncExternalStore } from "react";
import type { Brand } from "./mock-data";
import type { SalesMember } from "./sales-store";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SOCategory = "Mattress" | "Bedframe" | "Accessories" | "Pillow" | "Topper";
export const SO_CATEGORIES: SOCategory[] = ["Mattress", "Bedframe", "Accessories", "Pillow", "Topper"];

export interface SODetailLine {
  id: string;
  soNo: string;              // e.g. "ZNT5155"
  date: string;              // ISO yyyy-mm-dd
  customer: string;          // customer name
  salesPersonId: string;     // from sales-store
  sku: string;               // e.g. "AK-Q-PURELATEX"
  description: string;
  brand: Brand;
  category: SOCategory;
  qty: number;
  unitPrice: number;         // per unit
  discount: number;          // RM discount amount (not %)
  notes?: string;
}

// Computed: lineTotal = qty * unitPrice - discount

export interface ConsolidatedSO {
  soNo: string;
  date: string;
  customer: string;
  salesPersonName: string;
  itemCount: number;
  totalQty: number;
  subtotal: number;
  grandTotal: number;
  lines: SODetailLine[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function lineTotal(line: SODetailLine): number {
  return line.qty * line.unitPrice - line.discount;
}

// ─── Seed data ────────────────────────────────────────────────────────────────

const seedLines: SODetailLine[] = [
  // ZNT5155 — Zanotti order, handled by Shawn
  {
    id: "sol-001", soNo: "ZNT5155", date: "2025-03-12", customer: "Tan Wei Liang",
    salesPersonId: "exe-shawn", sku: "ZNT-K-DELUXE", description: "Zanotti King Deluxe Mattress",
    brand: "ZANOTTI", category: "Mattress", qty: 1, unitPrice: 5800, discount: 300, notes: "",
  },
  {
    id: "sol-002", soNo: "ZNT5155", date: "2025-03-12", customer: "Tan Wei Liang",
    salesPersonId: "exe-shawn", sku: "ZNT-K-BF-ELENA", description: "Zanotti Elena King Bedframe",
    brand: "ZANOTTI", category: "Bedframe", qty: 1, unitPrice: 3200, discount: 200, notes: "",
  },
  {
    id: "sol-003", soNo: "ZNT5155", date: "2025-03-12", customer: "Tan Wei Liang",
    salesPersonId: "exe-shawn", sku: "ZNT-PIL-LATEX", description: "Zanotti Latex Pillow Pair",
    brand: "ZANOTTI", category: "Pillow", qty: 2, unitPrice: 380, discount: 0, notes: "",
  },

  // ZNT5156 — another Zanotti order, Stanley
  {
    id: "sol-004", soNo: "ZNT5156", date: "2025-03-15", customer: "Lim Siew Peng",
    salesPersonId: "exe-stanley", sku: "ZNT-Q-SIGNATURE", description: "Zanotti Queen Signature Mattress",
    brand: "ZANOTTI", category: "Mattress", qty: 1, unitPrice: 4200, discount: 200, notes: "Customer requested firm comfort",
  },
  {
    id: "sol-005", soNo: "ZNT5156", date: "2025-03-15", customer: "Lim Siew Peng",
    salesPersonId: "exe-stanley", sku: "ZNT-TOP-COOL", description: "Zanotti CoolGel Topper Q",
    brand: "ZANOTTI", category: "Topper", qty: 1, unitPrice: 890, discount: 50, notes: "",
  },

  // AKM4301 — Akemi order, Anthony
  {
    id: "sol-006", soNo: "AKM4301", date: "2025-03-20", customer: "Chong Hui Ying",
    salesPersonId: "exe-anthony", sku: "AK-Q-PURELATEX", description: "Akemi Pure Latex Queen Mattress",
    brand: "AKEMI", category: "Mattress", qty: 1, unitPrice: 4600, discount: 400, notes: "",
  },
  {
    id: "sol-007", soNo: "AKM4301", date: "2025-03-20", customer: "Chong Hui Ying",
    salesPersonId: "exe-anthony", sku: "AK-Q-BF-NORDIC", description: "Akemi Nordic Queen Bedframe",
    brand: "AKEMI", category: "Bedframe", qty: 1, unitPrice: 2800, discount: 150, notes: "",
  },
  {
    id: "sol-008", soNo: "AKM4301", date: "2025-03-20", customer: "Chong Hui Ying",
    salesPersonId: "exe-anthony", sku: "AK-PILLOW-HYDRO", description: "Akemi Hydro Cool Pillow",
    brand: "AKEMI", category: "Pillow", qty: 2, unitPrice: 280, discount: 0, notes: "",
  },

  // AKM4302 — Akemi order, Peifen
  {
    id: "sol-009", soNo: "AKM4302", date: "2025-04-02", customer: "Ng Boon Seng",
    salesPersonId: "exe-peifen", sku: "AK-S-ORTHO", description: "Akemi Ortho Single Mattress",
    brand: "AKEMI", category: "Mattress", qty: 2, unitPrice: 1800, discount: 100, notes: "Twin room setup",
  },
  {
    id: "sol-010", soNo: "AKM4302", date: "2025-04-02", customer: "Ng Boon Seng",
    salesPersonId: "exe-peifen", sku: "AK-ACC-PROTECT", description: "Akemi Waterproof Mattress Protector S",
    brand: "AKEMI", category: "Accessories", qty: 2, unitPrice: 160, discount: 0, notes: "",
  },

  // DUN2201 — Dunlopillo order, Shawn
  {
    id: "sol-011", soNo: "DUN2201", date: "2025-04-10", customer: "Farah Nadia binti Aziz",
    salesPersonId: "exe-shawn", sku: "DUN-K-CLASSIC", description: "Dunlopillo Classic King Mattress",
    brand: "DUNLOPILLO", category: "Mattress", qty: 1, unitPrice: 3900, discount: 250, notes: "",
  },
  {
    id: "sol-012", soNo: "DUN2201", date: "2025-04-10", customer: "Farah Nadia binti Aziz",
    salesPersonId: "exe-shawn", sku: "DUN-TOP-LATEX", description: "Dunlopillo Natural Latex Topper K",
    brand: "DUNLOPILLO", category: "Topper", qty: 1, unitPrice: 1200, discount: 100, notes: "",
  },
];

// ─── localStorage persistence ──────────────────────────────────────────────────

const K = "houzs-so-lines-v1";
let listeners: (() => void)[] = [];
let cached: SODetailLine[] | null = null;

function read(): SODetailLine[] {
  if (typeof window === "undefined") return seedLines;
  const raw = localStorage.getItem(K);
  if (!raw) { localStorage.setItem(K, JSON.stringify(seedLines)); return seedLines; }
  try { return JSON.parse(raw); } catch { return seedLines; }
}

function write(lines: SODetailLine[]) {
  cached = lines;
  localStorage.setItem(K, JSON.stringify(lines));
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function getSnapshot(): SODetailLine[] {
  if (!cached) cached = read();
  return cached;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSOLines(): SODetailLine[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => seedLines);
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function addSOLine(line: Omit<SODetailLine, "id">): string {
  const id = uid();
  const all = read();
  all.push({ ...line, id });
  write(all);
  return id;
}

export function updateSOLine(id: string, patch: Partial<SODetailLine>) {
  const all = read();
  const idx = all.findIndex((l) => l.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  write(all);
}

export function removeSOLine(id: string) {
  const all = read().filter((l) => l.id !== id);
  write(all);
}

export function resetSOLines() {
  cached = null;
  localStorage.removeItem(K);
  listeners.forEach((fn) => fn());
}

// ─── Consolidation helper ─────────────────────────────────────────────────────

export function getConsolidatedSOs(
  lines: SODetailLine[],
  members: SalesMember[],
): ConsolidatedSO[] {
  const memberMap = new Map(members.map((m) => [m.id, m.name]));
  const grouped = new Map<string, SODetailLine[]>();
  for (const line of lines) {
    const arr = grouped.get(line.soNo) ?? [];
    arr.push(line);
    grouped.set(line.soNo, arr);
  }
  return Array.from(grouped.entries()).map(([soNo, soLines]) => {
    const first = soLines[0];
    const subtotal = soLines.reduce((s, l) => s + lineTotal(l), 0);
    return {
      soNo,
      date: first.date,
      customer: first.customer,
      salesPersonName: memberMap.get(first.salesPersonId) ?? first.salesPersonId,
      itemCount: soLines.length,
      totalQty: soLines.reduce((s, l) => s + l.qty, 0),
      subtotal,
      grandTotal: subtotal,
      lines: soLines,
    };
  });
}
