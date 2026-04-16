"use client";

// ASSR (After-Sales Service & Repair) case management store —
// localStorage-backed with subscriber pattern, same as sales-store.ts.

import { useSyncExternalStore } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CaseStatus =
  | "UNDER_VERIFICATION"
  | "PENDING_SOLUTION"
  | "PENDING_ITEM_PICKUP"
  | "PENDING_SUPPLIER_PICKUP"
  | "PENDING_ITEM_READY"
  | "PENDING_DELIVERY"
  | "COMPLETED"
  | "CANCELLED";

export type CasePriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export type CaseCategory =
  | "WARRANTY_SERVICE_REQUEST"
  | "INSTALLATION_ASSEMBLY_ISSUE"
  | "PRODUCT_DEFECT"
  | "DELIVERY_DAMAGE"
  | "MISSING_PARTS"
  | "CUSTOMER_COMPLAINT"
  | "RETURN_EXCHANGE"
  | "WRONG_ITEM"
  | "COLOUR_MISMATCH"
  | "FABRIC_ISSUE"
  | "STRUCTURE_DAMAGE"
  | "OTHERS";

export type ServiceCategory =
  | "SERVICE_IN_EXTERNAL_SUPPLIER"
  | "SERVICE_IN_EXTERNAL_INHOUSE"
  | "2ND_TRIP_DELIVERY"
  | "ONSITE_SERVICE"
  | "PICKUP_AND_RETURN"
  | "REPLACEMENT"
  | "REFUND"
  | "OTHERS";

export interface TimelineEntry {
  id: string;
  caseId: string;
  timestamp: string; // ISO
  action: string;
  user: string;
  notes?: string;
  photoUrls?: string[];
}

/** A single dated log entry — used for Action Taken and Call Log lists */
export interface LogEntry {
  id: string;
  date: string;   // ISO date e.g. "2026-04-10"
  text: string;
}

export interface ASSRCase {
  id: string;
  caseNo: string; // e.g. "ASSR-2604-001"
  status: CaseStatus;
  priority: CasePriority;
  category: CaseCategory;
  brand: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  productName: string;
  productSku?: string;
  invoiceNo?: string;
  purchaseDate?: string;
  issueDescription: string;
  photoUrls: string[];
  assignedTo: string;
  salesPerson?: string;
  supplierName?: string;
  supplierRef?: string;
  resolution?: string;
  internalNotes?: string;
  slaDeadline?: string; // ISO date
  createdAt: string; // ISO
  updatedAt: string; // ISO
  completedAt?: string; // ISO
  timeline: TimelineEntry[];
  source: "INTERNAL" | "PORTAL";

  // From Google Sheet — Sales & Reference
  salesOrderNo?: string;        // S/O — e.g. "SO-002588"
  refNo?: string;               // Ref No — e.g. "HC0450"
  complainedDate?: string;      // Complained date — when complaint was filed (separate from createdAt)
  location?: string;            // Location — e.g. "KL", "JB", "PG"

  // From Google Sheet — Delivery
  deliveryOrderNo?: string;     // D/O — e.g. "DO-002564"
  doDeliveredDate?: string;     // DO Delivered Date

  // From Google Sheet — Service tracking
  serviceCategory?: ServiceCategory; // Service Category
  actionRemark?: string;        // Action Remark
  itemDetails?: string;         // Item Details (more specific than productName)
  actionTakenLogs?: LogEntry[]; // Action Taken — service agent dated log entries (unlimited)
  callLogs?: LogEntry[];        // Call Log: Purchasing Action Taken — purchasing dated log entries (unlimited)

  // From Google Sheet — Supplier & PO
  poNo?: string;                // PO No — e.g. "PO1988"

  // From Google Sheet — Address (split into 4 parts)
  address1?: string;            // Address 1
  address2?: string;            // Address 2
  address3?: string;            // Address 3
  address4?: string;            // Address 4

  // From Google Sheet — Logistics
  linkRef?: string;             // Link Ref.
  goodsReturnedNote?: string;   // Goods Returned Note & Date
  supplierServiceNote?: string; // SUPPLIER SERVICE NOTE
}

export interface ASSRSupplier {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  category: string; // e.g. "Mattress", "Fabric", "Frame"
  status: "ACTIVE" | "INACTIVE";
}

// ─── Staff / PIC list ───────────────────────────────────────────────────────

export const STAFF_LIST = [
  "PETER", "STANLEY", "KINGSLEY", "KRIS",
  "SHAWN", "ANTHONY", "LAWRENCE", "JUNIE",
  "MEI TING", "CHEA HUAN", "YANG", "SYU",
  "YUNY", "CHANG SHI TING",
] as const;

