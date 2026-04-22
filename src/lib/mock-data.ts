// Houzs Century — real domain mock data
// Source: EVENT SCHEDULE tab of Exhibition & Solo Analysis spreadsheet
// Schema mirrors the 32-column sheet verbatim

// ---------- Driver entity ----------
export interface EventDriver {
  id: string;    // uid
  name: string;  // e.g. "MURU"
  phone: string; // e.g. "018-257 7543"
}

export type Brand = "AKEMI" | "ZANOTTI" | "ERGOTEX" | "DUNLOPILLO" | "HOUZS" | "OTHER";
export type EventType = "SOLO" | "EXHIBITION";
export type EventStatus = "CONFIRMED" | "PENDING" | "CANCELLED";
export type EventProgress = "NOT STARTED" | "IN PROGRESS" | "COMPLETED";

// Preparation pipeline — chronological status of pre-event readiness.
// Ordered by workflow sequence; the last applicable step is the current status.
export type PreparationCondition =
  | "PENDING FLOORPLAN"
  | "PENDING 3D"
  | "PENDING STOCKS REQUEST LISTING"
  | "PENDING STOCKS TRANSFER LISTING"
  | "PENDING DRIVER INFORMATION"
  | "PENDING SETUP IMAGE"
  | "PENDING FILLED FLOORPLAN"    // exhibition events only
  | "PENDING EVENT COMPLETE IMAGE"
  | "DONE PREPARED";

export const PREPARATION_CONDITIONS: PreparationCondition[] = [
  "PENDING FLOORPLAN",
  "PENDING 3D",
  "PENDING STOCKS REQUEST LISTING",
  "PENDING STOCKS TRANSFER LISTING",
  "PENDING DRIVER INFORMATION",
  "PENDING SETUP IMAGE",
  "PENDING FILLED FLOORPLAN",
  "PENDING EVENT COMPLETE IMAGE",
  "DONE PREPARED",
];

// Default deadline (days from event START date; negative = before, positive = after)
// for each preparation step. Used to flag overdue steps.
export const PREPARATION_DEADLINES: Record<PreparationCondition, number> = {
  "PENDING FLOORPLAN":               -21,
  "PENDING 3D":                      -14,
  "PENDING STOCKS REQUEST LISTING":  -10,
  "PENDING STOCKS TRANSFER LISTING": -7,
  "PENDING DRIVER INFORMATION":      -3,
  "PENDING SETUP IMAGE":             0,
  "PENDING FILLED FLOORPLAN":        3,  // exhibition only
  "PENDING EVENT COMPLETE IMAGE":    7,  // after event end
  "DONE PREPARED":                   7,
};

// Short display labels for timeline
export const PREPARATION_SHORT_LABELS: Record<PreparationCondition, string> = {
  "PENDING FLOORPLAN":               "Floorplan",
  "PENDING 3D":                      "3D",
  "PENDING STOCKS REQUEST LISTING":  "Stocks Request",
  "PENDING STOCKS TRANSFER LISTING": "Stocks Transfer",
  "PENDING DRIVER INFORMATION":      "Driver Info",
  "PENDING SETUP IMAGE":             "Setup Image",
  "PENDING FILLED FLOORPLAN":        "Filled Floorplan",
  "PENDING EVENT COMPLETE IMAGE":    "Event Complete",
  "DONE PREPARED":                   "Done",
};
export type MalaysianState =
  | "KL" | "JOHOR" | "PENANG" | "SABAH" | "SARAWAK" | "MELAKA" | "KEDAH"
  | "TERENGGANU" | "PUTRAJAYA" | "N.SEMBILAN" | "KUANTAN" | "IPOH" | "SEREMBAN";

export const BRANDS: Brand[] = ["AKEMI", "ZANOTTI", "ERGOTEX", "DUNLOPILLO"];
export const STATES: MalaysianState[] = [
  "KL", "JOHOR", "PENANG", "SABAH", "SARAWAK", "MELAKA", "KEDAH",
  "TERENGGANU", "PUTRAJAYA", "N.SEMBILAN", "KUANTAN", "IPOH", "SEREMBAN",
];

