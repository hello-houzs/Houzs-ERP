// Shared types + status-display logic for the ported 2990's Manufacturing
// Sales Orders pages (list + detail). READ-ONLY: these mirror the snake_case
// shapes the Hono route at /api/scm/mfg-sales-orders returns. SEND camelCase,
// READ snake_case (the repo-wide pg convention).

// ── Status display ─────────────────────────────────────────────────────
// The SO status enum's raw values stay; only display labels map. 2990's
// relabels CONFIRMED→Confirmed, IN_PRODUCTION→Proceed, READY_TO_SHIP→Stock
// Ready, SHIPPED→Arranged, etc.
const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: "Confirmed",
  IN_PRODUCTION: "Proceed",
  READY_TO_SHIP: "Stock Ready",
  SHIPPED: "Arranged",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  CLOSED: "Closed",
  ON_HOLD: "On Hold",
  CANCELLED: "Cancelled",
  RETURNED: "Delivery Return",
};

export function soStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? (status ?? "").replace(/_/g, " ");
}

export type DeliveryState = "none" | "partial" | "full";
export type SoLifecycle = "none" | "delivered" | "invoiced" | "returned";

const TERMINAL = new Set(["CANCELLED", "CLOSED", "ON_HOLD"]);

export interface SoStatusDisplay {
  // null => caller falls back to soStatusLabel(status).
  label: string | null;
  // classKey is fed to scmStatusClasses() for the pill colour.
  classKey: string;
}

// Document-driven status (latest event wins). Mirrors 2990's so-status.ts:
// terminal operator states win; else lifecycle (returned/invoiced/delivered)
// drives the badge; else the stored status shows as-is.
export function soStatusDisplay(
  status: string,
  deliveryState?: DeliveryState,
  lifecycleState?: SoLifecycle,
): SoStatusDisplay {
  if (TERMINAL.has(status)) return { label: null, classKey: status };

  switch (lifecycleState) {
    case "returned":
      return { label: "Delivery Return", classKey: "RETURNED" };
    case "invoiced":
      return { label: "Invoiced", classKey: "INVOICED" };
    case "delivered":
      if (deliveryState === "partial")
        return { label: "Partially Delivered", classKey: "SHIPPED" };
      return { label: "Delivered", classKey: "DELIVERED" };
    default:
      break;
  }

  if (deliveryState === "partial")
    return { label: "Partially Delivered", classKey: "SHIPPED" };
  if (deliveryState === "full") return { label: "Delivered", classKey: "DELIVERED" };

  return { label: null, classKey: status };
}

// ── List row shape ─────────────────────────────────────────────────────
// GET /api/scm/mfg-sales-orders → { salesOrders: SoRow[] }. Reads the
// mfg_sales_orders_with_payment_totals view (HEADER cols) + proceeded_at,
// paid_total_centi, balance_centi_live, then the route enriches each row
// with the derived fields below (first-item branding, stock readiness,
// distinct payment methods, lifecycle/delivery state, current doc no).
export interface SoRow {
  doc_no: string;
  so_date: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  po_doc_no: string | null;
  venue: string | null;
  customer_so_no: string | null;
  salesperson_id: string | null;
  currency: string;
  status: string;
  local_total_centi: number;
  balance_centi?: number | null;
  balance_centi_live?: number | null;
  paid_total_centi?: number | null;
  paid_centi?: number | null;
  deposit_centi?: number | null;
  payment_method?: string | null;
  // Per-category revenue (header rollup).
  mattress_sofa_centi?: number;
  bedframe_centi?: number;
  accessories_centi?: number;
  others_centi?: number;
  // Route-enriched fields.
  first_item_category?: string | null;
  first_item_branding?: string | null;
  item_categories?: string[];
  stock_remark?: string;
  is_main_ready?: boolean;
  payment_methods_summary?: string;
  has_children?: boolean;
  has_undelivered?: boolean;
  delivery_state?: DeliveryState;
  lifecycle_state?: SoLifecycle;
  current_doc_no?: string | null;
}

