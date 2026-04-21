// Booth document store — typed per-event document records for layout, setup,
// and dismantle phases. Each doc type has an approval workflow.
//
// Pattern: localStorage + useSyncExternalStore (mirrors events-store.ts)
// Photos stored separately via photos-store with workflowKey = `booth:${docId}`

import { useSyncExternalStore } from "react";

const KEY = "houzs-booth-docs-v1";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BoothDocType =
  | "STOCK_TRANSFER"
  | "DISPLAY_FLOORPLAN"
  | "FLOORPLAN_INTERNAL"
  | "THREE_D_DESIGN"
  | "TWO_D_WITH_DISPLAY"
  | "SETUP_IMAGE_DRIVER"
  | "SETUP_IMAGE_SALES"
  | "DEFECT_ITEM"
  | "DRIVER_RECORD"
  | "EXPO_MAP"
  | "EXPO_MAP_FILLED"
  | "PERMIT_FILE"
  | "AGREEMENT"
  | "BD_RECORD";

export const BOOTH_DOC_LABELS: Record<BoothDocType, string> = {
  STOCK_TRANSFER:      "Stock Transfer Record",
  DISPLAY_FLOORPLAN:   "Display Floorplan",
  FLOORPLAN_INTERNAL:  "Floorplan (Internal)",
  THREE_D_DESIGN:      "3D Design",
  TWO_D_WITH_DISPLAY:  "2D Design with Display",
  SETUP_IMAGE_DRIVER:  "Setup Image — Driver",
  SETUP_IMAGE_SALES:   "Setup Image — Sales",
  DEFECT_ITEM:         "Defect Item",
  DRIVER_RECORD:       "Driver Record",
  EXPO_MAP:            "Expo Map (Blank Base Floorplan)",
  EXPO_MAP_FILLED:     "Expo Map (Filled with Competitors)",
  PERMIT_FILE:         "Permit File",
  AGREEMENT:           "Agreement / Quotation",
  BD_RECORD:           "BD Record",
};

// Grouped for separate UI sections
export const PREPARATION_DOCS: BoothDocType[] = [
  "AGREEMENT",
  "PERMIT_FILE",
  "BD_RECORD",
];

export const BOOTH_LAYOUT_DOCS: BoothDocType[] = [
  "STOCK_TRANSFER",
  "DISPLAY_FLOORPLAN",
  "FLOORPLAN_INTERNAL",
  "THREE_D_DESIGN",
  "TWO_D_WITH_DISPLAY",
];

export const SETUP_DISMANTLE_DOCS: BoothDocType[] = [
  "SETUP_IMAGE_DRIVER",
  "SETUP_IMAGE_SALES",
  "DEFECT_ITEM",
  "DRIVER_RECORD",
];

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface BoothDoc {
  id: string;
  eventA42: string;
  type: BoothDocType;
  remarks?: string;         // free text (e.g. booth no "B34")
  fileIds: string[];        // refs to photos-store entries
  uploadedById: string;
  uploadedByName: string;
  uploadedAt: string;       // ISO timestamp
  approvalStatus: ApprovalStatus;
  approvedById?: string;
  approvedByName?: string;
  approvedAt?: string;
  approvalNotes?: string;
}

// ─── Internal store machinery ─────────────────────────────────────────────────

const listeners = new Set<() => void>();
let cached: BoothDoc[] | null = null;

function emit() {
  cached = null;
  listeners.forEach((l) => l());
}

function safeParse(raw: string | null): BoothDoc[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as BoothDoc[]; } catch { return []; }
}

function readAll(): BoothDoc[] {
  if (typeof window === "undefined") return [];
  return safeParse(localStorage.getItem(KEY));
}

function writeAll(docs: BoothDoc[]) {
  localStorage.setItem(KEY, JSON.stringify(docs));
  emit();
}

function getSnapshot(): BoothDoc[] {
  if (!cached) cached = readAll();
  return cached;
}

function getServerSnapshot(): BoothDoc[] {
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

/** Reactive hook — returns docs for a specific event. */
export function useBoothDocs(eventA42: string): BoothDoc[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return all.filter((d) => d.eventA42 === eventA42);
}

export function createBoothDoc(
  eventA42: string,
  type: BoothDocType,
  uploadedById: string,
  uploadedByName: string,
  remarks?: string,
): BoothDoc {
  const doc: BoothDoc = {
    id: crypto.randomUUID(),
    eventA42,
    type,
    remarks,
    fileIds: [],
    uploadedById,
    uploadedByName,
    uploadedAt: new Date().toISOString(),
    approvalStatus: "PENDING",
  };
  const all = readAll();
  all.push(doc);
  writeAll(all);
  return doc;
}

export function updateBoothDoc(id: string, patch: Partial<BoothDoc>): void {
  const all = readAll();
  const idx = all.findIndex((d) => d.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  writeAll(all);
}

export function deleteBoothDoc(id: string): void {
  const all = readAll().filter((d) => d.id !== id);
  writeAll(all);
}

export function setApproval(
  id: string,
  status: ApprovalStatus,
  approverId: string,
  approverName: string,
  notes?: string,
): void {
  const all = readAll();
  const idx = all.findIndex((d) => d.id === id);
  if (idx < 0) return;
  all[idx] = {
    ...all[idx],
    approvalStatus: status,
    approvedById: approverId,
    approvedByName: approverName,
    approvedAt: new Date().toISOString(),
    approvalNotes: notes,
  };
  writeAll(all);
}