// Tri-state workflow flag used throughout PM tracking columns
export type WorkflowFlag = "TRUE" | "FALSE" | "DONE" | "NO NEED" | "";

// ---------- Events (master — from EVENT SCHEDULE tab) ----------
export interface HouzsEvent {
  // A42 — compound primary key: YEAR-MM-ORGANIZER-STATE-VENUECOMPACT-BRAND
  a42: string;
  status: EventStatus;
  progress: EventProgress;
  year: number;
  month: string;
  startDate: string; // ISO yyyy-mm-dd
  endDate: string;
  durationDays: number;
  organizer: string;
  state: MalaysianState;
  venue: string;
  brand: Brand;
  eventType: EventType;
  contractor: string;
  // PM workflow fields (11 — matches sheet columns)
  agreementApproval: WorkflowFlag;
  floorplan: WorkflowFlag;
  boothNo: string;
  sizeSqm: number;
  sendFloorplanToDesigner: WorkflowFlag;
  threeDCheckedByMgt: WorkflowFlag;
  threeDApprovedByPeter: WorkflowFlag;
  threeDUploadedInNotion: WorkflowFlag;
  weekendActivityTheme: WorkflowFlag;
  licenseMajlis: WorkflowFlag;
  workLoadingBayPermit: WorkflowFlag;
  decoCoffeeTable: WorkflowFlag;
  secDepoRefund: WorkflowFlag;
  // Financials
  totalSalesRm: number;
  rentalRm: number;
  // Integration keys
  linkNotion?: string;
  gcalId?: string;
  // PIC (from calendar title format, not in sheet but displayed) — legacy single field
  pic?: string;
  // Split PICs (mirrors Notion): BD (business-development) + Sales leads
  bdPic?: string;
  salesPic?: string;
  // Preparation pipeline status (Notion "Preparation Condition")
  preparationCondition?: PreparationCondition;
  // Setup & Dismantle logistics (Notion "Driver" block)
  setupDriver?: string;          // e.g. "YUNUS"
  setupLori?: string;            // e.g. "VPC9058"
  setupDatetime?: string;        // ISO "2025-10-29T14:00"
  dismantleDatetime?: string;    // ISO "2025-11-03T10:00"
  setupDismantleStatus?: "PREPARED" | "SETUP DONE" | "DISMANTLE DONE" | "";
  // Assigned team
  assignedSales?: string[];     // sales member IDs assigned to work this fair
  setupCrew?: string[];         // sales member IDs assigned for setup/dismantle
  // Multi-driver / multi-lori (additive — prefer over single strings when set)
  setupDrivers?: EventDriver[]; // team of drivers
  setupLoris?: string[];        // array of plate numbers e.g. ["NCN 6553", "BLY8678"]
}

function mkEvent(e: Omit<HouzsEvent, "durationDays">): HouzsEvent {
  const s = new Date(e.startDate);
  const en = new Date(e.endDate);
  const d = Math.max(1, Math.round((en.getTime() - s.getTime()) / 86400000) + 1);
  return { ...e, durationDays: d };
}

// mockEvents is now empty — all events live in D1 (seeded from the Excel
// import once). events-store.ts fetches them via /api/events with a
// localStorage cache. Kept as an exported empty array so any legacy import
// path still compiles.
export const mockEvents: HouzsEvent[] = [];

// ---------- Helpers ----------
export function calendarTitle(e: HouzsEvent): string {
  // SOLO → show "SOLO" instead of organizer name; never show PIC
  const who = e.eventType === "SOLO" ? "SOLO" : e.organizer;
  return `${e.state} [${e.brand}] ${who} @ ${e.venue}`;
}
export function findEvent(id: string): HouzsEvent | undefined {
  return mockEvents.find((e) => e.a42 === id);
}
export function fmtRM(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n).toLocaleString("en-MY", { maximumFractionDigits: 0 });
  return (neg ? "-RM " : "RM ") + abs;
}
export function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}

