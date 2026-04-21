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
  | "STOCKS_REQUEST_LIST"
  | "DISPLAY_FLOORPLAN"
  | "FLOORPLAN_INTERNAL"
  | "THREE_D_DESIGN"
  | "TWO_D_WITH_DISPLAY"
  | "SETUP_IMAGE_DRIVER"
  | "SETUP_IMAGE_SALES"
  | "DISMANTLE_IMAGE_DRIVER"
  | "DEFECT_LIST"
  | "EXCHANGE_LIST"
  | "EVENT_COMPLETE_IMAGE"
  | "DRIVER_RECORD"
  | "EXPO_MAP"
  | "EXPO_MAP_FILLED"
  | "PERMIT_FILE"
  | "AGREEMENT"
  | "BD_RECORD";

// Position / responsibility for each doc type
export type DocPosition = "Driver" | "Sales" | "PC";

export const BOOTH_DOC_LABELS: Record<BoothDocType, string> = {
  STOCK_TRANSFER:       "Stock Transfer Record",
  STOCKS_REQUEST_LIST:  "Stocks Request Listing",
  DISPLAY_FLOORPLAN:    "Display Floorplan",
  FLOORPLAN_INTERNAL:   "Floorplan (Internal)",
  THREE_D_DESIGN:       "3D Design",
  TWO_D_WITH_DISPLAY:   "2D Design with Display",
  SETUP_IMAGE_DRIVER:   "Setup Image",
  SETUP_IMAGE_SALES:    "Setup Image",
  DISMANTLE_IMAGE_DRIVER: "Dismantle Image",
  DEFECT_LIST:          "Defect List",
  EXCHANGE_LIST:        "Exchange List",
  EVENT_COMPLETE_IMAGE: "Event Complete Image",
  DRIVER_RECORD:        "Driver Record",
  EXPO_MAP:             "Expo Map (Blank Base Floorplan)",
  EXPO_MAP_FILLED:      "Expo Map (Filled with Competitors)",
  PERMIT_FILE:          "Permit File",
  AGREEMENT:            "Agreement / Quotation",
  BD_RECORD:            "BD Record",
};

// Short helper text explaining when/what each doc is for
export const BOOTH_DOC_HINTS: Partial<Record<BoothDocType, string>> = {
  DEFECT_LIST:          "Check after setup",
  EXCHANGE_LIST:        "After event completes",
  EVENT_COMPLETE_IMAGE: "After event completes",
  SETUP_IMAGE_DRIVER:   "Taken by driver on arrival",
  SETUP_IMAGE_SALES:    "Taken by sales at showroom",
  DISMANTLE_IMAGE_DRIVER: "Taken by driver after dismantle",
};

export const BOOTH_DOC_POSITION: Record<BoothDocType, DocPosition> = {
  STOCK_TRANSFER:       "Sales",
  STOCKS_REQUEST_LIST:  "Sales",
  DISPLAY_FLOORPLAN:    "PC",
  FLOORPLAN_INTERNAL:   "PC",
  THREE_D_DESIGN:       "PC",
  TWO_D_WITH_DISPLAY:   "PC",
  SETUP_IMAGE_DRIVER:   "Driver",
  SETUP_IMAGE_SALES:    "Sales",
  DISMANTLE_IMAGE_DRIVER: "Driver",
  DEFECT_LIST:          "Sales",
  EXCHANGE_LIST:        "Sales",
  EVENT_COMPLETE_IMAGE: "Sales",
  DRIVER_RECORD:        "Driver",
  EXPO_MAP:             "PC",
  EXPO_MAP_FILLED:      "Sales",
  PERMIT_FILE:          "PC",
  AGREEMENT:            "PC",
  BD_RECORD:            "PC",
};

// Grouped for separate UI sections.
// NOTE: Agreement, Permits, Floorplan, 3D are already tracked (with file
// attachments via workflow-attachment-dialog) under PM Workflow — we don't
// duplicate them here.
export const PREPARATION_DOCS: BoothDocType[] = [];

export const BOOTH_LAYOUT_DOCS: BoothDocType[] = [
  "STOCKS_REQUEST_LIST",
  "STOCK_TRANSFER",
  "THREE_D_DESIGN",
  "TWO_D_WITH_DISPLAY",
];

export const SETUP_DISMANTLE_DOCS: BoothDocType[] = [
  "SETUP_IMAGE_DRIVER",
  "SETUP_IMAGE_SALES",
  "DEFECT_LIST",
  "EXCHANGE_LIST",
  "EVENT_COMPLETE_IMAGE",
  "DISMANTLE_IMAGE_DRIVER",
];

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

// A single structured text-with-photo entry within a doc (for Defect List,
// Exchange List — where each row needs a description + optional photos)
export interface BoothDocItem {
  id: string;
  text: string;                 // description (e.g. "Leg scratched", "Wrong colour")
  photoKey?: string;            // photos-store workflowKey scoped to this item
  createdAt: string;
  createdById: string;
  createdByName: string;
}

// Doc content mode — determines what the modal renders
export type DocContentMode = "IMAGE_ONLY" | "IMAGE_TEXT";

export const BOOTH_DOC_CONTENT: Record<BoothDocType, DocContentMode> = {
  STOCK_TRANSFER:       "IMAGE_TEXT",
  STOCKS_REQUEST_LIST:  "IMAGE_TEXT",
  DISPLAY_FLOORPLAN:    "IMAGE_ONLY",
  FLOORPLAN_INTERNAL:   "IMAGE_ONLY",
  THREE_D_DESIGN:       "IMAGE_ONLY",
  TWO_D_WITH_DISPLAY:   "IMAGE_ONLY",
  SETUP_IMAGE_DRIVER:   "IMAGE_ONLY",
  SETUP_IMAGE_SALES:    "IMAGE_ONLY",
  DISMANTLE_IMAGE_DRIVER: "IMAGE_ONLY",
  DEFECT_LIST:          "IMAGE_TEXT",
  EXCHANGE_LIST:        "IMAGE_TEXT",
  EVENT_COMPLETE_IMAGE: "IMAGE_ONLY",
  DRIVER_RECORD:        "IMAGE_ONLY",
  EXPO_MAP:             "IMAGE_ONLY",
  EXPO_MAP_FILLED:      "IMAGE_ONLY",
  PERMIT_FILE:          "IMAGE_ONLY",
  AGREEMENT:            "IMAGE_ONLY",
  BD_RECORD:            "IMAGE_TEXT",
};

export interface BoothDoc {
  id: string;
  eventA42: string;
  type: BoothDocType;
  remarks?: string;         // free text (e.g. booth no "B34")
  fileIds: string[];        // refs to photos-store entries
  items?: BoothDocItem[];   // structured rows (for IMAGE_TEXT docs)
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

/** Reactive list of ALL booth docs across all events (for dashboards). */
export function useAllBoothDocs(): BoothDoc[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
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
