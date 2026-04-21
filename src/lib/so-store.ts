// Sales Order line-item store — localStorage-backed with subscriber pattern.
// Schema matches the real Excel export: Sales Order Details.xlsx

import { useSyncExternalStore } from "react";
import type { SalesMember } from "./sales-store";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ItemGroup = "MATTRESS" | "BEDFRAME" | "ACC" | "OTHERS";
export type SOUom = "UNIT" | "SET" | "PAIR" | "PCS";
export type PaymentStatus = "Checked" | "Unchecked" | "Pending";

export const ITEM_GROUPS: ItemGroup[] = ["MATTRESS", "BEDFRAME", "ACC", "OTHERS"];
export const SO_UOMS: SOUom[] = ["UNIT", "SET", "PAIR", "PCS"];
export const PAYMENT_STATUSES: PaymentStatus[] = ["Checked", "Unchecked", "Pending"];

// Legacy compat for sku-costing-store which still imports SOCategory
export type SOCategory = "Mattress" | "Bedframe" | "Accessories" | "Pillow" | "Topper";
export const SO_CATEGORIES: SOCategory[] = ["Mattress", "Bedframe", "Accessories", "Pillow", "Topper"];

export interface SODetailLine {
  id: string;
  docNo: string;          // e.g. "SO-011120"
  date: string;           // ISO yyyy-mm-dd
  debtorCode: string;     // e.g. "300-C002"
  debtorName: string;     // customer name
  agent: string;          // sales person name (text)
  itemGroup: ItemGroup;
  itemCode: string;       // SKU
  description: string;
  description2?: string;
  uom: SOUom;
  location: string;       // e.g. "KL", "JHR"
  qty: number;
  unitPrice: number;
  discount: number;       // currency amount (not %)
  total: number;          // qty * unitPrice - discount (pre-tax)
  tax: number;
  totalInc: number;       // total + tax
  balance: number;        // outstanding
  paymentStatus: PaymentStatus;
  venue: string;
  branding: string;       // brand name
  remark?: string;
  cancelled: boolean;
}

