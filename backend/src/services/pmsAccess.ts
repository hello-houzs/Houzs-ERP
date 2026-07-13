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
  | "PAYMENT" // payment status / proof
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
    "EDIT", "FINANCIAL", "RENTAL", "PAYMENT", "PROJECT_STAGE", "PM_WORKFLOW", "WF_SENSITIVE",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT", "INTEGRATIONS", "ACTIONS",
  ],
  // Sales PIC: OPEN + VIEW the project, but read-only on the project itself
  // (no broad EDIT). They may still tick/attach the checklist/document items
  // badged for their own function — that runs through the per-item
  // required_perm / role_label gate, not this project-wide EDIT flag. Owner
  // rule 2026-07 (Sales-department visibility): finance / payment / rental /
  // quotation / agreement stay hidden (none of those sections listed here).
  PIC: [
    "PROJECT_STAGE", "PM_WORKFLOW",
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
  /** Payment status / proof (mig 090 rental-payment pill). */
  canPayment: boolean;
  /** Agreement / quotation / security deposit (WF_SENSITIVE). */
  canSensitive: boolean;
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
    canPayment: sections.includes("PAYMENT"),
    canSensitive: sections.includes("WF_SENSITIVE"),
    sections,
  };
}

/**
 * Project-independent "may this user see money at all?" gate, for the
 * finance ledger / payment / analytics / print endpoints that aren't tied
 * to one project's PIC. True only for DIRECTOR-level positions (Owner/IT
 * `*`, Super Admin, Sales Director, Finance Manager). This is the single
 * source of truth the routes and the /me finance-viewer flag both call.
 */
export function isFinanceViewer(user: AuthUser | null | undefined): boolean {
  return getPmsRole(user, { pic_id: null }) === "DIRECTOR";
}

/**
 * True when finance / payment must be WITHHELD from this user on the wire.
 * Mirrors the detail-GET rule: enforced only once the user has a position
 * assigned (un-migrated users keep legacy access so the rollout doesn't
 * suddenly lock out current finance/director users before positions are
 * seeded), and true for everyone whose role isn't DIRECTOR.
 */
export function financeHiddenForUser(user: AuthUser | null | undefined): boolean {
  if (!user || user.position_id == null) return false;
  return !isFinanceViewer(user);
}