// ── Detail header shape ────────────────────────────────────────────────
// GET /api/scm/mfg-sales-orders/:docNo → { salesOrder, items, pwpCodes }.
// salesOrder is the full HEADER plus proceeded_at + the detail-only rollups
// (has_children, customer_credit_centi, paid_centi_total, recomputed
// balance_centi, delivery_state, lifecycle_state, current_doc_no).
export interface SoHeader {
  doc_no: string;
  so_date: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  po_doc_no: string | null;
  venue: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  customer_so_no: string | null;
  customer_po: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  customer_country: string | null;
  ship_to_address: string | null;
  bill_to_address: string | null;
  install_to_address: string | null;
  currency: string;
  status: string;
  note: string | null;
  remark2: string | null;
  remark3: string | null;
  remark4: string | null;
  processing_date: string | null;
  proceeded_at: string | null;
  so_date_iso?: string | null;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  target_date: string | null;
  payment_method: string | null;
  installment_months: number | null;
  merchant_provider: string | null;
  // Money rollups.
  local_total_centi: number;
  total_cost_centi: number;
  total_revenue_centi: number;
  total_margin_centi: number;
  margin_pct_basis: number;
  mattress_sofa_centi: number;
  bedframe_centi: number;
  accessories_centi: number;
  others_centi: number;
  mattress_sofa_cost_centi?: number;
  bedframe_cost_centi?: number;
  accessories_cost_centi?: number;
  others_cost_centi?: number;
  deposit_centi: number | null;
  delivery_fee_centi?: number | null;
  line_count: number;
  // Detail-only rollups.
  has_children?: boolean;
  customer_credit_centi?: number;
  paid_centi_total?: number;
  balance_centi?: number;
  delivery_state?: DeliveryState;
  lifecycle_state?: SoLifecycle;
  current_doc_no?: string | null;
  created_at?: string | null;
  created_by?: string | null;
}

// Per-line delivery breakdown the detail route attaches to each item.
export interface SoLineDelivery {
  doNumber: string;
  qty: number;
  status: string;
}

// Line item shape (ITEM cols + the per-line delivery/coverage rollups the
// detail route stamps). `variants` is the sofa-build / spec source of truth;
// description2 is the stored one-line spec summary.
export interface SoItem {
  id: string;
  doc_no: string;
  line_date: string | null;
  item_group: string | null;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string | null;
  location: string | null;
  qty: number | null;
  unit_price_centi: number;
  discount_centi: number | null;
  total_centi: number;
  tax_centi: number | null;
  total_inc_centi: number | null;
  balance_centi: number | null;
  payment_status: string | null;
  venue: string | null;
  branding: string | null;
  remark: string | null;
  cancelled: boolean;
  variants: Record<string, unknown> | null;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  line_margin_centi: number | null;
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean | null;
  photo_urls: unknown;
  stock_status: string | null;
  created_at: string | null;
  // Detail-route rollups.
  deliveries?: SoLineDelivery[];
  delivered_qty?: number;
  remaining_qty?: number;
  stock_state?: string | null;
  coverage_po?: string | null;
  coverage_eta?: string | null;
}

// Payment ledger row — GET /api/scm/mfg-sales-orders/:docNo/payments →
// { payments }. collected_by_name is flattened from the staff join.
export interface SoPayment {
  id: string;
  so_doc_no: string;
  paid_at: string | null;
  method: string;
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_centi: number;
  account_sheet: string | null;
  slip_key: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
  note: string | null;
  created_at: string | null;
}

// Method label for the payment ledger — mirrors the list route's labelling:
// cash→Cash, merchant→Card, transfer→online_type (or Transfer),
// installment→Installment.
export function paymentMethodLabel(p: SoPayment): string {
  const m = (p.method ?? "").trim().toLowerCase();
  if (m === "cash") return "Cash";
  if (m === "merchant") return "Card";
  if (m === "transfer")
    return p.online_type && p.online_type.trim() ? p.online_type.trim() : "Transfer";
  if (m === "installment") return "Installment";
  return p.method || "—";
}

// One-line readable spec summary for a line. Best-effort: prefer the stored
// description2; else compose a "Key: Value" string from the variants object
// (the sofa-build / spec source of truth). We do NOT re-run 2990's pricing
// engine — this is display only.
const VARIANT_KEY_LABELS: Record<string, string> = {
  gap: "Gap",
  legHeight: "Leg Height",
  fabricCode: "Fabric",
  colorCode: "Fabric",
  divanHeight: "Divan Height",
  totalHeight: "Total Height",
  seatHeight: "Seat Height",
  specials: "Specials",
};

function camelToTitle(s: string): string {
  if (!s) return s;
  const spaced = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatVariantValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return String(v);
}

export function variantSummary(variants: Record<string, unknown> | null): string {
  if (!variants || typeof variants !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(variants)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    parts.push(`${VARIANT_KEY_LABELS[k] ?? camelToTitle(k)}: ${formatVariantValue(v)}`);
  }
  return parts.join(" · ");
}

// The readable Description 2 for a line: stored description2, else a live
// summary composed from variants.
export function lineSpecSummary(it: SoItem): string {
  const stored = (it.description2 ?? "").trim();
  if (stored) return stored;
  return variantSummary(it.variants);
}
