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
}

export interface AssrCase {
  id: number;
  assr_no: string;
  status: string;
  doc_no: string;
  complained_date: string | null;
  customer_name: string | null;
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
  addr1: string | null;
  addr2: string | null;
  addr3: string | null;
  addr4: string | null;
  created_at: string;
  updated_at: string;
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

export interface AssrSummary {
  total: number;
  by_status: Array<{ status: string; count: number }>;
  by_location: Array<{ location: string; count: number }>;
  by_category: Array<{ name: string; count: number }>;
  recent_30d: number;
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
export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role_id: number;
  role_name: string;
  status: string;
  permissions: string[];
}

export interface TeamMember {
  id: number;
  email: string;
  name: string | null;
  status: "invited" | "active" | "disabled";
  role_id: number;
  role_name: string;
  invited_at: string | null;
  joined_at: string | null;
  last_login_at: string | null;
  created_at: string;
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
  id: number;
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
}
