export type Region = "WEST" | "EAST" | "SG";
export type SyncStatus = "SYNCED" | "ERROR";

export interface SalesOrder {
  id: number;
  doc_no: string;
  region: Region;
  transfer_to: string | null;
  doc_date: string | null;
  ref: string | null;
  branding: string | null;
  debtor_name: string | null;
  phone: string | null;
  sales_location: string | null;
  sales_agent: string | null;
  local_total: number;
  balance: number;
  remark2: string | null;
  remark3: string | null;
  remark4: string | null;
  processing_date: string | null;
  expiry_date: string | null;
  note: string | null;
  po_doc_no: string | null;
  inv_addr1: string | null;
  inv_addr2: string | null;
  inv_addr3: string | null;
  inv_addr4: string | null;
  venue: string | null;
  attention: string | null;
  sync_status: SyncStatus;
  sync_error: string | null;
  last_modified: string | null;
  created_at: string;
  updated_at: string;
  // joined from order_details
  delivery_date?: string | null;
  time_range?: string | null;
  lorry_plate?: string | null;
  driver_name?: string | null;
  driver_contact?: string | null;
  property_type?: string | null;
  consignment_no?: string | null;
  eta_port?: string | null;
  estimate_delivery?: string | null;
  shipout_date?: string | null;
}

export interface OrderDetails {
  doc_no: string;
  delivery_date: string | null;
  time_range: string | null;
  time_confirmed: string | null;
  lorry_plate: string | null;
  driver_name: string | null;
  driver_contact: string | null;
  days_left: string | null;
  internal_purchasing: string | null;
  property_type: string | null;
  new_house_replacement: string | null;
  item_details: string | null;
  done_delivery: string | null;
  consignment_no: string | null;
  eta_port: string | null;
  estimate_delivery: string | null;
  m3: string | null;
  vessel_voyage: string | null;
  etd_port_klang: string | null;
  eta_destination: string | null;
  transporter_remarks: string | null;
  seafreight: number | null;
  local_charges: number | null;
  inland: number | null;
  agent_fee: number | null;
  insurance: number | null;
  total_cost: number | null;
  shipout_date: string | null;
}

export interface PurchaseOrder {
  id: number;
  doc_no: string;
  so_doc_no: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  item_code: string;
  item_description: string | null;
  location: string | null;
  doc_date: string | null;
  remaining_qty: number | null;
  delivery_date: string | null;
  supplier_date1: string | null;
  supplier_date2: string | null;
  supplier_date3: string | null;
  overdue_days: string | null;
  // Cost fields used by P&L. amount_source distinguishes 'sync' (from
  // AutoCount payload) vs 'manual' (typed by a user) so the next sync
  // knows whether to overwrite. (Line-level amounts only — doc totals
  // live on PurchaseOrderDoc.)
  unit_price?: number | null;
  amount?: number | null;
  amount_source?: string | null;
  amount_updated_at?: string | null;
  amount_updated_by?: number | null;
}

/**
 * Creditor (procurement supplier) mirrored locally from AutoCount
 * /Creditor/getAll. Read-only — AutoCount is the system of record.
 * po_count / open_po_count / total_local_ex_tax come from a join
 * against purchase_order_docs in the list endpoint.
 */
export interface Creditor {
  creditor_code: string;
  company_name: string | null;
  desc2: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  post_code: string | null;
  deliver_address1: string | null;
  deliver_address2: string | null;
  deliver_address3: string | null;
  deliver_address4: string | null;
  deliver_post_code: string | null;
  attention: string | null;
  phone1: string | null;
  phone2: string | null;
  mobile: string | null;
  fax1: string | null;
  fax2: string | null;
  email: string | null;
  web_url: string | null;
  contact_info: string | null;
  nature_of_business: string | null;
  currency_code: string | null;
  display_term: string | null;
  rounding_method: string | null;
  inclusive_tax: number | null;
  price_category: string | null;
  statement_type: string | null;
  aging_on: string | null;
  credit_limit: number | null;
  overdue_limit: number | null;
  tax_code: string | null;
  tax_register_no: string | null;
  gst_register_no: string | null;
  sst_register_no: string | null;
  self_billed_approval_no: string | null;
  exempt_no: string | null;
  exempt_expiry_date: string | null;
  register_no: string | null;
  gst_status_verified_date: string | null;
  area_code: string | null;
  area_description: string | null;
  area_desc2: string | null;
  type: string | null;
  type_description: string | null;
  type_desc2: string | null;
  purchase_agent: string | null;
  purchase_agent_description: string | null;
  parent_acc_no: string | null;
  note: string | null;
  last_modified: string | null;
  last_modified_user_id: string | null;
  created_timestamp: string | null;
  created_user_id: string | null;
  is_active: number;
  raw: string | null;
  created_at: string;
  updated_at: string;
  // Joined aggregates from purchase_order_docs:
  po_count?: number;
  open_po_count?: number;
  total_local_ex_tax?: number;
}