// ─── Constants ───────────────────────────────────────────────────────────────

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  UNDER_VERIFICATION: "Under Verification",
  PENDING_SOLUTION: "Pending Solution",
  PENDING_ITEM_PICKUP: "Pending Item Pickup",
  PENDING_SUPPLIER_PICKUP: "Pending Supplier Pickup",
  PENDING_ITEM_READY: "Pending Item Ready",
  PENDING_DELIVERY: "Pending Delivery/Service",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const CASE_STATUS_COLORS: Record<CaseStatus, string> = {
  UNDER_VERIFICATION: "bg-blue-100 text-blue-800",
  PENDING_SOLUTION: "bg-orange-100 text-orange-800",
  PENDING_ITEM_PICKUP: "bg-purple-100 text-purple-800",
  PENDING_SUPPLIER_PICKUP: "bg-pink-100 text-pink-800",
  PENDING_ITEM_READY: "bg-indigo-100 text-indigo-800",
  PENDING_DELIVERY: "bg-cyan-100 text-cyan-800",
  COMPLETED: "bg-green-100 text-green-800",
  CANCELLED: "bg-gray-100 text-gray-500",
};

export const PRIORITY_COLORS: Record<CasePriority, string> = {
  LOW: "bg-gray-100 text-gray-600",
  MEDIUM: "bg-blue-100 text-blue-700",
  HIGH: "bg-orange-100 text-orange-700",
  URGENT: "bg-red-100 text-red-700",
};

export const CATEGORY_LABELS: Record<CaseCategory, string> = {
  WARRANTY_SERVICE_REQUEST: "Warranty Service Request",
  INSTALLATION_ASSEMBLY_ISSUE: "Installation / Assembly Issue",
  PRODUCT_DEFECT: "Product Defect",
  DELIVERY_DAMAGE: "Delivery Damage",
  MISSING_PARTS: "Missing Parts",
  CUSTOMER_COMPLAINT: "Customer Complaint",
  RETURN_EXCHANGE: "Return / Exchange",
  WRONG_ITEM: "Wrong Item Delivered",
  COLOUR_MISMATCH: "Colour Mismatch",
  FABRIC_ISSUE: "Fabric Issue",
  STRUCTURE_DAMAGE: "Structure / Frame Damage",
  OTHERS: "Others",
};

export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  SERVICE_IN_EXTERNAL_SUPPLIER: "Service in External(Supplier)",
  SERVICE_IN_EXTERNAL_INHOUSE: "Service in External(In House)",
  "2ND_TRIP_DELIVERY": "2nd Trip Delivery",
  ONSITE_SERVICE: "On-Site Service",
  PICKUP_AND_RETURN: "Pickup & Return",
  REPLACEMENT: "Replacement",
  REFUND: "Refund",
  OTHERS: "Others",
};

/** Visual display order for the stepper — does NOT enforce linear progression.
 *  Cases can jump to any status freely. */
export const CASE_WORKFLOW_ORDER: CaseStatus[] = [
  "UNDER_VERIFICATION",
  "PENDING_SOLUTION",
  "PENDING_ITEM_PICKUP",
  "PENDING_SUPPLIER_PICKUP",
  "PENDING_ITEM_READY",
  "PENDING_DELIVERY",
  "COMPLETED",
];