// ---------- Exhibition Report cost model ----------
// Matches the real Exhibition Report sheet structure:
//
//   GROSS PROFIT = SALES − COGS(Matt/Sofa + Bedframe + Acc)
//   NET PROFIT   = GROSS PROFIT − RENTAL − SETUP − TRANSPORT FEE
//                  − TRANSPORT SETUP&DISMANTLE − COMMISSION − MERCH − OTHERS
//
// Derived rates:
//   RENTAL/SQM/DAY = RENTAL / (SIZE_SQM × DURATION_DAYS)
//   SALES/DAY      = SALES  / DURATION_DAYS
//
// Real data will come from the Exhibition Report tab. For now we derive
// deterministic figures from each event's sales / sqm / brand / state
// so the dashboards match the shape of reality.
export interface CostBreakdown {
  cogsMattSofa: number;
  cogsBedframe: number;
  cogsAcc: number;
  cogsTotal: number;
  rental: number;
  setup: number;
  transportFee: number;
  transportSetupDismantle: number;
  commission: number;
  merch: number;
  othersCosting: number;
  totalCost: number;          // all cost lines including COGS
  grossProfit: number;        // Sales − COGS
  grossProfitPct: number;     // %
  netProfit: number;          // Sales − all costs
  netProfitPct: number;       // %
  rentalPerSqmPerDay: number; // Rental / (sqm × days)
  salesPerDay: number;        // Sales / days
}

// Deterministic pseudo-random in [0,1) from a string seed
function seeded(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function computeCosts(e: HouzsEvent): CostBreakdown {
  const sales = e.totalSalesRm;
  const rental = e.rentalRm;
  const r = seeded(e.a42); // stable per-event jitter

  // COGS — biggest line, ~52–62% of sales (brand-weighted)
  const cogsRatio =
    e.brand === "AKEMI"      ? 0.54 + r * 0.08 :
    e.brand === "ZANOTTI"    ? 0.56 + r * 0.08 :
    e.brand === "ERGOTEX"    ? 0.50 + r * 0.08 :
                               0.52 + r * 0.08;
  const cogsTotal = Math.round(sales * cogsRatio);
  const cogsMattSofa = Math.round(cogsTotal * 0.68);
  const cogsBedframe = Math.round(cogsTotal * 0.22);
  const cogsAcc      = cogsTotal - cogsMattSofa - cogsBedframe;

  // Setup cost: fixed + per sqm
  const setup = Math.round(1800 + e.sizeSqm * 95 + r * 1200);

  // Transport fee: base + distance proxy (state)
  const farState = ["SABAH", "SARAWAK", "PENANG", "KEDAH", "IPOH", "KUANTAN", "TERENGGANU"].includes(e.state);
  const transportFee = Math.round((farState ? 2400 : 900) + r * 600);

  // Loading bay setup/dismantle manpower
  const transportSetupDismantle = Math.round(600 + e.durationDays * 120 + r * 400);

  // Commission ~4% of sales
  const commission = Math.round(sales * (0.035 + r * 0.015));

  // Merch/marketing spend ~1.5% of sales
  const merch = Math.round(sales * (0.01 + r * 0.012));

  // Others costing — misc venue/utility/licensing charges (~1–2% of sales)
  const othersCosting = Math.round(sales * (0.008 + r * 0.01) + 200);

  const grossProfit = sales - cogsTotal;
  const grossProfitPct = sales > 0 ? (grossProfit / sales) * 100 : 0;

  const totalCost =
    cogsTotal + rental + setup + transportFee + transportSetupDismantle +
    commission + merch + othersCosting;
  const netProfit = sales - totalCost;
  const netProfitPct = sales > 0 ? (netProfit / sales) * 100 : 0;

  const rentalPerSqmPerDay =
    e.sizeSqm && e.durationDays ? rental / (e.sizeSqm * e.durationDays) : 0;
  const salesPerDay = e.durationDays ? sales / e.durationDays : 0;

  return {
    cogsMattSofa, cogsBedframe, cogsAcc, cogsTotal,
    rental, setup, transportFee, transportSetupDismantle,
    commission, merch, othersCosting,
    totalCost, grossProfit, grossProfitPct, netProfit, netProfitPct,
    rentalPerSqmPerDay, salesPerDay,
  };
}
export function parseIsoDate(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
}
