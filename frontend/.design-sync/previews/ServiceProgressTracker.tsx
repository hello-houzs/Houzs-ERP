import { ServiceProgressTracker } from "autocount-sync-frontend";

// 7-node ASSR workflow stepper (Pending Inspection retired mig 0105,
// Item Pickup retired mig 0110 — the customer-side collection lives in
// the Supplier stage now). Completed = green
// check, current = pulsing circle toned by SLA burn (green/amber/red),
// skipped = dashed outline with reason tooltip. Compact variant is the
// single-line list/portal summary.

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

const hist = (
  id: number,
  stage: string,
  enteredDaysAgo: number,
  exitedDaysAgo: number | null,
  target: number,
  extra: Record<string, unknown> = {}
) => ({
  id,
  stage,
  entered_at: daysAgo(enteredDaysAgo),
  exited_at: exitedDaysAgo == null ? null : daysAgo(exitedDaysAgo),
  target_days: target,
  status: null,
  skipped: 0,
  skip_reason: null,
  alerts_fired: 0,
  snoozes_applied: 0,
  ...extra,
});

// ASSR-0231 — mid-flight, inside SLA at stage 4 (Supplier Pickup / Return).
const ON_TRACK = [
  hist(1, "pending_review", 9, 8.2, 1),
  hist(2, "under_verification", 8.2, 6.5, 2),
  hist(3, "pending_solution", 6.5, 5.1, 2),
  hist(4, "pending_supplier_pickup", 0.5, null, 2),
];

// ASSR-0207 — stage 5 breaching SLA; the supplier leg was skipped
// (replacement unit shipped direct), so the dashed node carries the
// skip reason.
const SLA_BREACH = [
  hist(11, "pending_review", 14, 13.1, 1),
  hist(12, "under_verification", 13.1, 9.8, 2),
  hist(13, "pending_solution", 9.8, 8.2, 2),
  hist(14, "pending_supplier_pickup", 8.2, 8.2, 2, {
    skipped: 1,
    skip_reason: "Replacement unit shipped direct — no supplier leg",
  }),
  hist(15, "pending_item_ready", 5.4, null, 5),
];

// ASSR-0198 — final delivery leg, amber (1.6 of 2 days used).
const NEAR_DONE = [
  hist(21, "pending_review", 20, 19.2, 1),
  hist(22, "under_verification", 19.2, 16, 2),
  hist(23, "pending_solution", 16, 14.5, 2),
  hist(24, "pending_supplier_pickup", 14.5, 8, 2),
  hist(25, "pending_item_ready", 8, 1.6, 5),
  hist(26, "pending_delivery_service", 1.6, null, 2),
];

export const OnTrack = () => (
  <div className="w-[46rem]">
    <ServiceProgressTracker currentStage={"pending_supplier_pickup" as any} history={ON_TRACK as any} />
  </div>
);

export const SlaBreachWithSkip = () => (
  <div className="w-[46rem]">
    <ServiceProgressTracker
      currentStage={"pending_item_ready" as any}
      history={SLA_BREACH as any}
    />
  </div>
);

export const JustOpened = () => (
  <div className="w-[46rem]">
    <ServiceProgressTracker currentStage={"pending_review" as any} history={[]} />
  </div>
);

export const CompactSummary = () => (
  <div className="w-96 space-y-2 rounded-lg border border-border bg-surface p-3 shadow-stone">
    <div className="font-mono text-[11px] text-ink-secondary">ASSR-0198 · Nurul Aina</div>
    <ServiceProgressTracker
      variant="compact"
      currentStage={"pending_delivery_service" as any}
      history={NEAR_DONE as any}
    />
  </div>
);
