"use client";

// Sales team member store — localStorage-backed with subscriber pattern.
// Supports MLM-style tree hierarchy with position, brand assignment, and
// commission tiers.

import { useSyncExternalStore } from "react";
import type { Brand } from "./mock-data";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemberStatus = "ACTIVE" | "INACTIVE";

export interface CommissionTier {
  minSales: number;  // e.g. 0
  maxSales: number;  // e.g. 50000 (Infinity for uncapped)
  pct: number;       // e.g. 3 (means 3%)
}

export interface SalesMember {
  id: string;
  name: string;
  code: string;             // short code (e.g. "SHAWN", "Hwasheng")
  phone: string;
  email: string;
  ic?: string;
  position: string;         // "Sales Director", "Sales Executive", custom
  parentId: string;         // "" = root (no upline)
  joinDate: string;
  status: MemberStatus;
  assignedBrands: Brand[];  // which brands this person handles
  commissionTiers: CommissionTier[];  // personal commission structure
  notes?: string;
}

// ─── Positions ───────────────────────────────────────────────────────────────

export const DEFAULT_POSITIONS = [
  "Sales Director",
  "Sales Manager",
  "Sales Executive",
  "Sales Trainee",
];

// ─── Default commission tiers ────────────────────────────────────────────────

export const DEFAULT_COMMISSION: CommissionTier[] = [
  { minSales: 0,      maxSales: 30000,   pct: 2 },
  { minSales: 30000,  maxSales: 60000,   pct: 3 },
  { minSales: 60000,  maxSales: 100000,  pct: 4 },
  { minSales: 100000, maxSales: Infinity, pct: 5 },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function mkId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
}

// ─── Seed data from Excel exports ────────────────────────────────────────────

