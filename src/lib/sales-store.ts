"use client";

// Sales team member store — localStorage-backed with subscriber pattern.
// Supports tree hierarchy (PIC → Leader → Member) for org chart.

import { useSyncExternalStore } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemberRole = "PIC" | "LEADER" | "MEMBER";
export type MemberStatus = "ACTIVE" | "INACTIVE";

export interface SalesMember {
  id: string;            // uuid
  name: string;          // display name (uppercase)
  phone: string;
  ic?: string;           // IC number (optional, for registration)
  role: MemberRole;
  parentId: string;      // "" = root (no parent / top-level PIC)
  joinDate: string;      // ISO yyyy-mm-dd
  status: MemberStatus;
  notes?: string;
}

// ─── Seed data ───────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const PIC_KL   = "pic-kl-chen";
const PIC_KING = "pic-kingsley";
const PIC_PET  = "pic-peter";
const PIC_VIN  = "pic-vincent";

const seedMembers: SalesMember[] = [
  // Top-level PICs (no parent)
  { id: PIC_KL,   name: "KL CHEN",   phone: "012-345 6789", role: "PIC",    parentId: "", joinDate: "2024-01-01", status: "ACTIVE" },
  { id: PIC_KING, name: "KINGSLEY",   phone: "012-456 7890", role: "PIC",    parentId: "", joinDate: "2024-01-01", status: "ACTIVE" },
  { id: PIC_PET,  name: "PETER",      phone: "012-567 8901", role: "PIC",    parentId: "", joinDate: "2024-01-01", status: "ACTIVE" },
  { id: PIC_VIN,  name: "VINCENT",    phone: "012-678 9012", role: "PIC",    parentId: "", joinDate: "2024-06-01", status: "ACTIVE" },

  // Leaders under KL CHEN
  { id: "ldr-ah-wei",   name: "AH WEI",   phone: "013-111 2222", role: "LEADER", parentId: PIC_KL,   joinDate: "2024-03-01", status: "ACTIVE" },
  { id: "ldr-mei-ling", name: "MEI LING",  phone: "013-222 3333", role: "LEADER", parentId: PIC_KL,   joinDate: "2024-04-01", status: "ACTIVE" },

  // Members under AH WEI
  { id: "mbr-ali",      name: "ALI",       phone: "014-111 0001", role: "MEMBER", parentId: "ldr-ah-wei",   joinDate: "2024-06-01", status: "ACTIVE" },
  { id: "mbr-siti",     name: "SITI",      phone: "014-111 0002", role: "MEMBER", parentId: "ldr-ah-wei",   joinDate: "2024-07-01", status: "ACTIVE" },

  // Members under MEI LING
  { id: "mbr-raju",     name: "RAJU",      phone: "014-222 0001", role: "MEMBER", parentId: "ldr-mei-ling", joinDate: "2024-08-01", status: "ACTIVE" },

  // Leaders under KINGSLEY
  { id: "ldr-jason",    name: "JASON",     phone: "013-333 4444", role: "LEADER", parentId: PIC_KING, joinDate: "2024-03-15", status: "ACTIVE" },

  // Members under JASON
  { id: "mbr-kumar",    name: "KUMAR",     phone: "014-333 0001", role: "MEMBER", parentId: "ldr-jason",    joinDate: "2024-09-01", status: "ACTIVE" },
  { id: "mbr-lina",     name: "LINA",      phone: "014-333 0002", role: "MEMBER", parentId: "ldr-jason",    joinDate: "2024-10-01", status: "INACTIVE" },

  // Leader under PETER
  { id: "ldr-david",    name: "DAVID",     phone: "013-444 5555", role: "LEADER", parentId: PIC_PET,  joinDate: "2024-05-01", status: "ACTIVE" },

  // Member under VINCENT (flat — no leader yet)
  { id: "mbr-farah",    name: "FARAH",     phone: "014-555 0001", role: "MEMBER", parentId: PIC_VIN,  joinDate: "2024-09-01", status: "ACTIVE" },
];

// ─── localStorage persistence ────────────────────────────────────────────────

const K = "houzs_sales_members";
let listeners: (() => void)[] = [];

function read(): SalesMember[] {
  if (typeof window === "undefined") return seedMembers;
  const raw = localStorage.getItem(K);
  if (!raw) {
    localStorage.setItem(K, JSON.stringify(seedMembers));
    return seedMembers;
  }
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

function getSnapshot(): SalesMember[] {
  return read();
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
  // Re-parent children to the removed member's parent
  const removed = all.find((m) => m.id === id);
  if (!removed) return;
  all = all.map((m) =>
    m.parentId === id ? { ...m, parentId: removed.parentId } : m
  );
  all = all.filter((m) => m.id !== id);
  write(all);
}

export function resetSalesMembers() {
  write([...seedMembers]);
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

export interface MemberNode {
  member: SalesMember;
  children: MemberNode[];
  depth: number;
  descendantCount: number;  // total people under this node
}

/** Build tree from flat list. Returns root nodes (parentId === ""). */
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
        // PIC first, then LEADER, then MEMBER
        const rank = { PIC: 0, LEADER: 1, MEMBER: 2 };
        return (rank[a.role] - rank[b.role]) || a.name.localeCompare(b.name);
      })
      .map((m) => {
        const children = build(m.id, depth + 1);
        const descendantCount = children.reduce(
          (sum, c) => sum + 1 + c.descendantCount, 0
        );
        return { member: m, children, depth, descendantCount };
      });
  }

  return build("", 0);
}

/** Flatten tree into indented list (for table/list rendering). */
export function flattenTree(nodes: MemberNode[]): MemberNode[] {
  const result: MemberNode[] = [];
  function walk(ns: MemberNode[]) {
    for (const n of ns) {
      result.push(n);
      walk(n.children);
    }
  }
  walk(nodes);
  return result;
}

/** Get all member names (for Combo dropdowns in other pages). */
export function getAllMemberNames(): string[] {
  return read()
    .filter((m) => m.status === "ACTIVE")
    .map((m) => m.name)
    .sort();
}
