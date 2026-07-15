// ----------------------------------------------------------------------------
// assr/stages — the CANONICAL service-case (ASSR) stage pipeline + the
// resolution-routing rule. NO React, no query client, no I/O.
//
// This is the single source of truth for the 7-stage workflow and, crucially,
// for the ONE rule that used to drift between desktop and mobile: when a case
// is resolved in-house (own field service / return visit) the two
// supplier-only stages — Supplier Pickup and Item Ready — drop out of the
// pipeline entirely. Desktop enforced this via getActiveStages; mobile did
// not, so internal-resolution cases on mobile mis-routed INTO those stages and
// showed the wrong progress denominator. Both surfaces now share this file.
//
// Stage vocabulary since mig 0110 (Item Pickup retired; the customer-side
// collection lives inside the Supplier stage) / mig 0105 (Pending Inspection
// folded into Verification).
// ----------------------------------------------------------------------------

export type AssrStageKey =
  | "pending_review"
  | "under_verification"
  | "pending_solution"
  | "pending_supplier_pickup"
  | "pending_item_ready"
  | "pending_delivery_service"
  | "completed";

export interface AssrStageDef {
  /** SQL enum value. */
  key: AssrStageKey;
  /** Chip-short label. */
  short: string;
  /** Card / badge label. */
  long: string;
  /** Responsible role (drives the "next-stage owner" hint on the advance sheet). */
  owner: string;
}

export const ASSR_STAGES: AssrStageDef[] = [
  { key: "pending_review",           short: "Review",      long: "Pending Review",             owner: "Service Admin" },
  { key: "under_verification",       short: "Verify",      long: "Under Verification",         owner: "Service Admin" },
  { key: "pending_solution",         short: "Solution",    long: "Pending Solution",           owner: "Service Admin" },
  { key: "pending_supplier_pickup",  short: "Supplier",    long: "Supplier Pickup / Return",   owner: "Service Admin" },
  { key: "pending_item_ready",       short: "Item Ready",  long: "Pending Item Ready",         owner: "Service Admin" },
  { key: "pending_delivery_service", short: "Delivery",    long: "Pending Delivery / Service", owner: "Logistic Admin" },
  { key: "completed",                short: "Completed",   long: "Completed",                  owner: "System" },
];

export const ASSR_STAGE_INDEX: Record<string, number> = Object.fromEntries(
  ASSR_STAGES.map((s, i) => [s.key, i]),
);

/** The two stages that exist only when a supplier is in the loop. */
export const ASSR_SUPPLIER_ONLY_STAGES: readonly string[] = [
  "pending_supplier_pickup",
  "pending_item_ready",
];

/**
 * Which side of the flow a resolution method routes to. `internal` = own team
 * handles it end-to-end (no supplier hand-off), so the supplier-only stages
 * drop out. `null` = not decided yet (full pipeline shown).
 */
export function resolutionRoute(
  m: string | null | undefined,
): "supplier" | "internal" | null {
  if (!m) return null;
  if (m === "field_service_own" || m === "return_visit") return "internal";
  return "supplier";
}

/**
 * Is `stageKey` part of the active pipeline for a case with this resolution
 * method? The current stage is ALWAYS active as a safety net — a case parked on
 * a filtered-out stage (shouldn't happen, but ops can) still renders.
 */
export function isStageActive(
  method: string | null | undefined,
  stageKey: string,
  currentStage: string,
): boolean {
  if (stageKey === currentStage) return true;
  if (resolutionRoute(method) !== "internal") return true;
  return !ASSR_SUPPLIER_ONLY_STAGES.includes(stageKey);
}

/**
 * Filter an ordered stage table down to the pipeline that actually applies to
 * this case. Generic over any table shaped `{ <keyProp>: string }` so both the
 * desktop table (`{ id }`) and the canonical table (`{ key }`) can use it.
 */
export function filterActiveStages<T>(
  stages: readonly T[],
  method: string | null | undefined,
  currentStage: string,
  keyOf: (s: T) => string,
): T[] {
  return stages.filter((s) => isStageActive(method, keyOf(s), currentStage));
}

export interface AssrSubStatusDef {
  key: string;
  label: string;
}

/**
 * Sub-status WITHIN a stage (Nick 2026-07-15 — the workflow funnel
 * needed finer states without changing the 7-stage pipeline):
 *
 *   Verification — "Pending Inspection" until the QC issue inspection
 *     is recorded (qc_receipt_date or a qc_issue_result verdict), then
 *     "QC Issue Result" (with the verdict when one is stored).
 *   Supplier — "Pending Supplier Pickup" until the supplier collects
 *     the item (supplier_pickup_at), then "Pending Supplier Return".
 *
 * Purely derived from existing case fields — no schema; the sub-status
 * flips live as ops fills the driving field. Other stages have none.
 */
export function assrSubStatus(
  stage: string | null | undefined,
  f: {
    qcReceiptDate?: string | null;
    qcIssueResult?: string | null;
    supplierPickupAt?: string | null;
  },
): AssrSubStatusDef | null {
  if (stage === "under_verification") {
    const verdict = (f.qcIssueResult || "").trim().toLowerCase();
    const inspected = !!f.qcReceiptDate || !!verdict;
    if (!inspected) return { key: "pending_inspection", label: "Pending Inspection" };
    const pretty =
      verdict === "na" ? "N/A" : verdict ? verdict.charAt(0).toUpperCase() + verdict.slice(1) : "";
    return {
      key: "qc_issue_result",
      label: pretty ? `QC Issue Result: ${pretty}` : "QC Issue Result Recorded",
    };
  }
  if (stage === "pending_supplier_pickup") {
    return f.supplierPickupAt
      ? { key: "pending_supplier_return", label: "Pending Supplier Return" }
      : { key: "pending_supplier_pickup", label: "Pending Supplier Pickup" };
  }
  return null;
}

/** Active canonical stages for a case (the common mobile call). */
export function activeAssrStages(
  method: string | null | undefined,
  currentStage: string,
): AssrStageDef[] {
  return filterActiveStages(ASSR_STAGES, method, currentStage, (s) => s.key);
}