const seedMembers: SalesMember[] = [
  // === Sales Directors (from export (1).xlsx) ===
  { id: "dir-peter",    name: "PETER",    code: "PETER",    phone: "+601128858819", email: "yzhe212@gmail.com",         ic: "", position: "Sales Director", parentId: "",            joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: ["AKEMI"],    commissionTiers: [] },
  { id: "dir-kris",     name: "KRIS",     code: "KRIS",     phone: "+60126008198",  email: "suihor00@gmail.com",        ic: "", position: "Sales Director", parentId: "",            joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: [],           commissionTiers: [] },
  { id: "dir-kingsley", name: "KINGSLEY", code: "KINGSLEY", phone: "+60123570401",  email: "shopckingsley@gmail.com",   ic: "", position: "Sales Director", parentId: "",            joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: ["AKEMI", "ZANOTTI"], commissionTiers: [] },

  // === Sales Executives (from export.xlsx) — with upline ===
  { id: "exe-shawn",     name: "SHAWN",              code: "SHAWN",          phone: "+60109820330",   email: "gajeel333@gmail.com",          ic: "", position: "Sales Executive", parentId: "dir-peter",    joinDate: "2024-01-15", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-stanley",   name: "STANLEY",            code: "STANLEY",        phone: "+601127139334",  email: "shopcstanley@gmail.com",       ic: "", position: "Sales Executive", parentId: "dir-kingsley", joinDate: "2024-01-15", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-anthony",   name: "ANTHONY",            code: "ANTHONY",        phone: "+60164078555",   email: "hongchang6666@gmail.com",      ic: "", position: "Sales Executive", parentId: "dir-peter",    joinDate: "2024-02-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-lawrence",  name: "LAWRENCE",           code: "LAWRENCE",       phone: "+60164600347",   email: "Jiankhuan01@gmail.com",        ic: "", position: "Sales Executive", parentId: "dir-peter",    joinDate: "2024-02-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-junie",     name: "JUNIE",              code: "JUNIE",          phone: "+60174701988",   email: "junie.nini910@gmail.com",      ic: "", position: "Sales Executive", parentId: "dir-peter",    joinDate: "2024-02-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-meiting",   name: "MEI TING",           code: "MEI TING",       phone: "+60163375592",   email: "ymting3943@gmail.com",         ic: "", position: "Sales Executive", parentId: "dir-peter",    joinDate: "2024-03-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-cheahuan",  name: "CHEA HUAN",          code: "CHEA HUAN",      phone: "+60164207508",   email: "cheahuan520@gmail.com",        ic: "", position: "Sales Executive", parentId: "dir-kingsley", joinDate: "2024-03-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-yang",      name: "YANG",               code: "YANG",           phone: "+60162143943",   email: "somenoe98@gmail.com",          ic: "", position: "Sales Executive", parentId: "dir-kingsley", joinDate: "2024-03-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-yuny",      name: "YUNY",               code: "YUNY",           phone: "+60165590827",   email: "ziyunc90@gmail.com",           ic: "", position: "Sales Executive", parentId: "exe-anthony",  joinDate: "2024-04-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-rachael",   name: "RACHAEL",            code: "RACHAEL",        phone: "+601111225524",  email: "Rachael.Lim01@gmail.com",      ic: "", position: "Sales Executive", parentId: "dir-kingsley", joinDate: "2024-04-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-weihow",    name: "WEI HOW",            code: "WEI HOW",        phone: "+60175269363",   email: "ganweihow0703@gmail.com",      ic: "", position: "Sales Executive", parentId: "dir-kingsley", joinDate: "2024-04-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under SHAWN ---
  { id: "exe-weipin",    name: "WEIPIN NGIAU",       code: "WEIPIN",         phone: "+60177371838",   email: "ngiauweipin01@gmail.com",      ic: "", position: "Sales Executive", parentId: "exe-shawn",    joinDate: "2024-05-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-peifen",    name: "PEIFEN",             code: "Peifen",         phone: "+60164748893",   email: "peifenv1228@gmail.com",        ic: "", position: "Sales Executive", parentId: "exe-shawn",    joinDate: "2024-05-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-sally",     name: "SALLY",              code: "SALLY",          phone: "+60139821886",   email: "k.c.thing.kct@gmail.com",      ic: "", position: "Sales Executive", parentId: "exe-shawn",    joinDate: "2024-06-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-jane",      name: "JANE",               code: "JANE",           phone: "+601111411606",  email: "ooij121@gmail.com",            ic: "", position: "Sales Executive", parentId: "exe-shawn",    joinDate: "2024-06-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under STANLEY ---
  { id: "exe-chongyee",  name: "CHONG CHAN YEE",     code: "MELVIN CHONG",   phone: "+60122895355",   email: "Ahzhang0408@gmail.com",        ic: "", position: "Sales Executive", parentId: "exe-stanley",  joinDate: "2024-05-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-soojia",    name: "SOO JIA XIAN",       code: "ETHAN SOO",      phone: "+60165210308",   email: "xianxian0610@gmail.com",       ic: "", position: "Sales Executive", parentId: "exe-stanley",  joinDate: "2024-05-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-sheldon",   name: "SHELDON TAN",        code: "SHELDON",        phone: "+60108274584",   email: "donghongtan@gmail.com",        ic: "", position: "Sales Executive", parentId: "exe-stanley",  joinDate: "2024-05-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-james",     name: "JAMES SEOW AIK HOOI",code: "JAMES SEOW",    phone: "+60168423662",   email: "aikhooi456@gmail.com",         ic: "", position: "Sales Executive", parentId: "exe-stanley",  joinDate: "2024-05-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-lucas",     name: "TAN JIA HOU",        code: "LUCAS",          phone: "+60164863706",   email: "shopc.jhou@gmail.com",         ic: "", position: "Sales Executive", parentId: "exe-stanley",  joinDate: "2024-06-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-esther",    name: "ESTHER CHONG",       code: "ESTHER CHONG",   phone: "+60194720066",   email: "estherchong8188@gmail.com",    ic: "", position: "Sales Executive", parentId: "exe-stanley",  joinDate: "2024-06-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-adrian",    name: "ADRIAN",             code: "ADRIAN",         phone: "+601161406162",  email: "adrianleejialiang000125@gmail.com", ic: "", position: "Sales Executive", parentId: "exe-stanley",  joinDate: "2024-07-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-karjiun",   name: "TAN KAR JIUN",       code: "TAN KAR JIUN",  phone: "+601120420427",  email: "shopckarjiun@gmail.com",       ic: "", position: "Sales Executive", parentId: "exe-stanley",  joinDate: "2024-07-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under ANTHONY ---
  { id: "exe-stephy",    name: "STEPHY",             code: "STEPHY",         phone: "+60174113223",   email: "jxuan060298@gmail.com",        ic: "", position: "Sales Executive", parentId: "exe-anthony",  joinDate: "2024-06-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-jonas",     name: "SIA JONAS",          code: "SIA JONAS",      phone: "+60195714625",   email: "jonassia040212@gmail.com",     ic: "", position: "Sales Executive", parentId: "exe-anthony",  joinDate: "2024-07-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under LAWRENCE ---
  { id: "exe-luis",      name: "LUIS",               code: "LUIS",           phone: "+601110938255",  email: "teochinghuan@gmail.com",       ic: "", position: "Sales Executive", parentId: "exe-lawrence", joinDate: "2024-07-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under JUNIE ---
  { id: "exe-phoebe",   name: "YEAP MIN HUA",       code: "Phoebe",         phone: "+60165236652",   email: "minhua1607@gmail.com",         ic: "", position: "Sales Executive", parentId: "exe-junie",    joinDate: "2024-08-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under CHEA HUAN ---
  { id: "exe-yauwei",   name: "LIM YAU WEI",        code: "Lim Yau Wei",    phone: "+60124007602",   email: "limyauwei7602@gmail.com",      ic: "", position: "Sales Executive", parentId: "exe-cheahuan", joinDate: "2024-06-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-zack",     name: "ONG ZI MIN",          code: "Zack",           phone: "+60165109198",   email: "ongzimin@gmail.com",           ic: "", position: "Sales Executive", parentId: "exe-cheahuan", joinDate: "2024-08-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under YANG ---
  { id: "exe-shiting",  name: "CHANG SHI TING",      code: "CHANG SHI TING", phone: "+60169508618",   email: "cshiting35@gmail.com",         ic: "", position: "Sales Executive", parentId: "exe-yang",     joinDate: "2024-08-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under YUNY ---
  { id: "exe-wenggi",   name: "WENGGI",             code: "WENGGI",         phone: "+60125131162",   email: "foowenggi@gmail.com",          ic: "", position: "Sales Executive", parentId: "exe-yuny",     joinDate: "2024-05-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under PETER (direct) ---
  { id: "exe-hwasheng", name: "TEH HWA SHENG",      code: "Hwasheng",       phone: "+601127441525",  email: "tehhwasheng25052001@gmail.com", ic: "", position: "Sales Executive", parentId: "dir-peter",    joinDate: "2024-04-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Under KINGSLEY (direct) ---
  { id: "exe-xiaorou",  name: "LEE SZE ROU",         code: "XIAO ROU",      phone: "+601110887296",  email: "bbxiaorou.0709@gmail.com",     ic: "", position: "Sales Executive", parentId: "dir-kingsley", joinDate: "2024-06-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },

  // --- Unassigned (no upline) ---
  { id: "exe-others",   name: "OTHERS",             code: "OTHERS",         phone: "",               email: "",                             ic: "", position: "Sales Executive", parentId: "",             joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-siang",    name: "SIANG",              code: "SIANG",          phone: "",               email: "",                             ic: "", position: "Sales Executive", parentId: "",             joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-alvin",    name: "ALVIN",              code: "ALVIN",          phone: "",               email: "",                             ic: "", position: "Sales Executive", parentId: "",             joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-alex",     name: "ALEX",               code: "ALEX",           phone: "",               email: "",                             ic: "", position: "Sales Executive", parentId: "",             joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-ww",       name: "WW",                 code: "WW",             phone: "",               email: "",                             ic: "", position: "Sales Executive", parentId: "",             joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-mk",       name: "MK",                 code: "MK",             phone: "",               email: "",                             ic: "", position: "Sales Executive", parentId: "",             joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
  { id: "exe-liang",    name: "LIANG",              code: "LIANG",          phone: "",               email: "",                             ic: "", position: "Sales Executive", parentId: "",             joinDate: "2024-01-01", status: "ACTIVE", assignedBrands: [], commissionTiers: [] },
];

// ─── localStorage persistence ────────────────────────────────────────────────

const K = "houzs_sales_members";
const K_POS = "houzs_sales_positions";
const K_COMM = "houzs_sales_default_commission";
let listeners: (() => void)[] = [];

function read(): SalesMember[] {
  if (typeof window === "undefined") return seedMembers;
  const raw = localStorage.getItem(K);
  if (!raw) { localStorage.setItem(K, JSON.stringify(seedMembers)); return seedMembers; }
  try { return JSON.parse(raw); } catch { return seedMembers; }
}

function write(members: SalesMember[]) {
  localStorage.setItem(K, JSON.stringify(members));
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function getSnapshot(): SalesMember[] { return read(); }

// ─── Positions persistence ───────────────────────────────────────────────────

export function readPositions(): string[] {
  if (typeof window === "undefined") return DEFAULT_POSITIONS;
  const raw = localStorage.getItem(K_POS);
  if (!raw) return DEFAULT_POSITIONS;
  try { return JSON.parse(raw); } catch { return DEFAULT_POSITIONS; }
}

export function writePositions(positions: string[]) {
  localStorage.setItem(K_POS, JSON.stringify(positions));
  listeners.forEach((fn) => fn());
}

// ─── Default commission persistence ──────────────────────────────────────────

export function readDefaultCommission(): CommissionTier[] {
  if (typeof window === "undefined") return DEFAULT_COMMISSION;
  const raw = localStorage.getItem(K_COMM);
  if (!raw) return DEFAULT_COMMISSION;
  try {
    return JSON.parse(raw, (key, val) => val === null && key === "maxSales" ? Infinity : val);
  } catch { return DEFAULT_COMMISSION; }
}

export function writeDefaultCommission(tiers: CommissionTier[]) {
  localStorage.setItem(
    K_COMM,
    JSON.stringify(tiers, (key, val) => val === Infinity ? null : val)
  );
  listeners.forEach((fn) => fn());
}

/** Calculate commission from tiers for a given sales amount. */
export function calcCommission(sales: number, tiers: CommissionTier[]): number {
  const effective = tiers.length > 0 ? tiers : readDefaultCommission();
  let total = 0;
  for (const t of effective) {
    if (sales <= t.minSales) break;
    const applicable = Math.min(sales, t.maxSales === Infinity ? sales : t.maxSales) - t.minSales;
    if (applicable > 0) total += applicable * (t.pct / 100);
  }
  return total;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSalesMembers(): SalesMember[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => seedMembers);
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export function addMember(m: Omit<SalesMember, "id">): string {
  const id = uid();
  const all = read();
  all.push({ ...m, id });
  write(all);
  return id;
}

export function updateMember(id: string, patch: Partial<SalesMember>) {
  const all = read();
  const idx = all.findIndex((m) => m.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  write(all);
}

export function removeMember(id: string) {
  let all = read();
  const removed = all.find((m) => m.id === id);
  if (!removed) return;
  // Re-parent children to removed member's parent
  all = all.map((m) => m.parentId === id ? { ...m, parentId: removed.parentId } : m);
  all = all.filter((m) => m.id !== id);
  write(all);
}

export function resetSalesMembers() {
  localStorage.removeItem(K);
  localStorage.removeItem(K_POS);
  localStorage.removeItem(K_COMM);
  listeners.forEach((fn) => fn());
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

export interface MemberNode {
  member: SalesMember;
  children: MemberNode[];
  depth: number;
  descendantCount: number;
}

export function buildTree(members: SalesMember[]): MemberNode[] {
  const childrenMap = new Map<string, SalesMember[]>();
  for (const m of members) {
    const pid = m.parentId || "__root__";
    const arr = childrenMap.get(pid) ?? [];
    arr.push(m);
    childrenMap.set(pid, arr);
  }

  function build(parentId: string, depth: number): MemberNode[] {
    const key = parentId || "__root__";
    const kids = childrenMap.get(key) ?? [];
    return kids
      .sort((a, b) => {
        // Directors first, then by name
        if (a.position !== b.position) {
          if (a.position === "Sales Director") return -1;
          if (b.position === "Sales Director") return 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((m) => {
        const children = build(m.id, depth + 1);
        const descendantCount = children.reduce((sum, c) => sum + 1 + c.descendantCount, 0);
        return { member: m, children, depth, descendantCount };
      });
  }

  return build("", 0);
}

export function flattenTree(nodes: MemberNode[]): MemberNode[] {
  const result: MemberNode[] = [];
  function walk(ns: MemberNode[]) {
    for (const n of ns) { result.push(n); walk(n.children); }
  }
  walk(nodes);
  return result;
}

export function getAllMemberNames(): string[] {
  return read().filter((m) => m.status === "ACTIVE").map((m) => m.name).sort();
}