export const SLA_DAYS: Record<CasePriority, number> = {
  URGENT: 3,
  HIGH: 7,
  MEDIUM: 14,
  LOW: 30,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Seed suppliers ──────────────────────────────────────────────────────────

const seedSuppliers: ASSRSupplier[] = [
  {
    id: "sup-001",
    name: "Getaran Sdn Bhd",
    contactPerson: "Ahmad Razali",
    phone: "+60173456789",
    email: "ahmad@getaran.com.my",
    address: "Lot 12, Kawasan Perindustrian Puchong, 47100 Selangor",
    category: "Mattress",
    status: "ACTIVE",
  },
  {
    id: "sup-002",
    name: "Texchem Fabrics (M) Sdn Bhd",
    contactPerson: "Lim Wei Keat",
    phone: "+60162345678",
    email: "weikeat@texchem.com.my",
    address: "No. 8, Jalan Kilang 3, Taman Perindustrian Batu Caves, 68100 KL",
    category: "Fabric",
    status: "ACTIVE",
  },
  {
    id: "sup-003",
    name: "Berjaya Steel Industries Sdn Bhd",
    contactPerson: "Tan Chee Hong",
    phone: "+60123456790",
    email: "cheehong@berjayasteel.com.my",
    address: "Plot 45, Kawasan Perindustrian Senai, 81400 Johor",
    category: "Frame",
    status: "ACTIVE",
  },
  {
    id: "sup-004",
    name: "Dreamland Foam Industries Sdn Bhd",
    contactPerson: "Siti Aminah",
    phone: "+60192345671",
    email: "siti@dreamlandfoam.com.my",
    address: "Lot 7, Jalan Industri 2/4, Rawang Industrial Park, 48000 Selangor",
    category: "Mattress",
    status: "ACTIVE",
  },
  {
    id: "sup-005",
    name: "Woodcraft Manufacturing Sdn Bhd",
    contactPerson: "Raj Kumar",
    phone: "+60183456712",
    email: "raj@woodcraftmfg.com.my",
    address: "No. 22, Persiaran Perindustrian Bukit Minyak, 14100 Penang",
    category: "Frame",
    status: "INACTIVE",
  },
];

// ─── Seed cases ──────────────────────────────────────────────────────────────

const seedCases: ASSRCase[] = [
  {
    id: "assr-seed-001",
    caseNo: "ASSR-2604-001",
    status: "UNDER_VERIFICATION",
    priority: "HIGH",
    category: "WARRANTY_SERVICE_REQUEST",
    brand: "AKEMI",
    customerName: "Tan Mei Ling",
    customerPhone: "+60127654321",
    customerEmail: "meiling.tan@gmail.com",
    customerAddress: "12, Jalan SS2/30, 47300 Petaling Jaya, Selangor",
    productName: "AKEMI Luxe Mattress Queen",
    productSku: "AKM-LXQ-001",
    invoiceNo: "INV-2603-045",
    purchaseDate: "2026-03-10",
    issueDescription: "Mattress sagging on one side after 3 weeks of use. Visible indentation approximately 3cm deep on the left side.",
    photoUrls: [],
    assignedTo: "SHAWN",
    salesPerson: "STANLEY",
    supplierName: "Getaran Sdn Bhd",
    slaDeadline: "2026-04-10",
    createdAt: "2026-04-03T09:15:00.000Z",
    updatedAt: "2026-04-03T09:15:00.000Z",
    timeline: [
      {
        id: "tl-001-a",
        caseId: "assr-seed-001",
        timestamp: "2026-04-03T09:15:00.000Z",
        action: "Case created",
        user: "SHAWN",
        notes: "Customer called in to report mattress defect. Photos requested.",
      },
    ],
    source: "INTERNAL",
    // Google Sheet fields
    salesOrderNo: "SO-002588",
    refNo: "HC0450",
    complainedDate: "2026-04-03",
    location: "SELANGOR",
    serviceCategory: "SERVICE_IN_EXTERNAL_SUPPLIER",
    itemDetails: "AKEMI Luxe Mattress Queen x1 — sagging left side",
  },
  {
    id: "assr-seed-002",
    caseNo: "ASSR-2604-002",
    status: "UNDER_VERIFICATION",
    priority: "MEDIUM",
    category: "INSTALLATION_ASSEMBLY_ISSUE",
    brand: "ZANOTTI",
    customerName: "Lim Chee Wai",
    customerPhone: "+60163218765",
    customerEmail: "cheewai.lim@yahoo.com",
    customerAddress: "Blk A-12-3, Residensi Harmoni, Jalan Kuching, 51200 KL",
    productName: "ZANOTTI Leather Sofa 3-Seater",
    productSku: "ZNT-LS3-002",
    invoiceNo: "INV-2604-012",
    purchaseDate: "2026-04-01",
    issueDescription: "Delivery team scratched the leather on the armrest during installation. Scratch is approximately 10cm long on right armrest.",
    photoUrls: [],
    assignedTo: "ANTHONY",
    salesPerson: "PETER",
    slaDeadline: "2026-04-15",
    createdAt: "2026-04-02T14:30:00.000Z",
    updatedAt: "2026-04-04T10:00:00.000Z",
    timeline: [
      {
        id: "tl-002-a",
        caseId: "assr-seed-002",
        timestamp: "2026-04-02T14:30:00.000Z",
        action: "Case created",
        user: "ANTHONY",
        notes: "Customer reported scratch on delivery day.",
      },
      {
        id: "tl-002-b",
        caseId: "assr-seed-002",
        timestamp: "2026-04-04T10:00:00.000Z",
        action: "Status changed to Under Verification",
        user: "ANTHONY",
        notes: "Photos received from customer. Forwarded to QC team for assessment.",
      },
    ],
    source: "INTERNAL",
    // Google Sheet fields
    salesOrderNo: "SO-003758",
    refNo: "HC4551",
    complainedDate: "2026-04-02",
    location: "KL",
    deliveryOrderNo: "DO-002564",
    doDeliveredDate: "2026-04-01",
    serviceCategory: "SERVICE_IN_EXTERNAL_INHOUSE",
    itemDetails: "ZANOTTI Leather Sofa 3S — scratch on right armrest",
    actionTakenLogs: [{ id: "at-002-1", date: "2026-04-04", text: "Photos forwarded to QC for assessment" }],
  },
  {
    id: "assr-seed-003",
    caseNo: "ASSR-2604-003",
    status: "PENDING_SOLUTION",
    priority: "URGENT",
    category: "WARRANTY_SERVICE_REQUEST",
    brand: "DUNLOPILLO",
    customerName: "Ahmad bin Ismail",
    customerPhone: "+60198765432",
    customerEmail: "ahmad.ismail@hotmail.com",
    customerAddress: "No. 5, Jalan Bukit Damansara, 50490 KL",
    productName: "DUNLOPILLO Supreme Latex King",
    productSku: "DNP-SLK-005",
    invoiceNo: "INV-2601-088",
    purchaseDate: "2026-01-15",
    issueDescription: "Warranty claim for latex deterioration. Mattress shows uneven firmness and visible material breakdown in center area. Within 10-year warranty period.",
    photoUrls: [],
    assignedTo: "LAWRENCE",
    salesPerson: "KINGSLEY",
    supplierName: "Dreamland Foam Industries Sdn Bhd",
    supplierRef: "WC-2604-019",
    slaDeadline: "2026-04-08",
    createdAt: "2026-04-05T08:00:00.000Z",
    updatedAt: "2026-04-07T16:45:00.000Z",
    timeline: [
      {
        id: "tl-003-a",
        caseId: "assr-seed-003",
        timestamp: "2026-04-05T08:00:00.000Z",
        action: "Case created",
        user: "LAWRENCE",
        notes: "Urgent warranty claim — customer is a VIP repeat buyer.",
      },
      {
        id: "tl-003-b",
        caseId: "assr-seed-003",
        timestamp: "2026-04-06T11:00:00.000Z",
        action: "Status changed to Under Verification",
        user: "LAWRENCE",
        notes: "On-site inspection scheduled.",
      },
      {
        id: "tl-003-c",
        caseId: "assr-seed-003",
        timestamp: "2026-04-07T16:45:00.000Z",
        action: "Status changed to Pending Solution",
        user: "LAWRENCE",
        notes: "Defect confirmed by QC. Awaiting replacement unit from supplier.",
      },
    ],
    source: "INTERNAL",
    // Google Sheet fields
    salesOrderNo: "SO-001422",
    refNo: "HC3892",
    complainedDate: "2026-04-05",
    location: "KL",
    deliveryOrderNo: "DO-001388",
    doDeliveredDate: "2026-01-18",
    serviceCategory: "SERVICE_IN_EXTERNAL_SUPPLIER",
    itemDetails: "DUNLOPILLO Supreme Latex King x1 — latex deterioration center",
    actionTakenLogs: [
      { id: "at-003-1", date: "2026-04-06", text: "On-site inspection scheduled for VIP customer" },
      { id: "at-003-2", date: "2026-04-07", text: "Defect confirmed by QC. Replacement requested from supplier" },
    ],
    poNo: "PO1988",
    address1: "No. 5, Jalan Bukit Damansara",
    address2: "50490 KL",
    callLogs: [{ id: "cl-003-1", date: "2026-04-07", text: "Called supplier — confirmed replacement stock available" }],
  },
  {
    id: "assr-seed-004",
    caseNo: "ASSR-2604-004",
    status: "PENDING_ITEM_PICKUP",
    priority: "MEDIUM",
    category: "WARRANTY_SERVICE_REQUEST",
    brand: "ERGOTEX",
    customerName: "Wong Siew Mei",
    customerPhone: "+60176543210",
    customerEmail: "siewmei.wong@gmail.com",
    customerAddress: "18, Lorong Maarof, Bangsar, 59000 KL",
    productName: "ERGOTEX Adjustable Bed Frame Queen",
    productSku: "EGT-ABQ-003",
    invoiceNo: "INV-2603-072",
    purchaseDate: "2026-03-20",
    issueDescription: "Customer requests exchange — motor makes grinding noise when adjusting head position. Exchange approved for same model.",
    photoUrls: [],
    assignedTo: "JUNIE",
    salesPerson: "KRIS",
    supplierName: "Berjaya Steel Industries Sdn Bhd",
    resolution: "Exchange approved — same model replacement",
    slaDeadline: "2026-04-17",
    createdAt: "2026-04-06T10:20:00.000Z",
    updatedAt: "2026-04-09T14:00:00.000Z",
    timeline: [
      {
        id: "tl-004-a",
        caseId: "assr-seed-004",
        timestamp: "2026-04-06T10:20:00.000Z",
        action: "Case created",
        user: "JUNIE",
        notes: "Customer reported grinding noise in adjustable frame motor.",
      },
      {
        id: "tl-004-b",
        caseId: "assr-seed-004",
        timestamp: "2026-04-09T14:00:00.000Z",
        action: "Status changed to Pending Item Pickup",
        user: "JUNIE",
        notes: "Exchange approved. Arranging pickup of defective unit.",
      },
    ],
    source: "PORTAL",
    // Google Sheet fields
    salesOrderNo: "SO-003210",
    refNo: "HC5012",
    complainedDate: "2026-04-06",
    location: "KL",
    deliveryOrderNo: "DO-003180",
    doDeliveredDate: "2026-03-22",
    serviceCategory: "2ND_TRIP_DELIVERY",
    itemDetails: "ERGOTEX Adjustable Bed Frame Queen x1 — motor grinding noise",
    actionTakenLogs: [
      { id: "at-004-1", date: "2026-04-07", text: "Motor defect verified via video from customer" },
      { id: "at-004-2", date: "2026-04-09", text: "Exchange approved. Pickup scheduled for defective unit" },
    ],
    actionRemark: "Same model replacement — no cost to customer",
    address1: "18, Lorong Maarof",
    address2: "Bangsar",
    address3: "59000 KL",
  },
  {
    id: "assr-seed-005",
    caseNo: "ASSR-2604-005",
    status: "PENDING_SUPPLIER_PICKUP",
    priority: "LOW",
    category: "INSTALLATION_ASSEMBLY_ISSUE",
    brand: "AKEMI",
    customerName: "Nur Aisyah binti Mohd",
    customerPhone: "+60145678901",
    customerEmail: "aisyah.mohd@gmail.com",
    customerAddress: "A-3-5, Kondominium Seri Puteri, Bandar Sri Permaisuri, 56000 KL",
    productName: "AKEMI Bed Frame Set King",
    productSku: "AKM-BFK-008",
    invoiceNo: "INV-2604-031",
    purchaseDate: "2026-04-05",
    issueDescription: "Missing headboard mounting bolts and Allen key from package. Customer unable to complete assembly.",
    photoUrls: [],
    assignedTo: "MEI TING",
    salesPerson: "PETER",
    supplierName: "Woodcraft Manufacturing Sdn Bhd",
    slaDeadline: "2026-05-05",
    createdAt: "2026-04-08T11:30:00.000Z",
    updatedAt: "2026-04-11T09:00:00.000Z",
    timeline: [
      {
        id: "tl-005-a",
        caseId: "assr-seed-005",
        timestamp: "2026-04-08T11:30:00.000Z",
        action: "Case created",
        user: "MEI TING",
        notes: "Customer missing hardware for assembly.",
      },
      {
        id: "tl-005-b",
        caseId: "assr-seed-005",
        timestamp: "2026-04-11T09:00:00.000Z",
        action: "Status changed to Pending Supplier Pickup",
        user: "MEI TING",
        notes: "Replacement hardware requested from supplier. Waiting for supplier to prepare parts.",
      },
    ],
    source: "INTERNAL",
    // Google Sheet fields
    salesOrderNo: "SO-004102",
    refNo: "HC5530",
    complainedDate: "2026-04-08",
    location: "KL",
    deliveryOrderNo: "DO-004088",
    doDeliveredDate: "2026-04-05",
    serviceCategory: "SERVICE_IN_EXTERNAL_SUPPLIER",
    itemDetails: "Bed frame hardware set — mounting bolts x6 + Allen key x1",
    actionTakenLogs: [
      { id: "at-005-1", date: "2026-04-09", text: "Missing hardware confirmed — bolts x6 + Allen key x1" },
      { id: "at-005-2", date: "2026-04-11", text: "Replacement hardware requested from Woodcraft. Awaiting supplier" },
    ],
    poNo: "PO2045",
    callLogs: [{ id: "cl-005-1", date: "2026-04-10", text: "Called Woodcraft — parts being prepared, ETA 3 days" }],
    address1: "A-3-5, Kondominium Seri Puteri",
    address2: "Bandar Sri Permaisuri",
    address3: "56000 KL",
  },
  {
    id: "assr-seed-006",
    caseNo: "ASSR-2604-006",
    status: "PENDING_DELIVERY",
    priority: "HIGH",
    category: "WARRANTY_SERVICE_REQUEST",
    brand: "ZANOTTI",
    customerName: "Dr. Rajesh Kanagaraj",
    customerPhone: "+60189012345",
    customerEmail: "dr.rajesh@kanagaraj.com",
    customerAddress: "32, Jalan Taman Melawati, 53100 KL",
    productName: "ZANOTTI Fabric Sofa L-Shape",
    productSku: "ZNT-FSL-010",
    invoiceNo: "INV-2602-055",
    purchaseDate: "2026-02-28",
    issueDescription: "Fabric pilling extensively on seat cushions after 5 weeks. Replacement cushion covers being prepared.",
    photoUrls: [],
    assignedTo: "SHAWN",
    salesPerson: "STANLEY",
    supplierName: "Texchem Fabrics (M) Sdn Bhd",
    resolution: "Replacement cushion covers — upgraded fabric grade at no charge",
    slaDeadline: "2026-04-14",
    createdAt: "2026-04-07T13:00:00.000Z",
    updatedAt: "2026-04-12T16:30:00.000Z",
    timeline: [
      {
        id: "tl-006-a",
        caseId: "assr-seed-006",
        timestamp: "2026-04-07T13:00:00.000Z",
        action: "Case created",
        user: "SHAWN",
      },
      {
        id: "tl-006-b",
        caseId: "assr-seed-006",
        timestamp: "2026-04-10T09:30:00.000Z",
        action: "Status changed to Pending Solution",
        user: "SHAWN",
        notes: "Fabric defect confirmed. Negotiating upgraded replacement with supplier.",
      },
      {
        id: "tl-006-c",
        caseId: "assr-seed-006",
        timestamp: "2026-04-12T16:30:00.000Z",
        action: "Status changed to Pending Delivery",
        user: "SHAWN",
        notes: "Replacement covers ready. Scheduling delivery to customer.",
      },
    ],
    source: "INTERNAL",
    // Google Sheet fields
    salesOrderNo: "SO-002110",
    refNo: "HC3105",
    complainedDate: "2026-04-07",
    location: "KL",
    deliveryOrderNo: "DO-002088",
    doDeliveredDate: "2026-03-02",
    serviceCategory: "SERVICE_IN_EXTERNAL_INHOUSE",
    itemDetails: "Fabric cushion covers (L-Shape) x5 — upgraded grade",
    actionTakenLogs: [
      { id: "at-006-1", date: "2026-04-08", text: "Fabric pilling defect confirmed. Contacted supplier for replacement" },
      { id: "at-006-2", date: "2026-04-10", text: "Negotiated upgraded fabric grade at no charge as goodwill" },
      { id: "at-006-3", date: "2026-04-12", text: "Replacement covers produced with upgraded fabric. Ready for delivery" },
    ],
    actionRemark: "Upgraded fabric grade FOC — goodwill for VIP customer",
    poNo: "PO1875",
    linkRef: "ASSR-2604-001",
    address1: "32, Jalan Taman Melawati",
    address2: "53100 KL",
    supplierServiceNote: "Texchem confirmed fabric batch defect. Upgraded grade supplied.",
  },
  {
    id: "assr-seed-007",
    caseNo: "ASSR-2604-007",
    status: "COMPLETED",
    priority: "MEDIUM",
    category: "OTHERS",
    brand: "DUNLOPILLO",
    customerName: "Lee Kah Yee",
    customerPhone: "+60161234567",
    customerEmail: "kahyee.lee@outlook.com",
    customerAddress: "7, Jalan USJ 6/6E, 47610 Subang Jaya, Selangor",
    productName: "DUNLOPILLO Firmrest Mattress Single",
    productSku: "DNP-FRS-002",
    invoiceNo: "INV-2603-098",
    purchaseDate: "2026-03-25",
    issueDescription: "Customer complained mattress firmness not as expected — feels softer than showroom sample. After inspection, confirmed within spec. Offered comfort topper as goodwill.",
    photoUrls: [],
    assignedTo: "CHEA HUAN",
    salesPerson: "KINGSLEY",
    resolution: "Provided complimentary comfort topper. Customer satisfied.",
    internalNotes: "Firmness within normal tolerance. Goodwill gesture approved by GM.",
    createdAt: "2026-04-01T09:00:00.000Z",
    updatedAt: "2026-04-10T11:00:00.000Z",
    completedAt: "2026-04-10T11:00:00.000Z",
    timeline: [
      {
        id: "tl-007-a",
        caseId: "assr-seed-007",
        timestamp: "2026-04-01T09:00:00.000Z",
        action: "Case created",
        user: "CHEA HUAN",
      },
      {
        id: "tl-007-b",
        caseId: "assr-seed-007",
        timestamp: "2026-04-05T14:00:00.000Z",
        action: "Status changed to Under Verification",
        user: "CHEA HUAN",
        notes: "Scheduled on-site inspection.",
      },
      {
        id: "tl-007-c",
        caseId: "assr-seed-007",
        timestamp: "2026-04-10T11:00:00.000Z",
        action: "Case completed",
        user: "CHEA HUAN",
        notes: "Customer accepted comfort topper. Case closed.",
      },
    ],
    source: "PORTAL",
    // Google Sheet fields
    salesOrderNo: "SO-003890",
    refNo: "HC4980",
    complainedDate: "2026-04-01",
    location: "SELANGOR",
    deliveryOrderNo: "DO-003860",
    doDeliveredDate: "2026-03-27",
    serviceCategory: "OTHERS",
    itemDetails: "DUNLOPILLO Firmrest Single x1 + complimentary comfort topper",
    actionTakenLogs: [
      { id: "at-007-1", date: "2026-04-05", text: "On-site inspection scheduled with customer" },
      { id: "at-007-2", date: "2026-04-08", text: "Inspection confirmed firmness within spec. Proposed comfort topper as goodwill" },
      { id: "at-007-3", date: "2026-04-10", text: "Comfort topper dispatched. Customer satisfied, case closed" },
    ],
    goodsReturnedNote: "N/A — no return, goodwill topper dispatched 10/04/2026",
    address1: "7, Jalan USJ 6/6E",
    address2: "47610 Subang Jaya",
    address3: "Selangor",
  },
  {
    id: "assr-seed-008",
    caseNo: "ASSR-2604-008",
    status: "CANCELLED",
    priority: "LOW",
    category: "OTHERS",
    brand: "ERGOTEX",
    customerName: "Chong Wei Lun",
    customerPhone: "+60142345678",
    customerEmail: "weilun.chong@gmail.com",
    customerAddress: "15-3, Pangsapuri Desa Mentari, 46150 Petaling Jaya, Selangor",
    productName: "ERGOTEX Memory Foam Pillow",
    productSku: "EGT-MFP-001",
    invoiceNo: "INV-2604-005",
    purchaseDate: "2026-04-02",
    issueDescription: "Customer initially reported chemical smell from new pillow. Advised to air out for 48 hours. Customer confirmed smell dissipated and withdrew complaint.",
    photoUrls: [],
    assignedTo: "YANG",
    salesPerson: "KINGSLEY",
    resolution: "Customer withdrew complaint after airing out product.",
    createdAt: "2026-04-04T16:00:00.000Z",
    updatedAt: "2026-04-06T10:00:00.000Z",
    timeline: [
      {
        id: "tl-008-a",
        caseId: "assr-seed-008",
        timestamp: "2026-04-04T16:00:00.000Z",
        action: "Case created",
        user: "YANG",
        notes: "Customer unhappy with chemical odour from new pillow.",
      },
      {
        id: "tl-008-b",
        caseId: "assr-seed-008",
        timestamp: "2026-04-06T10:00:00.000Z",
        action: "Case cancelled",
        user: "YANG",
        notes: "Customer confirmed issue resolved after airing. Complaint withdrawn.",
      },
    ],
    source: "INTERNAL",
    // Google Sheet fields
    salesOrderNo: "SO-004050",
    refNo: "HC5488",
    complainedDate: "2026-04-04",
    location: "SELANGOR",
    serviceCategory: "OTHERS",
    itemDetails: "ERGOTEX Memory Foam Pillow x1",
    actionTakenLogs: [
      { id: "at-008-1", date: "2026-04-04", text: "Advised customer to air out pillow for 48 hours" },
      { id: "at-008-2", date: "2026-04-06", text: "Customer confirmed smell dissipated. Complaint withdrawn" },
    ],
  },
];

// ─── localStorage persistence — Cases ────────────────────────────────────────

const K_CASES = "houzs_assr_cases";
const K_SUPPLIERS = "houzs_assr_suppliers";
let casesListeners: (() => void)[] = [];
let suppliersListeners: (() => void)[] = [];

function migrateCaseData(c: any): ASSRCase {
  // Migrate old string actionTaken/callLog → LogEntry[] arrays
  if (typeof c.actionTaken === "string" && c.actionTaken && !c.actionTakenLogs) {
    c.actionTakenLogs = [{ id: uid(), date: c.updatedAt?.split("T")[0] || new Date().toISOString().split("T")[0], text: c.actionTaken }];
  }
  if (typeof c.callLog === "string" && c.callLog && !c.callLogs) {
    c.callLogs = [{ id: uid(), date: c.updatedAt?.split("T")[0] || new Date().toISOString().split("T")[0], text: c.callLog }];
  }
  delete c.actionTaken;
  delete c.callLog;
  // Migrate removed PENDING_REVIEW status → UNDER_VERIFICATION
  if (c.status === "PENDING_REVIEW") c.status = "UNDER_VERIFICATION";
  // Ensure timeline is always an array
  if (!Array.isArray(c.timeline)) c.timeline = [];
  return c as ASSRCase;
}

function readCases(): ASSRCase[] {
  if (typeof window === "undefined") return seedCases;
  const raw = localStorage.getItem(K_CASES);
  if (!raw) { localStorage.setItem(K_CASES, JSON.stringify(seedCases)); return seedCases; }
  try {
    const parsed: any[] = JSON.parse(raw);
    // Check if data needs migration (old format had actionTaken as string)
    const needsMigration = parsed.some((c: any) => typeof c.actionTaken === "string" || typeof c.callLog === "string" || c.status === "PENDING_REVIEW");
    if (needsMigration) {
      const migrated = parsed.map(migrateCaseData);
      localStorage.setItem(K_CASES, JSON.stringify(migrated));
      return migrated;
    }
    return parsed;
  } catch { return seedCases; }
}

let cachedCases: ASSRCase[] | null = null;

function writeCases(cases: ASSRCase[]) {
  cachedCases = cases;
  localStorage.setItem(K_CASES, JSON.stringify(cases));
  casesListeners.forEach((fn) => fn());
}

function subscribeCases(fn: () => void) {
  casesListeners.push(fn);
  return () => { casesListeners = casesListeners.filter((l) => l !== fn); };
}

function getCasesSnapshot(): ASSRCase[] {
  if (!cachedCases) cachedCases = readCases();
  return cachedCases;
}

// ─── localStorage persistence — Suppliers ────────────────────────────────────

function readSuppliers(): ASSRSupplier[] {
  if (typeof window === "undefined") return seedSuppliers;
  const raw = localStorage.getItem(K_SUPPLIERS);
  if (!raw) { localStorage.setItem(K_SUPPLIERS, JSON.stringify(seedSuppliers)); return seedSuppliers; }
  try { return JSON.parse(raw); } catch { return seedSuppliers; }
}

let cachedSuppliers: ASSRSupplier[] | null = null;

function writeSuppliers(suppliers: ASSRSupplier[]) {
  cachedSuppliers = suppliers;
  localStorage.setItem(K_SUPPLIERS, JSON.stringify(suppliers));
  suppliersListeners.forEach((fn) => fn());
}

function subscribeSuppliers(fn: () => void) {
  suppliersListeners.push(fn);
  return () => { suppliersListeners = suppliersListeners.filter((l) => l !== fn); };
}

function getSuppliersSnapshot(): ASSRSupplier[] {
  if (!cachedSuppliers) cachedSuppliers = readSuppliers();
  return cachedSuppliers;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useASSRCases(): ASSRCase[] {
  return useSyncExternalStore(subscribeCases, getCasesSnapshot, () => seedCases);
}

export function useASSRSuppliers(): ASSRSupplier[] {
  return useSyncExternalStore(subscribeSuppliers, getSuppliersSnapshot, () => seedSuppliers);
}

// ─── Case number generation ──────────────────────────────────────────────────

export function generateCaseNo(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `ASSR-${yy}${mm}-`;
  const all = readCases();
  const existing = all
    .filter((c) => c.caseNo.startsWith(prefix))
    .map((c) => {
      const seq = parseInt(c.caseNo.slice(prefix.length), 10);
      return isNaN(seq) ? 0 : seq;
    });
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}

// ─── Case mutations ──────────────────────────────────────────────────────────

export function addCase(c: Omit<ASSRCase, "id">): string {
  const id = uid();
  const all = readCases();
  all.push({ ...c, id });
  writeCases(all);
  return id;
}

export function updateCase(id: string, patch: Partial<ASSRCase>) {
  const all = readCases();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
  writeCases(all);
}

export function removeCase(id: string) {
  const all = readCases().filter((c) => c.id !== id);
  writeCases(all);
}

export function addTimelineEntry(
  caseId: string,
  entry: Omit<TimelineEntry, "id" | "caseId">,
) {
  const all = readCases();
  const idx = all.findIndex((c) => c.id === caseId);
  if (idx < 0) return;
  const newEntry: TimelineEntry = { ...entry, id: uid(), caseId };
  all[idx] = {
    ...all[idx],
    timeline: [...all[idx].timeline, newEntry],
    updatedAt: new Date().toISOString(),
  };
  writeCases(all);
}

/** Change case to ANY target status (flexible, non-linear workflow) */
export function changeCaseStatus(
  caseId: string,
  targetStatus: CaseStatus,
  user: string,
  notes?: string,
) {
  const all = readCases();
  const idx = all.findIndex((c) => c.id === caseId);
  if (idx < 0) return;

  const current = all[idx];
  if (current.status === targetStatus) return;

  const now = new Date().toISOString();

  const timelineEntry: TimelineEntry = {
    id: uid(),
    caseId,
    timestamp: now,
    action: `Status changed to ${CASE_STATUS_LABELS[targetStatus]}`,
    user,
    notes,
  };

  all[idx] = {
    ...current,
    status: targetStatus,
    updatedAt: now,
    completedAt: targetStatus === "COMPLETED" ? now : current.completedAt,
    timeline: [...current.timeline, timelineEntry],
  };
  writeCases(all);
}

// ─── Supplier mutations ──────────────────────────────────────────────────────

export function addSupplier(s: Omit<ASSRSupplier, "id">): string {
  const id = uid();
  const all = readSuppliers();
  all.push({ ...s, id });
  writeSuppliers(all);
  return id;
}

export function updateSupplier(id: string, patch: Partial<ASSRSupplier>) {
  const all = readSuppliers();
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  writeSuppliers(all);
}

export function removeSupplier(id: string) {
  const all = readSuppliers().filter((s) => s.id !== id);
  writeSuppliers(all);
}

// ─── Reset ───────────────────────────────────────────────────────────────────

export function resetASSRData() {
  cachedCases = null;
  cachedSuppliers = null;
  localStorage.removeItem(K_CASES);
  localStorage.removeItem(K_SUPPLIERS);
  casesListeners.forEach((fn) => fn());
  suppliersListeners.forEach((fn) => fn());
}