export interface CreditorSummary {
  totals: {
    total: number;
    currency_count: number;
    type_count: number;
  };
  top_by_spend: Array<{
    creditor_code: string;
    creditor_name: string;
    po_count: number;
    total_spend: number;
  }>;
}

/**
 * Doc-level Purchase Order from /api/po/docs (mirrors AutoCount
 * /PurchaseOrder/getAll). One row per PO header — the source of truth
 * for cost roll-ups (P&L) and the "Documents" view.
 */
export interface PurchaseOrderDoc {
  doc_no: string;
  doc_date: string | null;
  ref: string | null;
  so_doc_no: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  purchase_location: string | null;
  doc_status: string | null;
  cancelled: number;
  local_ex_tax: number | null;
  local_tax: number | null;
  local_net_total: number | null;
  final_total: number | null;
  currency_code: string | null;
  currency_rate: number | null;
  remark1: string | null;
  remark2: string | null;
  remark3: string | null;
  remark4: string | null;
  note: string | null;
  last_modified: string | null;
  amount_source: string | null;
  amount_updated_at: string | null;
  amount_updated_by: number | null;
  /** Full AutoCount /PurchaseOrder/getAll payload as a JSON string. */
  raw: string | null;
  created_at: string;
  updated_at: string;
}

// v3.1 9-stage workflow (backend mig 074). Stage names mirror the SQL
// enum. The legacy 6-stage vocabulary is no longer accepted by writes.
export type AssrStage =
  | "pending_review"
  | "under_verification"
  | "pending_solution"
  | "pending_inspection"
  | "pending_item_pickup"
  | "pending_supplier_pickup"
  | "pending_item_ready"
  | "pending_delivery_service"
  | "completed";
export type ResolutionMethod = "replace_unit" | "supplier_repair" | "field_service_own" | "field_service_supplier" | "return_visit";

