// Project-detail (PMS) section-level access — port of the reference repo's
// src/lib/pms-access.ts, adapted to the production AuthUser + projects model.
//
// This layers ON TOP of two existing gates:
//   1. the page matrix (projects.list) — can you open the project area at all
//   2. getProjectScope() (projectAcl.ts) — PIC + brand row filter on WHICH
//      projects you can see
// pmsAccess then decides WHICH SECTIONS of a project's detail page render, and
// crucially hides the financial snapshot + rental amount from everyone except
// directors/finance. See docs/PERMISSION-MATRIX.md (PMS section table).
//
// PIC is a PER-PROJECT assignment (projects.pic_id === user.id), NOT a job
// title — a sales person is "PIC" only on the projects they're assigned to.

import type { AuthUser } from "./auth";

export type PmsRole =
  | "DIRECTOR" // owner/IT (*), Super Admin, Sales Director, Finance — full incl. financials
  | "PIC" // sales person who is this project's PIC — most of it, no financials
  | "SALES" // sales person who can see it but isn't the PIC
  | "PURCHASING"
  | "LOGISTIC"
  | "DRIVER" // Driver / Helper — use the driver portal, not this page
  | "OTHER" // Ops / HQ non-admin — view-only, no financials
  | "NONE";

export type PmsSection =
  | "EDIT"
  | "FINANCIAL" // sales / cost / profit snapshot
  | "RENTAL" // rental amount
  | "PROJECT_STAGE"
  | "PM_WORKFLOW"
  | "WF_SENSITIVE" // agreement/quotation + security deposit
  | "BOOTH_LAYOUT"
  | "SETUP_DISMANTLE"
  | "EXPO_MAP"
  | "EVENT_CHAT"
  | "INTEGRATIONS"
  | "ACTIONS"; // delete project

const SECTIONS_BY_ROLE: Record<PmsRole, PmsSection[]> = {
  DIRECTOR: [
    "EDIT", "FINANCIAL", "RENTAL", "PROJECT_STAGE", "PM_WORKFLOW", "WF_SENSITIVE",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT", "INTEGRATIONS", "ACTIONS",
  ],
  PIC: [
    "EDIT", "PROJECT_STAGE", "PM_WORKFLOW",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT", "INTEGRATIONS",
  ],
  LOGISTIC: [
    "EDIT", "PROJECT_STAGE", "PM_WORKFLOW",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "INTEGRATIONS",
  ],
  SALES: ["SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT"],
  PURCHASING: ["BOOTH_LAYOUT", "SETUP_DISMANTLE"],
  DRIVER: ["BOOTH_LAYOUT", "SETUP_DISMANTLE", "PM_WORKFLOW"],
  OTHER: [
    "PROJECT_STAGE", "PM_WORKFLOW",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT", "INTEGRATIONS",
  ],
  NONE: [],
};

// Directors / finance — the only roles that see money on the project.
const DIRECTOR_POSITIONS = /^(Super Admin|Sales Director|Finance Manager)$/i;

export interface ProjectLike {
  pic_id: number | null;
  created_by?: number | null;
}

export function getPmsRole(user: AuthUser | null | undefined, project: ProjectLike): PmsRole {
  if (!user) return "NONE";
  const pos = (user.position_name ?? "").trim();

  // Wildcard (Owner / IT Admin) or a director/finance position → full.
  if (user.permissions_set?.has("*") || DIRECTOR_POSITIONS.test(pos)) return "DIRECTOR";

  if (/^(Driver|Helper)$/i.test(pos)) return "DRIVER";
  if (/^Purchasing$/i.test(pos)) return "PURCHASING";
  if (/^Logistics?$/i.test(pos)) return "LOGISTIC";

  // Sales staff are assignment-gated: PIC of this project vs merely able to see it.
  if (/^Sales /i.test(pos)) {
    if (project.pic_id != null && project.pic_id === user.id) return "PIC";
    return "SALES";
  }

  // Ops / HQ non-admin who can open the project → view-only, no financials.
  return "OTHER";
}

export interface PmsAccess {
  role: PmsRole;
  canOpen: boolean;
  canEdit: boolean;
  canFinancial: boolean;
  canRental: boolean;
  sections: PmsSection[];
}

export function getPmsAccess(user: AuthUser | null | undefined, project: ProjectLike): PmsAccess {
  const role = getPmsRole(user, project);
  const sections = SECTIONS_BY_ROLE[role];
  return {
    role,
    canOpen: role !== "NONE",
    canEdit: sections.includes("EDIT"),
    canFinancial: sections.includes("FINANCIAL"),
    canRental: sections.includes("RENTAL"),
    sections,
  };
}
