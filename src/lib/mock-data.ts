// Houzs Century — real domain mock data
// Source: EVENT SCHEDULE tab of Exhibition & Solo Analysis spreadsheet
// Schema mirrors the 32-column sheet verbatim

export type Brand = "AKEMI" | "ZANOTTI" | "ERGOTEX" | "DUNLOPILLO";
export type EventType = "SOLO" | "EXHIBITION";
export type EventStatus = "CONFIRMED" | "PENDING" | "CANCELLED";
export type EventProgress = "NOT STARTED" | "IN PROGRESS" | "COMPLETED";
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
  // PIC (from calendar title format, not in sheet but displayed)
  pic?: string;
  // Setup & Dismantle logistics (Notion "Driver" block)
  setupDriver?: string;          // e.g. "YUNUS"
  setupLori?: string;            // e.g. "VPC9058"
  setupDatetime?: string;        // ISO "2025-10-29T14:00"
  dismantleDatetime?: string;    // ISO "2025-11-03T10:00"
  setupDismantleStatus?: "PREPARED" | "SETUP DONE" | "DISMANTLE DONE" | "";
  // Assigned team
  assignedSales?: string[];     // sales member IDs assigned to work this fair
  setupCrew?: string[];         // sales member IDs assigned for setup/dismantle
}

function mkEvent(e: Omit<HouzsEvent, "durationDays">): HouzsEvent {
  const s = new Date(e.startDate);
  const en = new Date(e.endDate);
  const d = Math.max(1, Math.round((en.getTime() - s.getTime()) / 86400000) + 1);
  return { ...e, durationDays: d };
}

