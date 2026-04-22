// Sales Order store — real Excel data (341 headers + 1,654 lines).
// localStorage-backed with subscriber pattern.

import { useSyncExternalStore } from "react";
import soLinesRaw from "@/data/so-lines.json";
import soHeadersRaw from "@/data/so-headers.json";
import { getCostByItemCode } from "./sku-costing-store";
import type { SalesMember } from "./sales-store";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ItemGroup = "MATTRESS" | "BEDFRAME" | "SOFA" | "ACC" | "BEDLINES" | "DINING" | "OTHERS";
export type SOUom = "UNIT" | "SET" | "PAIR" | "PCS";
export type PaymentStatus = "Checked" | "Unchecked" | "Pending";

export const ITEM_GROUPS: ItemGroup[] = ["MATTRESS", "BEDFRAME", "SOFA", "ACC", "BEDLINES", "DINING", "OTHERS"];
export const SO_UOMS: SOUom[] = ["UNIT", "SET", "PAIR", "PCS"];
export const PAYMENT_STATUSES: PaymentStatus[] = ["Checked", "Unchecked", "Pending"];

// Legacy compat
export type SOCategory = "Mattress" | "Bedframe" | "Accessories" | "Pillow" | "Topper";
export const SO_CATEGORIES: SOCategory[] = ["Mattress", "Bedframe", "Accessories", "Pillow", "Topper"];

export interface SODetailLine {
  id: string;
  docNo: string;
  date: string;
  debtorCode: string;
  debtorName: string;
  agent: string;
  itemGroup: ItemGroup;
  itemCode: string;
  description: string;
  description2?: string;
  uom: SOUom;
  location: string;
  qty: number;
  unitPrice: number;
  discount: number;
  total: number;
  tax: number;
  totalInc: number;
  balance: number;
  paymentStatus: PaymentStatus;
  venue: string;
  branding: string;
  remark?: string;
  cancelled: boolean;
  // Cost fields (derived from SKU master)
  unitCost: number;
  lineCost: number;
  lineMargin: number;
  // Variant selections (only set for BEDFRAME / SOFA lines)
  // Enables SO Details to compute accurate costing per variant
  variants?: {
    fabric?: string;
    fabricTier?: "PRICE_1" | "PRICE_2" | "";
    // Bedframe
    gap?: string;
    divanHeight?: string;
    divanSurcharge?: number;   // RM amount added to selling + cost
    legHeight?: string;
    legSurcharge?: number;
    // Sofa
    seatSize?: string;
    sofaLeg?: string;
    sofaLegSurcharge?: number;
    // Both
    specialOrders?: { value: string; priceSen: number }[];
  };
}

export interface SOHeader {
  docNo: string;
  transferTo: string;
  date: string;
  branding: string;
  debtorName: string;
  agent: string;
  salesLocation: string;
  ref: string;
  localTotal: number;
  mattressSofa: number;      // revenue
  bedframe: number;          // revenue
  accessories: number;       // revenue
  // Cost breakdown per category (derived from line costs)
  mattressSofaCost?: number;
  bedframeCost?: number;
  accessoriesCost?: number;
  othersCost?: number;
  others: number;
  balance: number;
  remark2: string;
  remark4: string;
  remark3: string;
  processingDate: string;
  salesExemptionExpiry: string;
  note: string;
  poDocNo: string;
  address1: string;
  address2: string;
  address3: string;
  address4: string;
  phone: string;
  venue: string;
  // Enriched
  totalCost: number;
  totalRevenue: number;
  totalMargin: number;
  marginPct: number;
  lineCount: number;
}