export interface ConsolidatedSO {
  docNo: string;
  date: string;
  debtorName: string;
  debtorCode: string;
  agent: string;
  salesLocation: string;
  reference: string;
  branding: string;
  venue: string;
  localTotal: number;
  mattressSofa: number;
  bedframe: number;
  accessories: number;
  others: number;
  balance: number;
  lineCount: number;
  phone?: string;
  address?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function lineTotal(line: SODetailLine): number {
  return line.total;
}

// ─── Seed data ────────────────────────────────────────────────────────────────

const seedLines: SODetailLine[] = [
  // SO-011120 — ZANOTTI, Tan Wei Liang, SHAWN, AEON MALL IPOH
  {
    id: "sol-001", docNo: "SO-011120", date: "2025-01-15", debtorCode: "300-C001",
    debtorName: "Tan Wei Liang", agent: "SHAWN",
    itemGroup: "MATTRESS", itemCode: "ZNT-K-DELUXE", description: "Zanotti King Deluxe Mattress",
    description2: "King 180x200cm Dual-Comfort, 2-yr warranty", uom: "UNIT",
    location: "PER", qty: 1, unitPrice: 5800, discount: 300, total: 5500, tax: 0, totalInc: 5500,
    balance: 2750, paymentStatus: "Pending", venue: "AEON MALL IPOH", branding: "ZANOTTI",
    remark: "King size, firm side out", cancelled: false,
  },
  {
    id: "sol-002", docNo: "SO-011120", date: "2025-01-15", debtorCode: "300-C001",
    debtorName: "Tan Wei Liang", agent: "SHAWN",
    itemGroup: "BEDFRAME", itemCode: "ZNT-K-BF-ELENA", description: "Zanotti Elena King Bedframe",
    description2: "King 180x200cm Fabric Upholstered", uom: "UNIT",
    location: "PER", qty: 1, unitPrice: 3200, discount: 200, total: 3000, tax: 0, totalInc: 3000,
    balance: 1500, paymentStatus: "Pending", venue: "AEON MALL IPOH", branding: "ZANOTTI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-003", docNo: "SO-011120", date: "2025-01-15", debtorCode: "300-C001",
    debtorName: "Tan Wei Liang", agent: "SHAWN",
    itemGroup: "ACC", itemCode: "ZNT-PIL-LATEX", description: "Zanotti Latex Pillow Pair",
    description2: "", uom: "PAIR",
    location: "PER", qty: 2, unitPrice: 380, discount: 0, total: 760, tax: 0, totalInc: 760,
    balance: 0, paymentStatus: "Checked", venue: "AEON MALL IPOH", branding: "ZANOTTI",
    remark: "", cancelled: false,
  },

  // SO-011121 — ZANOTTI, Lim Siew Peng, STANLEY, MITSUI OUTLET PARK
  {
    id: "sol-004", docNo: "SO-011121", date: "2025-01-20", debtorCode: "300-C002",
    debtorName: "Lim Siew Peng", agent: "STANLEY",
    itemGroup: "MATTRESS", itemCode: "ZNT-Q-SIGNATURE", description: "Zanotti Queen Signature Mattress",
    description2: "Queen 160x200cm CoolGel Memory", uom: "UNIT",
    location: "KL", qty: 1, unitPrice: 4200, discount: 200, total: 4000, tax: 0, totalInc: 4000,
    balance: 4000, paymentStatus: "Unchecked", venue: "MITSUI OUTLET PARK", branding: "ZANOTTI",
    remark: "Customer requested firm comfort", cancelled: false,
  },
  {
    id: "sol-005", docNo: "SO-011121", date: "2025-01-20", debtorCode: "300-C002",
    debtorName: "Lim Siew Peng", agent: "STANLEY",
    itemGroup: "ACC", itemCode: "ZNT-TOP-COOL", description: "Zanotti CoolGel Topper Queen",
    description2: "", uom: "UNIT",
    location: "KL", qty: 1, unitPrice: 890, discount: 50, total: 840, tax: 0, totalInc: 840,
    balance: 840, paymentStatus: "Unchecked", venue: "MITSUI OUTLET PARK", branding: "ZANOTTI",
    remark: "", cancelled: false,
  },

  // SO-011122 — AKEMI, Chong Hui Ying, ANTHONY, MYTOWN SHOPPING CENTRE
  {
    id: "sol-006", docNo: "SO-011122", date: "2025-02-03", debtorCode: "300-C003",
    debtorName: "Chong Hui Ying", agent: "ANTHONY",
    itemGroup: "MATTRESS", itemCode: "AK-Q-PURELATEX", description: "Akemi Pure Latex Queen Mattress",
    description2: "Queen 160x200cm Natural Latex 22cm", uom: "UNIT",
    location: "KL", qty: 1, unitPrice: 4600, discount: 400, total: 4200, tax: 0, totalInc: 4200,
    balance: 2100, paymentStatus: "Pending", venue: "MYTOWN SHOPPING CENTRE", branding: "AKEMI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-007", docNo: "SO-011122", date: "2025-02-03", debtorCode: "300-C003",
    debtorName: "Chong Hui Ying", agent: "ANTHONY",
    itemGroup: "BEDFRAME", itemCode: "AK-Q-BF-NORDIC", description: "Akemi Nordic Queen Bedframe",
    description2: "Queen Nordic Solid Wood Base", uom: "UNIT",
    location: "KL", qty: 1, unitPrice: 2800, discount: 150, total: 2650, tax: 0, totalInc: 2650,
    balance: 1325, paymentStatus: "Pending", venue: "MYTOWN SHOPPING CENTRE", branding: "AKEMI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-008", docNo: "SO-011122", date: "2025-02-03", debtorCode: "300-C003",
    debtorName: "Chong Hui Ying", agent: "ANTHONY",
    itemGroup: "ACC", itemCode: "AK-PILLOW-HYDRO", description: "Akemi Hydro Cool Pillow",
    description2: "", uom: "PAIR",
    location: "KL", qty: 2, unitPrice: 280, discount: 0, total: 560, tax: 0, totalInc: 560,
    balance: 0, paymentStatus: "Checked", venue: "MYTOWN SHOPPING CENTRE", branding: "AKEMI",
    remark: "", cancelled: false,
  },

  // SO-011123 — AKEMI, Ng Boon Seng, PEIFEN, IKEA CHERAS
  {
    id: "sol-009", docNo: "SO-011123", date: "2025-02-14", debtorCode: "300-C004",
    debtorName: "Ng Boon Seng", agent: "PEIFEN",
    itemGroup: "MATTRESS", itemCode: "AK-S-ORTHO", description: "Akemi Ortho Single Mattress",
    description2: "Single 100x200cm Orthopaedic Support", uom: "UNIT",
    location: "KL", qty: 2, unitPrice: 1800, discount: 100, total: 3500, tax: 0, totalInc: 3500,
    balance: 1750, paymentStatus: "Pending", venue: "IKEA CHERAS", branding: "AKEMI",
    remark: "Twin room setup", cancelled: false,
  },
  {
    id: "sol-010", docNo: "SO-011123", date: "2025-02-14", debtorCode: "300-C004",
    debtorName: "Ng Boon Seng", agent: "PEIFEN",
    itemGroup: "ACC", itemCode: "AK-ACC-PROTECT", description: "Akemi Waterproof Mattress Protector Single",
    description2: "", uom: "UNIT",
    location: "KL", qty: 2, unitPrice: 160, discount: 0, total: 320, tax: 0, totalInc: 320,
    balance: 0, paymentStatus: "Checked", venue: "IKEA CHERAS", branding: "AKEMI",
    remark: "", cancelled: false,
  },

  // SO-011124 — DUNLOPILLO, Farah Nadia binti Aziz, SHAWN, AEON MALL SEREMBAN 2
  {
    id: "sol-011", docNo: "SO-011124", date: "2025-02-22", debtorCode: "300-C005",
    debtorName: "Farah Nadia binti Aziz", agent: "SHAWN",
    itemGroup: "MATTRESS", itemCode: "DUN-K-CLASSIC", description: "Dunlopillo Classic King Mattress",
    description2: "King 180x200cm Natural Latex Core", uom: "UNIT",
    location: "NS", qty: 1, unitPrice: 3900, discount: 250, total: 3650, tax: 0, totalInc: 3650,
    balance: 3650, paymentStatus: "Unchecked", venue: "AEON MALL SEREMBAN 2", branding: "DUNLOPILLO",
    remark: "", cancelled: false,
  },
  {
    id: "sol-012", docNo: "SO-011124", date: "2025-02-22", debtorCode: "300-C005",
    debtorName: "Farah Nadia binti Aziz", agent: "SHAWN",
    itemGroup: "ACC", itemCode: "DUN-TOP-LATEX", description: "Dunlopillo Natural Latex Topper King",
    description2: "", uom: "UNIT",
    location: "NS", qty: 1, unitPrice: 1200, discount: 100, total: 1100, tax: 0, totalInc: 1100,
    balance: 0, paymentStatus: "Checked", venue: "AEON MALL SEREMBAN 2", branding: "DUNLOPILLO",
    remark: "", cancelled: false,
  },

  // SO-011125 — ERGOTEX, Ahmad Firdaus bin Khalid, LUIS, SUNWAY PYRAMID
  {
    id: "sol-013", docNo: "SO-011125", date: "2025-03-05", debtorCode: "300-C006",
    debtorName: "Ahmad Firdaus bin Khalid", agent: "LUIS",
    itemGroup: "MATTRESS", itemCode: "EGT-Q-ERGO3000", description: "Ergotex Ergo 3000 Queen Mattress",
    description2: "Queen 160x200cm Dual Zone Pocket Spring", uom: "UNIT",
    location: "SEL", qty: 1, unitPrice: 3600, discount: 300, total: 3300, tax: 0, totalInc: 3300,
    balance: 1650, paymentStatus: "Pending", venue: "SUNWAY PYRAMID", branding: "ERGOTEX",
    remark: "Delivery to Petaling Jaya", cancelled: false,
  },
  {
    id: "sol-014", docNo: "SO-011125", date: "2025-03-05", debtorCode: "300-C006",
    debtorName: "Ahmad Firdaus bin Khalid", agent: "LUIS",
    itemGroup: "BEDFRAME", itemCode: "EGT-Q-BF-METRO", description: "Ergotex Metro Queen Bedframe",
    description2: "Queen Metal Frame Storage Base", uom: "UNIT",
    location: "SEL", qty: 1, unitPrice: 1900, discount: 0, total: 1900, tax: 0, totalInc: 1900,
    balance: 950, paymentStatus: "Pending", venue: "SUNWAY PYRAMID", branding: "ERGOTEX",
    remark: "", cancelled: false,
  },

  // SO-011126 — AKEMI, Wong Mei Lin, MELVIN CHONG, PAVILION BUKIT JALIL
  {
    id: "sol-015", docNo: "SO-011126", date: "2025-03-12", debtorCode: "300-C007",
    debtorName: "Wong Mei Lin", agent: "MELVIN CHONG",
    itemGroup: "MATTRESS", itemCode: "AK-K-CLOUDMAX", description: "Akemi CloudMax King Mattress",
    description2: "King 180x200cm Pillow-Top Memory Foam", uom: "UNIT",
    location: "KL", qty: 1, unitPrice: 6200, discount: 500, total: 5700, tax: 0, totalInc: 5700,
    balance: 2850, paymentStatus: "Pending", venue: "PAVILION BUKIT JALIL", branding: "AKEMI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-016", docNo: "SO-011126", date: "2025-03-12", debtorCode: "300-C007",
    debtorName: "Wong Mei Lin", agent: "MELVIN CHONG",
    itemGroup: "BEDFRAME", itemCode: "AK-K-BF-HAVEN", description: "Akemi Haven King Bedframe",
    description2: "King Leather-wrapped Upholstered Base", uom: "UNIT",
    location: "KL", qty: 1, unitPrice: 3500, discount: 200, total: 3300, tax: 0, totalInc: 3300,
    balance: 1650, paymentStatus: "Pending", venue: "PAVILION BUKIT JALIL", branding: "AKEMI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-017", docNo: "SO-011126", date: "2025-03-12", debtorCode: "300-C007",
    debtorName: "Wong Mei Lin", agent: "MELVIN CHONG",
    itemGroup: "ACC", itemCode: "AK-BOLSTER-LATEX", description: "Akemi Latex Bolster",
    description2: "", uom: "UNIT",
    location: "KL", qty: 2, unitPrice: 220, discount: 0, total: 440, tax: 0, totalInc: 440,
    balance: 0, paymentStatus: "Checked", venue: "PAVILION BUKIT JALIL", branding: "AKEMI",
    remark: "", cancelled: false,
  },

  // SO-011127 — ZANOTTI, Nurul Ain binti Hassan, KINGSLEY, KLANG PARADE
  {
    id: "sol-018", docNo: "SO-011127", date: "2025-03-18", debtorCode: "300-C008",
    debtorName: "Nurul Ain binti Hassan", agent: "KINGSLEY",
    itemGroup: "MATTRESS", itemCode: "ZNT-S-PLUSH", description: "Zanotti Plush Super Single Mattress",
    description2: "Super Single 107x200cm Euro-top Plush", uom: "UNIT",
    location: "SEL", qty: 1, unitPrice: 3200, discount: 200, total: 3000, tax: 0, totalInc: 3000,
    balance: 0, paymentStatus: "Checked", venue: "KLANG PARADE", branding: "ZANOTTI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-019", docNo: "SO-011127", date: "2025-03-18", debtorCode: "300-C008",
    debtorName: "Nurul Ain binti Hassan", agent: "KINGSLEY",
    itemGroup: "BEDFRAME", itemCode: "ZNT-S-BF-GRACE", description: "Zanotti Grace Super Single Bedframe",
    description2: "Super Single Fabric Headboard with Storage", uom: "UNIT",
    location: "SEL", qty: 1, unitPrice: 2400, discount: 150, total: 2250, tax: 0, totalInc: 2250,
    balance: 0, paymentStatus: "Checked", venue: "KLANG PARADE", branding: "ZANOTTI",
    remark: "", cancelled: false,
  },

  // SO-011128 — DUNLOPILLO, Lee Chee Keat, PETER, PARADIGM MALL JB
  {
    id: "sol-020", docNo: "SO-011128", date: "2025-03-25", debtorCode: "300-C009",
    debtorName: "Lee Chee Keat", agent: "PETER",
    itemGroup: "MATTRESS", itemCode: "DUN-Q-PRESTIGE", description: "Dunlopillo Prestige Queen Mattress",
    description2: "Queen 160x200cm Premium Latex & Springs", uom: "UNIT",
    location: "JHR", qty: 1, unitPrice: 5200, discount: 400, total: 4800, tax: 0, totalInc: 4800,
    balance: 4800, paymentStatus: "Unchecked", venue: "PARADIGM MALL JB", branding: "DUNLOPILLO",
    remark: "Priority delivery requested", cancelled: false,
  },
  {
    id: "sol-021", docNo: "SO-011128", date: "2025-03-25", debtorCode: "300-C009",
    debtorName: "Lee Chee Keat", agent: "PETER",
    itemGroup: "ACC", itemCode: "DUN-PIL-NATURAL", description: "Dunlopillo Natural Latex Pillow",
    description2: "", uom: "PAIR",
    location: "JHR", qty: 1, unitPrice: 520, discount: 0, total: 520, tax: 0, totalInc: 520,
    balance: 520, paymentStatus: "Unchecked", venue: "PARADIGM MALL JB", branding: "DUNLOPILLO",
    remark: "", cancelled: false,
  },

  // SO-011129 — AKEMI, Siti Rahmah binti Yusof, STANLEY, AEON KOTA BHARU
  {
    id: "sol-022", docNo: "SO-011129", date: "2025-04-02", debtorCode: "300-C010",
    debtorName: "Siti Rahmah binti Yusof", agent: "STANLEY",
    itemGroup: "MATTRESS", itemCode: "AK-Q-PURELATEX", description: "Akemi Pure Latex Queen Mattress",
    description2: "Queen Natural Latex 22cm", uom: "UNIT",
    location: "KEL", qty: 1, unitPrice: 4600, discount: 350, total: 4250, tax: 0, totalInc: 4250,
    balance: 2125, paymentStatus: "Pending", venue: "AEON KOTA BHARU", branding: "AKEMI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-023", docNo: "SO-011129", date: "2025-04-02", debtorCode: "300-C010",
    debtorName: "Siti Rahmah binti Yusof", agent: "STANLEY",
    itemGroup: "OTHERS", itemCode: "AK-SVC-DELIVERY", description: "Akemi Premium Delivery & Setup",
    description2: "Delivery + old mattress removal", uom: "UNIT",
    location: "KEL", qty: 1, unitPrice: 250, discount: 250, total: 0, tax: 0, totalInc: 0,
    balance: 0, paymentStatus: "Checked", venue: "AEON KOTA BHARU", branding: "AKEMI",
    remark: "Free delivery promo", cancelled: false,
  },

  // SO-011130 — ERGOTEX, Rajendran a/l Muthu, ANTHONY, SUNWAY CARNIVAL MALL
  {
    id: "sol-024", docNo: "SO-011130", date: "2025-04-10", debtorCode: "300-C011",
    debtorName: "Rajendran a/l Muthu", agent: "ANTHONY",
    itemGroup: "MATTRESS", itemCode: "EGT-K-ERGO5000", description: "Ergotex Ergo 5000 King Mattress",
    description2: "King Luxury Hybrid Pocket Spring + Latex", uom: "UNIT",
    location: "PEN", qty: 1, unitPrice: 5500, discount: 500, total: 5000, tax: 0, totalInc: 5000,
    balance: 2500, paymentStatus: "Pending", venue: "SUNWAY CARNIVAL MALL", branding: "ERGOTEX",
    remark: "", cancelled: false,
  },
  {
    id: "sol-025", docNo: "SO-011130", date: "2025-04-10", debtorCode: "300-C011",
    debtorName: "Rajendran a/l Muthu", agent: "ANTHONY",
    itemGroup: "BEDFRAME", itemCode: "EGT-K-BF-COSMO", description: "Ergotex Cosmo King Bedframe",
    description2: "King Wenge Wood Frame with Drawers", uom: "UNIT",
    location: "PEN", qty: 1, unitPrice: 2600, discount: 100, total: 2500, tax: 0, totalInc: 2500,
    balance: 1250, paymentStatus: "Pending", venue: "SUNWAY CARNIVAL MALL", branding: "ERGOTEX",
    remark: "", cancelled: false,
  },
  {
    id: "sol-026", docNo: "SO-011130", date: "2025-04-10", debtorCode: "300-C011",
    debtorName: "Rajendran a/l Muthu", agent: "ANTHONY",
    itemGroup: "ACC", itemCode: "EGT-ACC-SHEET-K", description: "Ergotex King Fitted Sheet Set",
    description2: "", uom: "SET",
    location: "PEN", qty: 1, unitPrice: 380, discount: 0, total: 380, tax: 0, totalInc: 380,
    balance: 0, paymentStatus: "Checked", venue: "SUNWAY CARNIVAL MALL", branding: "ERGOTEX",
    remark: "", cancelled: false,
  },

  // SO-011131 — ZANOTTI, Tan Boon Huat, LUIS, AEON BUKIT TINGGI
  {
    id: "sol-027", docNo: "SO-011131", date: "2025-04-15", debtorCode: "300-C012",
    debtorName: "Tan Boon Huat", agent: "LUIS",
    itemGroup: "MATTRESS", itemCode: "ZNT-Q-CLOUD", description: "Zanotti Cloud Queen Mattress",
    description2: "Queen 160x200cm Plush Pillow-top", uom: "UNIT",
    location: "SEL", qty: 1, unitPrice: 4800, discount: 300, total: 4500, tax: 0, totalInc: 4500,
    balance: 0, paymentStatus: "Checked", venue: "AEON BUKIT TINGGI", branding: "ZANOTTI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-028", docNo: "SO-011131", date: "2025-04-15", debtorCode: "300-C012",
    debtorName: "Tan Boon Huat", agent: "LUIS",
    itemGroup: "BEDFRAME", itemCode: "ZNT-Q-BF-ROYALE", description: "Zanotti Royale Queen Bedframe",
    description2: "Queen Button-tufted Velvet Headboard", uom: "UNIT",
    location: "SEL", qty: 1, unitPrice: 3800, discount: 300, total: 3500, tax: 0, totalInc: 3500,
    balance: 1750, paymentStatus: "Pending", venue: "AEON BUKIT TINGGI", branding: "ZANOTTI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-029", docNo: "SO-011131", date: "2025-04-15", debtorCode: "300-C012",
    debtorName: "Tan Boon Huat", agent: "LUIS",
    itemGroup: "ACC", itemCode: "ZNT-TOP-MEM-Q", description: "Zanotti Memory Foam Topper Queen",
    description2: "", uom: "UNIT",
    location: "SEL", qty: 1, unitPrice: 780, discount: 80, total: 700, tax: 0, totalInc: 700,
    balance: 0, paymentStatus: "Checked", venue: "AEON BUKIT TINGGI", branding: "ZANOTTI",
    remark: "", cancelled: false,
  },
  {
    id: "sol-030", docNo: "SO-011131", date: "2025-04-15", debtorCode: "300-C012",
    debtorName: "Tan Boon Huat", agent: "LUIS",
    itemGroup: "OTHERS", itemCode: "SVC-DISPOSAL", description: "Old Mattress Disposal Service",
    description2: "", uom: "UNIT",
    location: "SEL", qty: 1, unitPrice: 150, discount: 0, total: 150, tax: 0, totalInc: 150,
    balance: 150, paymentStatus: "Unchecked", venue: "AEON BUKIT TINGGI", branding: "ZANOTTI",
    remark: "Awaiting confirmation", cancelled: false,
  },
];

// ─── localStorage persistence ──────────────────────────────────────────────────

const K = "houzs-so-lines-v2";
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
  _members?: SalesMember[],
): ConsolidatedSO[] {
  const grouped = new Map<string, SODetailLine[]>();
  for (const line of lines) {
    const arr = grouped.get(line.docNo) ?? [];
    arr.push(line);
    grouped.set(line.docNo, arr);
  }
  return Array.from(grouped.entries()).map(([docNo, soLines]) => {
    const first = soLines[0];
    return {
      docNo,
      date: first.date,
      debtorName: first.debtorName,
      debtorCode: first.debtorCode,
      agent: first.agent,
      salesLocation: first.location,
      reference: first.remark ?? "",
      branding: first.branding,
      venue: first.venue,
      localTotal: soLines.reduce((s, l) => s + l.totalInc, 0),
      mattressSofa: soLines.filter((l) => l.itemGroup === "MATTRESS").reduce((s, l) => s + l.total, 0),
      bedframe: soLines.filter((l) => l.itemGroup === "BEDFRAME").reduce((s, l) => s + l.total, 0),
      accessories: soLines.filter((l) => l.itemGroup === "ACC").reduce((s, l) => s + l.total, 0),
      others: soLines.filter((l) => l.itemGroup === "OTHERS").reduce((s, l) => s + l.total, 0),
      balance: soLines.reduce((s, l) => s + l.balance, 0),
      lineCount: soLines.length,
      phone: undefined,
      address: undefined,
    };
  });
}