// ~24 rows modelled on real April 2026 calendar screenshot
export const mockEvents: HouzsEvent[] = [
  // === April week 1 ===
  mkEvent({
    a42: "2026-04-KAI HAO (KL CHEN)-JOHOR-PARADIGMMALL-AKEMI",
    status: "CONFIRMED", progress: "COMPLETED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-01", endDate: "2026-04-05",
    organizer: "KAI HAO", state: "JOHOR", venue: "PARADIGM MALL",
    brand: "AKEMI", eventType: "SOLO", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "P1ExtB",
    sizeSqm: 57.23,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "NO NEED", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 68500, rentalRm: 15000,
    linkNotion: "https://notion.so/JOHOR-Akemi-KAI-HAO-PARADIGM-MALL-xxx",
    gcalId: "gcal1@google.com",
    pic: "KL CHEN",
  }),
  mkEvent({
    a42: "2026-04-HOMELOVE-SARAWAK-BCCKKUCHING-AKEMI",
    status: "CONFIRMED", progress: "IN PROGRESS",
    year: 2026, month: "APRIL",
    startDate: "2026-04-02", endDate: "2026-04-06",
    organizer: "HOMELOVE", state: "SARAWAK", venue: "BCCK KUCHING",
    brand: "AKEMI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "B3 (4 BOOTH)",
    sizeSqm: 36,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "",
    secDepoRefund: "",
    totalSalesRm: 92000, rentalRm: 21000,
    linkNotion: "https://notion.so/SARAWAK-Akemi-HOMELOVE-BCCK",
    gcalId: "gcal2@google.com",
    pic: "PETER",
  }),
  mkEvent({
    a42: "2026-04-MEGAHOME-JOHOR-AICCAUSTIN-AKEMI",
    status: "CONFIRMED", progress: "IN PROGRESS",
    year: 2026, month: "APRIL",
    startDate: "2026-04-03", endDate: "2026-04-07",
    organizer: "MEGAHOME", state: "JOHOR", venue: "AICC AUSTIN",
    brand: "AKEMI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "A12 (6 BOOTH)",
    sizeSqm: 54,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "DONE", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 128000, rentalRm: 24000,
    linkNotion: "https://notion.so/JOHOR-Akemi-MEGAHOME-AICC",
    gcalId: "gcal3@google.com",
    pic: "KINGSLEY",
  }),
  // === April week 2 ===
  mkEvent({
    a42: "2026-04-SYELIN-IPOH-AEONKINTACITY-AKEMI",
    status: "CONFIRMED", progress: "IN PROGRESS",
    year: 2026, month: "APRIL",
    startDate: "2026-04-07", endDate: "2026-04-14",
    organizer: "SYELIN (EV PLAN MKTG)", state: "IPOH", venue: "AEON KINTA CITY",
    brand: "AKEMI", eventType: "SOLO", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "CC-1",
    sizeSqm: 48,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "NO NEED", licenseMajlis: "DONE",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 74500, rentalRm: 18000,
    linkNotion: "https://notion.so/IPOH-Akemi-SYELIN-AEON-KINTA",
    gcalId: "gcal4@google.com",
    pic: "PETER",
  }),
  mkEvent({
    a42: "2026-04-BIGHOME-KL-STADIUMBUKITJALIL-ZANOTTI",
    status: "CONFIRMED", progress: "IN PROGRESS",
    year: 2026, month: "APRIL",
    startDate: "2026-04-09", endDate: "2026-04-15",
    organizer: "BIGHOME", state: "KL", venue: "STADIUM BUKIT JALIL",
    brand: "ZANOTTI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "SBJ-4 (6 BOOTH)",
    sizeSqm: 54,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "DONE", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "DONE",
    secDepoRefund: "",
    totalSalesRm: 96000, rentalRm: 22000,
    linkNotion: "https://notion.so/KL-Zanotti-BIGHOME-STADIUM-BJ",
    gcalId: "gcal5@google.com",
    pic: "KINGSLEY",
  }),
  mkEvent({
    a42: "2026-04-HOMELOVE-KUANTAN-SASCC-AKEMI",
    status: "CONFIRMED", progress: "IN PROGRESS",
    year: 2026, month: "APRIL",
    startDate: "2026-04-09", endDate: "2026-04-15",
    organizer: "HOMELOVE", state: "KUANTAN",
    venue: "SULTAN AHMAD SHAH CONVENTION CENTRE",
    brand: "AKEMI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "SASCC-H2 (4 BOOTH)",
    sizeSqm: 36,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "NO NEED", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 84000, rentalRm: 19000,
    linkNotion: "https://notion.so/KUANTAN-Akemi-HOMELOVE-SASCC",
    gcalId: "gcal6@google.com",
    pic: "PETER",
  }),
  // === April week 3 ===
  mkEvent({
    a42: "2026-04-KAI HAO (KL CHEN)-SEREMBAN-AEONSEREMBAN2-AKEMI",
    status: "CONFIRMED", progress: "NOT STARTED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-14", endDate: "2026-04-20",
    organizer: "KAI HAO", state: "SEREMBAN", venue: "AEON SEREMBAN 2",
    brand: "AKEMI", eventType: "SOLO", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "S2-CC",
    sizeSqm: 42,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 58000, rentalRm: 14000,
    linkNotion: "https://notion.so/SEREMBAN-Akemi-KAI-HAO",
    gcalId: "gcal7@google.com",
    pic: "KL CHEN",
  }),
  mkEvent({
    a42: "2026-04-VINCENT (VTEAM EVENT)-PUTRAJAYA-ALAMANDA-AKEMI",
    status: "CONFIRMED", progress: "NOT STARTED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-15", endDate: "2026-04-21",
    organizer: "VINCENT (VTEAM EVENT)", state: "PUTRAJAYA", venue: "ALAMANDA PUTRAJAYA",
    brand: "AKEMI", eventType: "SOLO", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "ALM-1",
    sizeSqm: 32,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "TRUE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "NO NEED", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 46000, rentalRm: 11500,
    linkNotion: "https://notion.so/PUTRAJAYA-Akemi-VINCENT",
    gcalId: "gcal8@google.com",
    pic: "VINCENT",
  }),
  mkEvent({
    a42: "2026-04-REX-KL-MIDVALLEY-AKEMI",
    status: "CONFIRMED", progress: "NOT STARTED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-17", endDate: "2026-04-25",
    organizer: "REX", state: "KL", venue: "MID VALLEY",
    brand: "AKEMI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "MV-3011 (6 BOOTH)",
    sizeSqm: 54,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "DONE", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "DONE",
    secDepoRefund: "",
    totalSalesRm: 142000, rentalRm: 28000,
    linkNotion: "https://notion.so/KL-Akemi-REX-MID-VALLEY",
    gcalId: "gcal9@google.com",
    pic: "KINGSLEY",
  }),
  mkEvent({
    a42: "2026-04-REX-KL-MIDVALLEY-ZANOTTI",
    status: "CONFIRMED", progress: "NOT STARTED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-17", endDate: "2026-04-25",
    organizer: "REX", state: "KL", venue: "MID VALLEY",
    brand: "ZANOTTI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "MV-3011 (4 BOOTH)",
    sizeSqm: 36,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "DONE", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "DONE",
    secDepoRefund: "",
    totalSalesRm: 78000, rentalRm: 18500,
    linkNotion: "https://notion.so/KL-Zanotti-REX-MID-VALLEY",
    gcalId: "gcal10@google.com",
    pic: "KINGSLEY",
  }),
  mkEvent({
    a42: "2026-04-KAI HAO (KL CHEN)-SABAH-SURIASABAH-AKEMI",
    status: "CONFIRMED", progress: "NOT STARTED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-21", endDate: "2026-04-26",
    organizer: "KAI HAO", state: "SABAH", venue: "SURIA SABAH",
    brand: "AKEMI", eventType: "SOLO", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "SSB-1",
    sizeSqm: 38,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "TRUE", threeDUploadedInNotion: "",
    weekendActivityTheme: "NO NEED", licenseMajlis: "",
    workLoadingBayPermit: "", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 52000, rentalRm: 12500,
    linkNotion: "https://notion.so/SABAH-Akemi-KAI-HAO-SURIA",
    gcalId: "gcal11@google.com",
    pic: "KL CHEN",
  }),
  // === April week 4 → May ===
  mkEvent({
    a42: "2026-04-HOMEDEC-KL-KLCC-ZANOTTI",
    status: "CONFIRMED", progress: "NOT STARTED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-29", endDate: "2026-05-05",
    organizer: "HOMEDEC", state: "KL", venue: "KLCC CONVENTION CENTRE",
    brand: "ZANOTTI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "KLCC-F2 (6 BOOTH)",
    sizeSqm: 54,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "TRUE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "DONE", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "DONE",
    secDepoRefund: "",
    totalSalesRm: 186000, rentalRm: 42000,
    linkNotion: "https://notion.so/KL-Zanotti-HOMEDEC-KLCC",
    gcalId: "gcal12@google.com",
    pic: "KINGSLEY",
  }),
  mkEvent({
    a42: "2026-04-MEGAHOME-MELAKA-MITC-AKEMI",
    status: "CONFIRMED", progress: "NOT STARTED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-30", endDate: "2026-05-06",
    organizer: "MEGAHOME", state: "MELAKA", venue: "MITC",
    brand: "AKEMI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "MITC-A5 (4 BOOTH)",
    sizeSqm: 36,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "TRUE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "NO NEED", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 88000, rentalRm: 20000,
    linkNotion: "https://notion.so/MELAKA-Akemi-MEGAHOME-MITC",
    gcalId: "gcal13@google.com",
    pic: "PETER",
  }),
  mkEvent({
    a42: "2026-04-HOMELOVE-SARAWAK-BOULEVARDMIRI-AKEMI",
    status: "CONFIRMED", progress: "NOT STARTED",
    year: 2026, month: "APRIL",
    startDate: "2026-04-30", endDate: "2026-05-06",
    organizer: "HOMELOVE", state: "SARAWAK",
    venue: "BOULEVARD SHOPPING MALL MIRI",
    brand: "AKEMI", eventType: "EXHIBITION", contractor: "DREAMART",
    agreementApproval: "TRUE", floorplan: "TRUE", boothNo: "BLV-M3 (4 BOOTH)",
    sizeSqm: 36,
    sendFloorplanToDesigner: "TRUE", threeDCheckedByMgt: "TRUE",
    threeDApprovedByPeter: "DONE", threeDUploadedInNotion: "TRUE",
    weekendActivityTheme: "", licenseMajlis: "NO NEED",
    workLoadingBayPermit: "DONE", decoCoffeeTable: "NO NEED",
    secDepoRefund: "",
    totalSalesRm: 76000, rentalRm: 17500,
    linkNotion: "https://notion.so/SARAWAK-Akemi-HOMELOVE-MIRI",
    gcalId: "gcal14@google.com",
    pic: "PETER",
  }),
];

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
