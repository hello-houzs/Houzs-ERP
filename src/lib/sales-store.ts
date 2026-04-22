// Sales team store — D1-backed via /api/users + /api/settings, with an
// in-memory + localStorage cache for instant paint. Pattern mirrors
// events-store.ts / so-store.ts.
//
// Public surface is unchanged so existing consumers (SalesPage,
// EventDetailPage, event-chat) don't have to change:
//
//   useSalesMembers() → SalesMember[]        — reactive hook
//   addMember(m)      → Promise<string>      — POST /api/users
//   updateMember(id, patch) → Promise<void>  — PATCH /api/users/:id
//   removeMember(id)        → Promise<void>  — DELETE /api/users/:id
//   readPositions() → string[]               — sync cache read
//   writePositions(list)    → Promise<void>  — PUT /api/settings/positions
//   readDefaultCommission() → CommissionTier[]
//   writeDefaultCommission(tiers) → Promise<void>
//   resetSalesMembers()     → force refetch
//   getAllMemberNames()     → string[]
//
// Pure helpers (buildTree, flattenTree, calc*) are unchanged.

import { useSyncExternalStore } from "react";
import type { Brand } from "./mock-data";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemberStatus = "ACTIVE" | "INACTIVE";

export interface CommissionTier {
  threshold: number;
  pct: number;
}

export interface SalesMember {
  id: string;
  name: string;
  code: string;
  phone: string;
  email: string;
  ic?: string;
  position: string;
  parentId: string;
  additionalParentIds?: string[];
  joinDate: string;
  status: MemberStatus;
  assignedBrands: Brand[];
  commissionTiers: CommissionTier[];
  minRate: number;
  notes?: string;
}

// ─── Defaults (used as fallback until /api/settings responds) ────────────────

export const DEFAULT_POSITIONS = [
  "Sales Director",
  "Sales Manager",
  "Sales Executive",
  "Sales Trainee",
];

export const DEFAULT_COMMISSION: CommissionTier[] = [
  { threshold: 0,      pct: 5 },
  { threshold: 300000, pct: 6 },
  { threshold: 500000, pct: 7 },
];

// ─── Cache + subscribe ───────────────────────────────────────────────────────

const MEMBERS_KEY    = "houzs-sales-members-cache-v1";
const POSITIONS_KEY  = "houzs-sales-positions-cache-v1";
const COMMISSION_KEY = "houzs-sales-default-commission-cache-v1";

const listeners = new Set<() => void>();
let membersCache: SalesMember[] | null = null;
let positionsCache: string[] | null = null;
let commissionCache: CommissionTier[] | null = null;
let bootstrapped = false;
let fetchingMembers = false;
let fetchingSettings = false;

function emit() { listeners.forEach((l) => l()); }

function readLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function writeLS(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

// ─── Wire → domain mapping ───────────────────────────────────────────────────
// /api/users returns a row with extras (hasPassword, lastLogin, etc.) — we
// project down to SalesMember. Missing / null fields get sensible defaults.

interface ApiUserRow {
  id: string;
  name: string;
  code: string;
  phone: string;
  email: string;
  position: string;
  parentId: string;
  additionalParentIds?: string[];
  joinDate: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING";
  assignedBrands: string[];
  commissionTiers: { threshold: number; pct: number }[];
  minRate: number;
  notes?: string | null;
}

function rowToMember(r: ApiUserRow): SalesMember {
  return {
    id: r.id,
    name: r.name,
    code: r.code ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    position: r.position ?? "Sales Executive",
    parentId: r.parentId ?? "",
    additionalParentIds: r.additionalParentIds ?? [],
    joinDate: r.joinDate ?? "",
    status: (r.status === "INACTIVE" ? "INACTIVE" : "ACTIVE"),
    assignedBrands: (r.assignedBrands ?? []) as Brand[],
    commissionTiers: r.commissionTiers ?? [],
    minRate: Number(r.minRate ?? 0),
    notes: r.notes ?? undefined,
  };
}

// ─── API fetchers ────────────────────────────────────────────────────────────

async function fetchMembersFromApi(): Promise<void> {
  if (fetchingMembers) return;
  fetchingMembers = true;
  try {
    const r = await fetch("/api/users", { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
    const rows = (await r.json()) as ApiUserRow[];
    const members = rows.map(rowToMember);
    membersCache = members;
    writeLS(MEMBERS_KEY, members);
    emit();
  } catch (e) {
    console.warn("[sales-store] members fetch failed, keeping cache:", e);
  } finally {
    fetchingMembers = false;
  }
}

async function fetchSettingsFromApi(): Promise<void> {
  if (fetchingSettings) return;
  fetchingSettings = true;
  try {
    const r = await fetch("/api/settings", { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as Record<string, unknown>;
    if (Array.isArray(data.positions)) {
      positionsCache = data.positions as string[];
      writeLS(POSITIONS_KEY, positionsCache);
    }
    if (Array.isArray(data.default_commission)) {
      commissionCache = data.default_commission as CommissionTier[];
      writeLS(COMMISSION_KEY, commissionCache);
    }
    emit();
  } catch (e) {
    console.warn("[sales-store] settings fetch failed, keeping cache:", e);
  } finally {
    fetchingSettings = false;
  }
}

function bootstrap() {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;
  // Prime from localStorage synchronously so first render has data
  if (!membersCache)    membersCache    = readLS<SalesMember[]>(MEMBERS_KEY, []);
  if (!positionsCache)  positionsCache  = readLS<string[]>(POSITIONS_KEY, DEFAULT_POSITIONS);
  if (!commissionCache) commissionCache = readLS<CommissionTier[]>(COMMISSION_KEY, DEFAULT_COMMISSION);
  // Then fetch the real data
  fetchMembersFromApi();
  fetchSettingsFromApi();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === MEMBERS_KEY)    { membersCache = null; cb(); }
    if (e.key === POSITIONS_KEY)  { positionsCache = null; cb(); }
    if (e.key === COMMISSION_KEY) { commissionCache = null; cb(); }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function getMembersSnapshot(): SalesMember[] {
  if (!membersCache) membersCache = readLS<SalesMember[]>(MEMBERS_KEY, []);
  return membersCache;
}

function getServerSnapshot(): SalesMember[] { return []; }

// ─── Positions (sync reads, async writes) ────────────────────────────────────

export function readPositions(): string[] {
  if (typeof window === "undefined") return DEFAULT_POSITIONS;
  if (!positionsCache) positionsCache = readLS<string[]>(POSITIONS_KEY, DEFAULT_POSITIONS);
  return positionsCache;
}

export async function writePositions(positions: string[]): Promise<void> {
  positionsCache = positions;
  writeLS(POSITIONS_KEY, positions);
  emit();
  try {
    await fetch("/api/settings/positions", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(positions),
    });
  } catch (err) {
    console.warn("[sales-store] writePositions API failed:", err);
  }
}

export function readDefaultCommission(): CommissionTier[] {
  if (typeof window === "undefined") return DEFAULT_COMMISSION;
  if (!commissionCache) commissionCache = readLS<CommissionTier[]>(COMMISSION_KEY, DEFAULT_COMMISSION);
  return commissionCache;
}

export async function writeDefaultCommission(tiers: CommissionTier[]): Promise<void> {
  commissionCache = tiers;
  writeLS(COMMISSION_KEY, tiers);
  emit();
  try {
    await fetch("/api/settings/default_commission", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tiers),
    });
  } catch (err) {
    console.warn("[sales-store] writeDefaultCommission API failed:", err);
  }
}

// ─── Commission math (pure) ──────────────────────────────────────────────────

export function findCommissionRate(sales: number, tiers: CommissionTier[], minRate: number = 0): number {
  const effective = tiers.length > 0 ? tiers : readDefaultCommission();
  const sorted = [...effective].sort((a, b) => b.threshold - a.threshold);
  for (const t of sorted) {
    if (sales >= t.threshold) return Math.max(t.pct, minRate);
  }
  return minRate;
}

export function calcCommission(sales: number, tiers: CommissionTier[]): number {
  return sales * (findCommissionRate(sales, tiers) / 100);
}

export function calcTeamSales(
  memberId: string,
  personalSalesMap: Map<string, number>,
  members: SalesMember[],
): number {
  const personal = personalSalesMap.get(memberId) ?? 0;
  const children = members.filter((m) => m.parentId === memberId);
  return children.reduce(
    (sum, c) => sum + calcTeamSales(c.id, personalSalesMap, members),
    personal,
  );
}

export interface CommissionBreakdown {
  teamTotal: number;
  rate: number;
  gross: number;
  cost: number;
  net: number;
}

export function calcCommissionBreakdown(
  memberId: string,
  personalSalesMap: Map<string, number>,
  members: SalesMember[],
): CommissionBreakdown {
  const member = members.find((m) => m.id === memberId);
  const teamTotal = calcTeamSales(memberId, personalSalesMap, members);
  const tiers = member?.commissionTiers ?? [];
  const memberMinRate = member?.minRate ?? 0;
  const rate = findCommissionRate(teamTotal, tiers, memberMinRate);
  const gross = teamTotal * (rate / 100);

  const directChildren = members.filter((m) => m.parentId === memberId);
  const cost = directChildren.reduce((sum, child) => {
    const childBreakdown = calcCommissionBreakdown(child.id, personalSalesMap, members);
    return sum + childBreakdown.gross;
  }, 0);

  return { teamTotal, rate, gross, cost, net: gross - cost };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSalesMembers(): SalesMember[] {
  if (typeof window !== "undefined") bootstrap();
  return useSyncExternalStore(subscribe, getMembersSnapshot, getServerSnapshot);
}

// ─── Mutations (optimistic cache + API) ──────────────────────────────────────

/** Create a new user in D1. Fires an invite email by default; pass
 *  sendInvite=false for "register now, invite later" flows. Returns the
 *  new user's id. */
export async function addMember(
  m: Omit<SalesMember, "id">,
  opts: { sendInvite?: boolean } = {},
): Promise<string> {
  const r = await fetch("/api/users", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: m.name,
      code: m.code,
      email: m.email,
      phone: m.phone,
      ic: m.ic,
      department: "SALES",
      position: m.position,
      parentId: m.parentId,
      additionalParentIds: m.additionalParentIds ?? [],
      assignedBrands: m.assignedBrands,
      commissionTiers: m.commissionTiers,
      minRate: m.minRate,
      joinDate: m.joinDate,
      sendInvite: opts.sendInvite ?? true,
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `POST /api/users failed (${r.status})`);
  }
  const data = (await r.json()) as { id: string };
  await fetchMembersFromApi();
  return data.id;
}

export async function updateMember(id: string, patch: Partial<SalesMember>): Promise<void> {
  // Optimistic cache write
  if (!membersCache) membersCache = readLS<SalesMember[]>(MEMBERS_KEY, []);
  const idx = membersCache.findIndex((m) => m.id === id);
  if (idx >= 0) {
    const next = [...membersCache];
    next[idx] = { ...next[idx], ...patch };
    membersCache = next;
    writeLS(MEMBERS_KEY, next);
    emit();
  }
  try {
    const r = await fetch(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(String(r.status));
  } catch (err) {
    console.warn("[sales-store] updateMember API failed:", err);
    // Re-fetch to reconcile
    fetchMembersFromApi();
  }
}

export async function removeMember(id: string): Promise<void> {
  // Optimistic: remove + reparent children to the deleted member's parent,
  // mirroring the server-side behavior.
  if (!membersCache) membersCache = readLS<SalesMember[]>(MEMBERS_KEY, []);
  const removed = membersCache.find((m) => m.id === id);
  if (!removed) return;
  let next = membersCache.map((m) => m.parentId === id ? { ...m, parentId: removed.parentId } : m);
  next = next.filter((m) => m.id !== id);
  membersCache = next;
  writeLS(MEMBERS_KEY, next);
  emit();

  try {
    const r = await fetch(`/api/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!r.ok) throw new Error(String(r.status));
  } catch (err) {
    console.warn("[sales-store] removeMember API failed:", err);
    fetchMembersFromApi();
  }
}

export async function resetSalesMembers(): Promise<void> {
  membersCache = null;
  positionsCache = null;
  commissionCache = null;
  if (typeof window !== "undefined") {
    localStorage.removeItem(MEMBERS_KEY);
    localStorage.removeItem(POSITIONS_KEY);
    localStorage.removeItem(COMMISSION_KEY);
  }
  emit();
  await Promise.all([fetchMembersFromApi(), fetchSettingsFromApi()]);
}

/** Force a refetch of members + settings. Used after external mutations
 *  (e.g. the Sales Team register modal that calls usersApi.invite directly). */
export async function refreshMembers(): Promise<void> {
  await Promise.all([fetchMembersFromApi(), fetchSettingsFromApi()]);
}

// ─── Tree helpers (pure) ─────────────────────────────────────────────────────

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
  const cache = membersCache ?? readLS<SalesMember[]>(MEMBERS_KEY, []);
  return cache.filter((m) => m.status === "ACTIVE").map((m) => m.name).sort();
}