// ConsolidatedSO = SOHeader with some UI-friendly aliases
export interface ConsolidatedSO extends SOHeader {
  debtorCode: string;
  reference: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normGroup(g: string): ItemGroup {
  const u = g.toUpperCase();
  if (u === "MATTRESS" || u === "BEDFRAME" || u === "SOFA" || u === "ACC"
      || u === "BEDLINES" || u === "DINING") return u as ItemGroup;
  return "OTHERS";
}

function normUom(u: string): SOUom {
  const up = u.toUpperCase();
  if (up === "UNIT" || up === "SET" || up === "PAIR" || up === "PCS") return up as SOUom;
  return "UNIT";
}

function normPayment(p: string): PaymentStatus {
  if (p === "Checked" || p === "Unchecked" || p === "Pending") return p;
  return "Unchecked";
}

// ─── Seed from Excel ──────────────────────────────────────────────────────────

interface RawLine {
  id: string; docNo: string; date: string; debtorCode: string; debtorName: string;
  agent: string; itemGroup: string; itemCode: string; description: string;
  description2: string; uom: string; location: string; qty: number;
  unitPrice: number; discount: number; total: number; tax: number;
  totalInc: number; balance: number; payment: string; venue: string;
  branding: string; cancelled: boolean; remark: string;
  unitCost: number; lineCost: number; lineMargin: number;
}

const seedLines: SODetailLine[] = (soLinesRaw as RawLine[]).map((r) => ({
  id: r.id, docNo: r.docNo, date: r.date, debtorCode: r.debtorCode,
  debtorName: r.debtorName, agent: r.agent,
  itemGroup: normGroup(r.itemGroup), itemCode: r.itemCode,
  description: r.description, description2: r.description2,
  uom: normUom(r.uom), location: r.location,
  qty: r.qty, unitPrice: r.unitPrice, discount: r.discount,
  total: r.total, tax: r.tax, totalInc: r.totalInc,
  balance: r.balance, paymentStatus: normPayment(r.payment),
  venue: r.venue, branding: r.branding || "NONE", remark: r.remark,
  cancelled: r.cancelled,
  unitCost: r.unitCost, lineCost: r.lineCost, lineMargin: r.lineMargin,
}));

const seedHeaders: SOHeader[] = soHeadersRaw as SOHeader[];

// ─── localStorage persistence — lines ─────────────────────────────────────────

const K_LINES = "houzs-so-lines-v3";
let listenersL: (() => void)[] = [];
let cachedL: SODetailLine[] | null = null;

function readL(): SODetailLine[] {
  if (typeof window === "undefined") return seedLines;
  const raw = localStorage.getItem(K_LINES);
  if (!raw) { localStorage.setItem(K_LINES, JSON.stringify(seedLines)); return seedLines; }
  try { return JSON.parse(raw); } catch { return seedLines; }
}

function writeL(lines: SODetailLine[]) {
  cachedL = lines;
  localStorage.setItem(K_LINES, JSON.stringify(lines));
  listenersL.forEach((fn) => fn());
}

function subscribeL(fn: () => void) {
  listenersL.push(fn);
  return () => { listenersL = listenersL.filter((l) => l !== fn); };
}

function snapshotL(): SODetailLine[] {
  if (!cachedL) cachedL = readL();
  return cachedL;
}

export function useSOLines(): SODetailLine[] {
  return useSyncExternalStore(subscribeL, snapshotL, () => seedLines);
}

// ─── localStorage persistence — headers ───────────────────────────────────────

const K_HEADERS = "houzs-so-headers-v3";
let listenersH: (() => void)[] = [];
let cachedH: SOHeader[] | null = null;

function readH(): SOHeader[] {
  if (typeof window === "undefined") return seedHeaders;
  const raw = localStorage.getItem(K_HEADERS);
  if (!raw) { localStorage.setItem(K_HEADERS, JSON.stringify(seedHeaders)); return seedHeaders; }
  try { return JSON.parse(raw); } catch { return seedHeaders; }
}

function subscribeH(fn: () => void) {
  listenersH.push(fn);
  return () => { listenersH = listenersH.filter((l) => l !== fn); };
}

function snapshotH(): SOHeader[] {
  if (!cachedH) cachedH = readH();
  return cachedH;
}

export function useSOHeaders(): SOHeader[] {
  return useSyncExternalStore(subscribeH, snapshotH, () => seedHeaders);
}

// ─── Cost calc helpers ────────────────────────────────────────────────────────

/** Sum of variant surcharges (RM, per-unit) on a line. Applies to both selling and cost. */
export function variantSurchargeRM(line: SODetailLine): number {
  const v = line.variants;
  if (!v) return 0;
  let s = 0;
  s += v.divanSurcharge ?? 0;
  s += v.legSurcharge ?? 0;
  s += v.sofaLegSurcharge ?? 0;
  if (v.specialOrders) {
    s += v.specialOrders.reduce((sum, o) => sum + (o.priceSen || 0) / 100, 0);
  }
  return s;
}

/** Recompute cost fields on a line using current SKU master.
 *  Line cost = (SKU base cost + variant surcharges) × qty.
 *  Variant surcharges flow through to cost because adding a drawer / taller divan
 *  costs the factory extra materials — so cost tracks sell. */
export function recomputeLineCost(line: SODetailLine): SODetailLine {
  const skuCost = getCostByItemCode(line.itemCode);
  const surcharge = variantSurchargeRM(line);
  const unitCost = skuCost + surcharge;
  const lineCost = unitCost * line.qty;
  return {
    ...line,
    unitCost,
    lineCost,
    lineMargin: line.total - lineCost,
  };
}

/** Recompute cost rollup on a header from its lines. */
export function recomputeHeaderCost(header: SOHeader, lines: SODetailLine[]): SOHeader {
  const docLines = lines.filter((l) => l.docNo === header.docNo);
  const totalCost = docLines.reduce((s, l) => s + l.lineCost, 0);
  const totalRevenue = docLines.reduce((s, l) => s + l.total, 0);
  const totalMargin = totalRevenue - totalCost;
  const marginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;
  return {
    ...header,
    totalCost: round2(totalCost),
    totalRevenue: round2(totalRevenue),
    totalMargin: round2(totalMargin),
    marginPct: round2(marginPct),
    lineCount: docLines.length,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ─── Mutations ────────────────────────────────────────────────────────────────

export function addSOLine(line: Omit<SODetailLine, "id" | "unitCost" | "lineCost" | "lineMargin">): string {
  const id = uid();
  const all = readL();
  const complete = recomputeLineCost({ ...line, id, unitCost: 0, lineCost: 0, lineMargin: 0 });
  all.push(complete);
  writeL(all);
  return id;
}

export function updateSOLine(id: string, patch: Partial<SODetailLine>) {
  const all = readL();
  const idx = all.findIndex((l) => l.id === id);
  if (idx < 0) return;
  const merged = { ...all[idx], ...patch };
  all[idx] = recomputeLineCost(merged);
  writeL(all);
}

export function removeSOLine(id: string) {
  const all = readL().filter((l) => l.id !== id);
  writeL(all);
}

export function resetSOLines() {
  cachedL = null;
  localStorage.removeItem(K_LINES);
  listenersL.forEach((fn) => fn());
}

export function resetSOHeaders() {
  cachedH = null;
  localStorage.removeItem(K_HEADERS);
  listenersH.forEach((fn) => fn());
}

export function resetAllSOData() {
  resetSOLines();
  resetSOHeaders();
}

// ─── Header mutations (used by New Sales Order form) ──────────────────────────

function writeH(headers: SOHeader[]) {
  cachedH = headers;
  localStorage.setItem(K_HEADERS, JSON.stringify(headers));
  listenersH.forEach((fn) => fn());
}

export function addSOHeader(header: SOHeader): void {
  const all = readH();
  all.unshift(header); // newest first
  writeH(all);
}

export function updateSOHeader(docNo: string, patch: Partial<SOHeader>): void {
  const all = readH();
  const idx = all.findIndex((h) => h.docNo === docNo);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  writeH(all);
}

export function nextSODocNo(): string {
  const all = readH();
  let max = 11500;
  for (const h of all) {
    const m = h.docNo.match(/SO-0*(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `SO-${String(max + 1).padStart(6, "0")}`;
}

// ─── Consolidation helper ─────────────────────────────────────────────────────

/**
 * Merge SO headers (address/phone/PO/remarks) with cost rollup from lines.
 * Returns one row per docNo containing all columns from sales order.xlsx plus cost/margin.
 */
export function getConsolidatedSOs(
  lines: SODetailLine[],
  _members?: SalesMember[],
  headers?: SOHeader[],
): ConsolidatedSO[] {
  const hs = headers ?? seedHeaders;
  const linesByDoc = new Map<string, SODetailLine[]>();
  for (const l of lines) {
    const arr = linesByDoc.get(l.docNo) ?? [];
    arr.push(l);
    linesByDoc.set(l.docNo, arr);
  }

  // Start from headers (authoritative source of address/phone/PO/remarks).
  const result: ConsolidatedSO[] = hs.map((h) => {
    const docLines = linesByDoc.get(h.docNo) ?? [];

    // Revenue breakdown per category (from line items — overrides header's pre-computed values)
    const mattressSofa = docLines.filter((l) => l.itemGroup === "MATTRESS" || l.itemGroup === "SOFA").reduce((s, l) => s + l.total, 0);
    const bedframe = docLines.filter((l) => l.itemGroup === "BEDFRAME").reduce((s, l) => s + l.total, 0);
    const accessories = docLines.filter((l) => l.itemGroup === "ACC" || l.itemGroup === "BEDLINES").reduce((s, l) => s + l.total, 0);
    const others = docLines.filter((l) => !["MATTRESS","SOFA","BEDFRAME","ACC","BEDLINES"].includes(l.itemGroup)).reduce((s, l) => s + l.total, 0);

    // Cost breakdown per category — live SKU master + variant surcharges
    const lineCostLive = (l: SODetailLine) => {
      const skuCost = getCostByItemCode(l.itemCode);
      return (skuCost + variantSurchargeRM(l)) * l.qty;
    };
    const mattressSofaCost = docLines.filter((l) => l.itemGroup === "MATTRESS" || l.itemGroup === "SOFA").reduce((s, l) => s + lineCostLive(l), 0);
    const bedframeCost = docLines.filter((l) => l.itemGroup === "BEDFRAME").reduce((s, l) => s + lineCostLive(l), 0);
    const accessoriesCost = docLines.filter((l) => l.itemGroup === "ACC" || l.itemGroup === "BEDLINES").reduce((s, l) => s + lineCostLive(l), 0);
    const othersCost = docLines.filter((l) => !["MATTRESS","SOFA","BEDFRAME","ACC","BEDLINES"].includes(l.itemGroup)).reduce((s, l) => s + lineCostLive(l), 0);

    const totalCost = mattressSofaCost + bedframeCost + accessoriesCost + othersCost;
    const totalRevenue = docLines.length > 0
      ? mattressSofa + bedframe + accessories + others
      : h.totalRevenue;
    const totalMargin = totalRevenue - totalCost;
    const marginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;
    const firstLine = docLines[0];

    return {
      ...h,
      debtorCode: firstLine?.debtorCode ?? "",
      reference: h.ref,
      // Revenue per category (computed from lines, fall back to header if no lines)
      mattressSofa: docLines.length > 0 ? round2(mattressSofa) : h.mattressSofa,
      bedframe: docLines.length > 0 ? round2(bedframe) : h.bedframe,
      accessories: docLines.length > 0 ? round2(accessories) : h.accessories,
      others: docLines.length > 0 ? round2(others) : h.others,
      // Cost per category
      mattressSofaCost: round2(mattressSofaCost),
      bedframeCost: round2(bedframeCost),
      accessoriesCost: round2(accessoriesCost),
      othersCost: round2(othersCost),
      // Totals
      totalCost: round2(totalCost),
      totalRevenue: round2(totalRevenue),
      totalMargin: round2(totalMargin),
      marginPct: round2(marginPct),
      lineCount: docLines.length || h.lineCount,
    };
  });

  // Include any docs that exist only in lines (not in headers)
  const headerDocs = new Set(hs.map((h) => h.docNo));
  for (const [docNo, docLines] of linesByDoc) {
    if (headerDocs.has(docNo)) continue;
    const first = docLines[0];
    const totalRevenue = docLines.reduce((s, l) => s + l.total, 0);
    const totalCost = docLines.reduce((s, l) => s + l.lineCost, 0);
    result.push({
      docNo,
      transferTo: "",
      date: first.date,
      branding: first.branding,
      debtorName: first.debtorName,
      agent: first.agent,
      salesLocation: first.location,
      ref: "",
      localTotal: totalRevenue,
      mattressSofa: docLines.filter((l) => l.itemGroup === "MATTRESS" || l.itemGroup === "SOFA").reduce((s, l) => s + l.total, 0),
      bedframe: docLines.filter((l) => l.itemGroup === "BEDFRAME").reduce((s, l) => s + l.total, 0),
      accessories: docLines.filter((l) => l.itemGroup === "ACC").reduce((s, l) => s + l.total, 0),
      others: docLines.filter((l) => !["MATTRESS","SOFA","BEDFRAME","ACC"].includes(l.itemGroup)).reduce((s, l) => s + l.total, 0),
      balance: docLines[0]?.balance ?? 0, // balance is duplicated per line in Excel — take first
      remark2: "", remark3: "", remark4: "",
      processingDate: "", salesExemptionExpiry: "", note: "",
      poDocNo: "",
      address1: "", address2: "", address3: "", address4: "",
      phone: "", venue: first.venue,
      debtorCode: first.debtorCode,
      reference: "",
      totalCost: round2(totalCost),
      totalRevenue: round2(totalRevenue),
      totalMargin: round2(totalRevenue - totalCost),
      marginPct: totalRevenue > 0 ? round2((totalRevenue - totalCost) / totalRevenue * 100) : 0,
      lineCount: docLines.length,
    });
  }

  return result;
}

// ─── Venue (project) roll-up ──────────────────────────────────────────────────

export interface VenueRollup {
  venue: string;
  orderCount: number;
  lineCount: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number;
  balance: number;
  brands: string[];
}

export function getVenueRollup(lines: SODetailLine[], headers?: SOHeader[]): VenueRollup[] {
  const byVenue = new Map<string, { docs: Set<string>; lines: SODetailLine[]; brands: Set<string>; balance: number }>();
  // Track first-seen balance per doc to avoid double-counting (balance is dup'd per line in Excel)
  const balanceByDoc = new Map<string, number>();
  for (const l of lines) {
    const v = (l.venue || "—").trim() || "—";
    let g = byVenue.get(v);
    if (!g) { g = { docs: new Set(), lines: [], brands: new Set(), balance: 0 }; byVenue.set(v, g); }
    g.docs.add(l.docNo);
    g.lines.push(l);
    if (l.branding) g.brands.add(l.branding);
    if (!balanceByDoc.has(l.docNo)) {
      balanceByDoc.set(l.docNo, l.balance);
      g.balance += l.balance;
    }
  }

  // If headers provided, pick up balance from headers too (covers docs with no lines)
  if (headers) {
    for (const h of headers) {
      const v = (h.venue || "—").trim() || "—";
      let g = byVenue.get(v);
      if (!g) { g = { docs: new Set(), lines: [], brands: new Set(), balance: 0 }; byVenue.set(v, g); }
      g.docs.add(h.docNo);
      if (h.branding) g.brands.add(h.branding);
    }
  }

  const rows: VenueRollup[] = [];
  for (const [venue, g] of byVenue) {
    const revenue = g.lines.reduce((s, l) => s + l.total, 0);
    const cost = g.lines.reduce((s, l) => s + l.lineCost, 0);
    const margin = revenue - cost;
    rows.push({
      venue,
      orderCount: g.docs.size,
      lineCount: g.lines.length,
      revenue: round2(revenue),
      cost: round2(cost),
      margin: round2(margin),
      marginPct: revenue > 0 ? round2((margin / revenue) * 100) : 0,
      balance: round2(g.balance),
      brands: [...g.brands].sort(),
    });
  }
  rows.sort((a, b) => b.revenue - a.revenue);
  return rows;
}

// ─── SKU → latest unit price lookup ───────────────────────────────────────────

export function getLatestSellPrice(itemCode: string): number {
  const lines = readL();
  // Find the most-recent line with unitPrice > 0 for this item
  let best: SODetailLine | null = null;
  for (const l of lines) {
    if (l.itemCode !== itemCode || l.unitPrice <= 0) continue;
    if (!best || l.date > best.date) best = l;
  }
  return best?.unitPrice ?? 0;
}