export interface AssrCase {
  id: number;
  assr_no: string;
  status: string;
  stage: AssrStage;
  doc_no: string;
  complained_date: string | null;
  customer_name: string | null;
  customer_email: string | null;
  phone: string | null;
  location: string | null;
  sales_agent: string | null;
  item_code: string | null;
  complaint_issue: string | null;
  action_remark: string | null;
  service_category: string | null;
  supplier: string | null;
  completion_date: string | null;
  po_no: string | null;
  resolution_method: ResolutionMethod | null;
  issue_category: string | null;
  priority: string;
  assigned_to: number | null;
  assigned_to_name?: string | null;
  ref_no: string | null;
  delivery_order: string | null;
  do_date: string | null;
  closed_at: string | null;
  created_by: number | null;
  created_by_name?: string | null;
  satisfaction_rating: number | null;
  satisfaction_notes: string | null;
  // AutoCount-derived creditor (procurement supplier). Auto-resolved
  // from the case's item_code via StockItem.MainSupplier.
  creditor_code?: string | null;
  creditor_name?: string | null;
  creditor_email?: string | null;
  creditor_phone?: string | null;
  creditor_mobile?: string | null;
  creditor_attention?: string | null;
  // QMS: manager sign-off + NCR
  approved_by?: number | null;
  approved_at?: string | null;
  approved_by_name?: string | null;
  quality_review_passed?: number | null; // 0 | 1 | null
  ncr_category?: string | null;
  // v3.1 — separate CSAT survey recipient (mig 074)
  email_for_survey?: string | null;
  inspection_result?: "pass" | "fail" | "na" | null;
  // v3.1 — per-stage lifecycle snapshots (mig 074)
  stage_entered_at?: string | null;
  stage_target_days?: number | null;
  lead_time_profile_id?: number | null;
  // QMS: cost tracking
  po_amount?: number | null;
  customer_amount?: number | null;
  supplier_invoice_ref?: string | null;
  cost_notes?: string | null;
  // SLA tracking
  sla_hours?: number | null;
  deadline_at?: string | null;
  escalated_at?: string | null;
  hours_to_deadline?: number | null; // negative = past deadline
  is_breached?: number | null;       // 0 | 1
  // Aging fields (populated on list/detail reads — computed from activity log)
  stage_since?: string | null;
  days_in_stage?: number | null;
  // Mig 064 — supplier handover + items-ready dates, plus the
  // `stage_changed_at` snapshot the new lead-time column reads.
  supplier_pickup_at?: string | null;
  items_ready_at?: string | null;
  stage_changed_at?: string | null;
  // Mig 081 — Verification card (gate between Under Verification and
  // Pending Solution). 'accepted' = real defect we'll fix, 'rejected' =
  // not-our-issue short-circuit to Completed, 'needs_more_info' = wait
  // on customer.
  verification_outcome?: "accepted" | "rejected" | "needs_more_info" | null;
  verified_root_cause?: string | null;
  verified_by?: number | null;
  verified_by_name?: string | null;
  verified_at?: string | null;
  // Soft-delete
  archived_at?: string | null;
  archived_by?: number | null;
  addr1: string | null;
  addr2: string | null;
  addr3: string | null;
  addr4: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssrItem {
  id: number;
  assr_id: number;
  item_code: string;
  item_description: string | null;
  qty: number;
}

export interface AssrAttachment {
  id: number;
  assr_id: number;
  r2_key: string;
  file_name: string | null;
  content_type: string | null;
  category:
    | "complaint"
    | "evidence"
    | "completion"
    | "signature"
    | "sign_off"
    | "inspection_report"
    | "pickup_form"
    | "ready_doc"
    | "delivery_pod";
  uploaded_by: number | null;
  created_at: string;
}

export type AssrActivityCategory = "purchasing" | "customer" | "system";

export interface AssrActivity {
  id: number;
  assr_id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name?: string | null;
  created_at: string;
  // Mig 064 — drives the timeline filter pills.
  category?: AssrActivityCategory | null;
}

export interface AssrLogistics {
  id: number;
  assr_id: number;
  type: "pickup" | "delivery";
  scheduled_date: string | null;
  scheduled_time_range: string | null;
  assigned_to: number | null;
  assigned_to_name?: string | null;
  status: string;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// v3.1 — per-stage lifecycle row. One per (case, stage) entry, in
// chronological order. The Workflow Progress Tracker walks this list.
export interface AssrStageHistoryRow {
  id: number;
  stage: AssrStage;
  entered_at: string;
  exited_at: string | null;
  target_days: number | null;
  status: "green" | "amber" | "red" | null;
  skipped: number;
  skip_reason: string | null;
  alerts_fired: number;
  snoozes_applied: number;
}

export interface AssrDetail {
  case: AssrCase;
  items: AssrItem[];
  attachments: AssrAttachment[];
  activity: AssrActivity[];
  logistics: AssrLogistics[];
  related_pos: PurchaseOrder[];
  portal_token?: string | null;
  stage_history?: AssrStageHistoryRow[];
}

export interface OverdueHistoryRow {
  id: number;
  pull_date: string;
  doc_no: string;
  debtor_name: string | null;
  phone: string | null;
  location: string | null;
  balance: number | null;
  original_expiry_date: string | null;
  extended_to: string | null;
}

/** Grouped overdue row: sales_order + extension stats */
export interface OverdueOrderRow extends SalesOrder {
  extension_count: number;
  last_extended_at: string;
  first_original_expiry: string | null;
}

export interface ExecutionLog {
  id: number;
  request_id: string;
  type: string;
  started_at: string;
  ended_at: string | null;
  status: "SYNCED" | "FAILED" | "SKIPPED";
  message: string | null;
  created_at: string;
}

export interface Paginated<T> {
  data: T[];
  page: number;
  per_page: number;
  total: number;
}

export interface OrderStats {
  by_region: Array<{ region: Region; count: number }>;
  by_status: Array<{ sync_status: SyncStatus; count: number }>;
  totals: { total_orders: number; total_balance: number };
}

export interface SyncStatusResponse {
  checkpoint: string | null;
  last_pull: ExecutionLog | null;
  last_pull_all: ExecutionLog | null;
  error_count: number;
  autocount_writes_disabled?: boolean;
}

// ──────────────────────────────────────────────────────────
// Dashboard summary payloads
// ──────────────────────────────────────────────────────────
export interface OrderSummaryBucket {
  total: number;
  by_region: Record<string, number>;
  by_status: Record<string, number>;
  total_balance: number;
  outstanding_count: number;
  expired: number;
  expiring_7d: number;
  no_expiry: number;
}

export interface OrdersSummary {
  all: OrderSummaryBucket;
  delivery: OrderSummaryBucket;
  latest_modified: string | null;
  fetched_at: string;
}

export interface POSummary {
  totals: {
    line_count: number;
    po_count: number;
    supplier_count: number;
    remaining_qty: number;
    outstanding_count?: number;
    delivered_count?: number;
    cancelled_count?: number;
  };
  overdue: number;
  missing_supplier_date: number;
  top_suppliers: Array<{ name: string; count: number }>;
}

export interface BalanceSummary {
  totals: { count: number; total: number };
  expired: { count: number; total: number };
  warning: { count: number; total: number };
  by_region: Array<{ region: Region; count: number; total: number }>;
  top_debtors: Array<{ name: string; total: number }>;
}

export interface AssrMetrics {
  since_days: number;
  headline: {
    total: number;
    closed: number;
    open_count: number;
    breached: number;
    qa_passed: number;
    avg_resolution_hours: number | null;
    avg_satisfaction: number | null;
  };
  ncr: Array<{ category: string; count: number }>;
  /** Customer-facing intake category (Product defect / Incorrect item / …). */
  issue_categories: Array<{ category: string; count: number }>;
  resolutions: Array<{ method: string; count: number }>;
  repeat_items: Array<{ item_code: string; cases: number; latest: string }>;
  repeat_customers: Array<{ customer_name: string; phone: string | null; cases: number; latest: string }>;
  creditor_performance: Array<{
    creditor_code: string;
    name: string | null;
    total_cases: number;
    closed_cases: number;
    breached: number;
    avg_rating: number | null;
    avg_resolution_hours: number | null;
  }>;
  monthly_trend: Array<{ month: string; opened: number; closed: number }>;
  /** Mirrors the legacy Excel "Case Duration" tile. All counts are *open* cases. */
  case_duration: {
    opening_count: number;
    over_1_month: number;
    over_3_weeks: number;
    over_2_weeks: number;
    /** Rolling monthly intake, last 4 months. */
    avg_per_month: number | null;
  };
}

export interface AssrSummary {
  total: number;
  by_stage: Array<{ stage: string; count: number }>;
  by_status: Array<{ status: string; count: number }>;
  by_location: Array<{ location: string; count: number }>;
  by_category: Array<{ name: string; count: number }>;
  recent_30d: number;
  aging_count: number;
  breach_count: number;
}

export interface OverdueSummary {
  totals: { count: number; total: number };
  recent_30d: number;
  by_location: Array<{ location: string; count: number; total: number }>;
  last_pull: string | null;
}

// ──────────────────────────────────────────────────────────
// Auth, users, roles
// ──────────────────────────────────────────────────────────
/**
 * Per-page access level. Mirrors backend's `AccessLevel`.
 * `none` = the page is hidden / 403; `partial` = page-specific
 * read-only or scoped view; `full` = unrestricted within the page.
 */
export type AccessLevel = "none" | "partial" | "full";

/** Page catalogue entry. Returned by GET /api/roles/pages. */
export interface PageDef {
  key: string;
  label: string;
  partialMeaning: string;
  supportsPartial: boolean;
  /** When set, this page is a sub-tab under `parent`. Used by the
   *  Roles UI to indent and to disable child radios when the parent
   *  is full/none (cascade rule). */
  parent: string | null;
}

/** Per-page access entry on a role. `explicit = true` means the
 *  level came from a `role_page_access` row; `false` means it's
 *  computed by backfill rules — i.e. inferred from the role's
 *  permissions JSON. */
export interface RolePageAccess {
  level: AccessLevel;
  explicit: boolean;
}

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role_id: number;
  role_name: string;
  status: string;
  permissions: string[];
  /**
   * Per-page access map (mig 073). Keys are stable page identifiers
   * (e.g. "sales", "projects"). Missing keys default to "none" on
   * the consuming side. Hydrated once per session at /api/auth/me.
   */
  page_access?: Record<string, AccessLevel>;
  manager_id?: number | null;
  scope_to_pic?: boolean;
  joined_at?: string | null;
  last_login_at?: string | null;
  /** R2 key for the user's profile picture (mig 058). */
  profile_pic_r2_key?: string | null;
}

export interface TeamMember {
  id: number;
  email: string;
  name: string | null;
  status: "invited" | "active" | "disabled";
  role_id: number;
  role_name: string;
  /** Who this user reports to in the org chart. null = root. */
  manager_id: number | null;
  manager_name: string | null;
  manager_email: string | null;
  /** Department grouping — orthogonal to role, purely for visibility. */
  department_id: number | null;
  department_name: string | null;
  /** 6-char hex without the leading '#'. */
  department_color: string | null;
  /**
   * Per-user brand allow-list (mig 049). Drives sales-dept project
   * visibility for users in scope_to_pic roles. Empty array when no
   * brands assigned (or role isn't sales-scoped — empty here doesn't
   * imply anything for unscoped users).
   */
  brands: string[];
  invited_at: string | null;
  joined_at: string | null;
  last_login_at: string | null;
  created_at: string;
  /** R2 key for the user's profile picture (mig 058). */
  profile_pic_r2_key: string | null;
}

export interface Department {
  id: number;
  name: string;
  description: string | null;
  /** 6-char hex without the leading '#'. */
  color: string;
  sort_order: number;
  member_count: number;
  created_at?: string;
}

export interface Invitation {
  id: number;
  email: string;
  role_id: number;
  role_name: string;
  token: string;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  invited_by_email: string | null;
}

export interface Role {
  id: number;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: boolean;
  /** When true, users with this role can only see projects where they
   *  or their manager is the PIC. Drives the sales-team ACL. */
  scope_to_pic?: boolean;
  member_count: number;
  created_at?: string;
}

export interface PermissionDef {
  key: string;
  resource: string;
  verb: "read" | "write" | "manage";
  label: string;
  description: string;
}

export interface ActiveMember {
  id: number;
  email: string;
  name: string | null;
  role_id: number;
  role_name: string;
  last_seen_at: string;
  is_self: boolean;
}

export interface PresenceResponse {
  active: ActiveMember[];
  count: number;
  window_seconds: number;
}

// ──────────────────────────────────────────────────────────
// Trips, lorries, warehouses (HC Delivery)
// ──────────────────────────────────────────────────────────

export type TripStatus = "assigned" | "started" | "in_progress" | "completed" | "cancelled";
export type TripType = "delivery" | "setup" | "dismantle" | "sg" | "mixed";
export type StopStatus = "pending" | "arrived" | "delivered" | "failed";
export type StopType = "delivery" | "service" | "pickup" | "setup" | "dismantle";

export interface Warehouse {
  code: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface Lorry {
  id: number;
  plate: string;
  size: string | null;
  warehouse: string;
  is_internal: number;
  default_driver_user_id: number | null;
  default_driver_name: string | null;
  is_active: number;
}

export interface Trip {
  id: number;
  trip_no: string;
  warehouse: string;
  trip_date: string;
  lorry_id: number | null;
  driver_user_id: number | null;
  status: TripStatus;
  trip_type: TripType;
  is_outsourced: number;
  source: "manual" | "proposal";
  proposal_id: number | null;
  started_at: string | null;
  completed_at: string | null;
  start_odometer: number | null;
  end_odometer: number | null;
  fuel_litres: number | null;
  fuel_cost: number | null;
  total_revenue: number;
  total_distance_km: number;
  stop_count: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // joined
  lorry_plate?: string | null;
  lorry_size?: string | null;
  driver_name?: string | null;
  driver_email?: string | null;
  helper_1_name?: string | null;
  helper_2_name?: string | null;
  warehouse_name?: string | null;
  // mine/today extras
  stop_count_actual?: number;
  stops_done?: number;
}

export interface TripStop {
  id: number;
  trip_id: number;
  doc_no: string;
  sequence: number;
  stop_type: StopType;
  dismantle_session: "morning" | "night" | null;
  status: StopStatus;
  arrived_at: string | null;
  completed_at: string | null;
  recipient_name: string | null;
  signature_r2_key: string | null;
  pod_photo_r2_key: string | null;
  failure_reason: string | null;
  notes: string | null;
  // joined sales_orders
  debtor_name?: string | null;
  phone?: string | null;
  local_total?: number | null;
  balance?: number | null;
  inv_addr1?: string | null;
  inv_addr2?: string | null;
  inv_addr3?: string | null;
  inv_addr4?: string | null;
  stop_lat?: number | null;
  stop_lng?: number | null;
  order_warehouse?: string | null;
  order_state?: string | null;
}

export interface TripLocation {
  lat: number;
  lng: number;
  accuracy: number | null;
  recorded_at: string;
}

export interface TripDetail {
  trip: Trip & { warehouse_lat?: number | null; warehouse_lng?: number | null };
  stops: TripStop[];
  locations: TripLocation[];
}

// ──────────────────────────────────────────────────────────
// Planner / scheduling agent
// ──────────────────────────────────────────────────────────

export interface PlannerStop {
  doc_no: string;
  sequence: number;
  debtor_name: string | null;
  lat: number;
  lng: number;
  local_total: number;
  expiry_date: string;
  reason?: string;
}

export interface PlannerTrip {
  id: number;
  proposal_id: number;
  warehouse: string;
  warehouse_name: string | null;
  warehouse_lat: number | null;
  warehouse_lng: number | null;
  trip_date: string;
  suggested_lorry_id: number | null;
  suggested_driver_user_id: number | null;
  trip_type: "delivery" | "setup" | "dismantle" | "sg" | "blocked";
  total_revenue: number;
  total_distance_km: number;
  stop_count: number;
  is_outsourced: number;
  lorry_plate: string | null;
  lorry_size: string | null;
  lorry_is_internal: number | null;
  driver_name: string | null;
  driver_email: string | null;
  payload: {
    stops: PlannerStop[];
    reason: string;
    blocked_reason?: string;
    full_route_km?: number;
    route_chain?: { label: string; lat: number; lng: number; type: string }[];
  };
}

export interface PlannerSummary {
  horizon_days: number;
  generated_at: string;
  total_trips: number;
  total_revenue: number;
  total_orders: number;
  blocked_orders: number;
  by_warehouse: Record<string, { trips: number; revenue: number }>;
  outsourced_trips: number;
}

export interface PlannerProposal {
  id: number;
  generated_at: string;
  generated_by: number | null;
  horizon_days: number;
  status: "draft" | "confirmed" | "discarded";
  summary: PlannerSummary | null;
}

// ──────────────────────────────────────────────────────────
// Events — manual setup / dismantle calendar entries
// ──────────────────────────────────────────────────────────

export type EventType = "setup" | "dismantle";

export interface CalendarEvent {
  /** Numeric ids belong to manual rows in the `events` table.
   *  Project-sourced rows use a string id like "project-42-setup" so
   *  they never collide with autoincrement values. The `source` field
   *  is the canonical signal — id type is just the implementation
   *  detail. */
  id: number | string;
  type: EventType;
  title: string;
  event_date: string;
  address: string | null;
  status: string | null;
  notes: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  /** "manual" → row in events table, fully editable here.
   *  "project" → derived from a project's setup/dismantle config,
   *  read-only at this surface (clicks navigate to the project). */
  source?: "manual" | "project";
  project_id?: number;
  project_code?: string | null;
  driver_name?: string | null;
  lorry_plate?: string | null;
  end_at?: string | null;
}

// ── Sales Team (mig 067) ─────────────────────────────────────
// Retail rep org chart, separate from the workspace `users`
// directory. A workspace user may or may not be a sales rep, and a
// sales rep may or may not have a workspace login.

export interface SalesPosition {
  id: number;
  slug: string;
  name: string;
  level: number; // 10 = Director, 20 = Executive, 30 = Sub-Executive
  sort_order: number;
  active: number;
}

export interface SalesCommissionTier {
  id: number;
  slug: string;
  name: string;
  rate: number; // percent
  sort_order: number;
  active: number;
}

export interface SalesRep {
  id: number;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  // Mig 068
  nric?: string | null;
  position_id: number | null;
  position_slug?: string | null;
  position_name?: string | null;
  position_level?: number | null;
  upline_id: number | null;
  upline_secondary_id?: number | null;
  upline_code?: string | null;
  upline_name?: string | null;
  user_id: number | null;
  user_email?: string | null;
  user_name?: string | null;
  status: "active" | "inactive";
  is_admin: number;
  commission_rate: number | null;
  commission_min_rate?: number | null;
  commission_tier_id: number | null;
  joined_on: string | null;
  notes: string | null;
  archived_at: string | null;
  brands: string[];
  team_size?: number; // populated by list endpoint
}

export interface SalesRepTier {
  id?: number;
  threshold: number; // sales threshold in RM
  rate: number; // percent
  sort_order?: number;
}

export interface SalesTeamActivity {
  id: number;
  rep_id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name?: string | null;
  created_at: string;
}
