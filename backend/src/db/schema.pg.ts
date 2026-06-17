// ---------------------------------------------------------------------------
// DRAFT - Postgres (pg-core) port of schema.ts. UNTESTED until validated with
// `drizzle-kit` against the live Supabase DB (Phase 2 of the migration).
//
// Additive: this file does NOT replace schema.ts yet, so the D1 build stays
// green. The cutover swaps client.ts to drizzle-orm/postgres-js + this schema
// and renames it over schema.ts.
//
// Faithful mapping choices (deliberately low-churn so the 600+ snake_case
// readers and 685 raw-SQL sites keep working):
//   - integer("id").primaryKey({autoIncrement:true})  -> serial(...).primaryKey()
//   - other integer(...)        -> integer(...)        (kept int4)
//   - 0/1 flag columns          -> integer(...)        (NOT boolean — app r/w 0/1)
//   - real(...)                 -> doublePrecision(...) (SQLite REAL is float8)
//   - *_at / created_at columns -> text(...)           (app reads ISO strings,
//                                  not Date objects; keep them text)
//   - default (datetime('now')) -> `nowText` (UTC text, same 'YYYY-MM-DD HH:MM:SS' shape)
//
// REVIEW BEFORE IMPORT (Phase 4): SQLite INTEGER holds int64, Postgres
// `integer` is int4 (max ~2.1e9). Money/amount columns stored in sen could
// overflow. Promote these to `bigint({mode:"number"})` if a real value
// exceeds int4 (the import will fail loudly otherwise — verify per table):
//   sales_orders.local_total/balance, order_details.total_cost + freight cols,
//   purchase_orders.amount/unit_price, purchase_order_docs.final_total/local_ex_tax,
//   project_finance.*, project_finance_lines.amount, sales_entries.amount/deposit_amount,
//   petty_cash_entries.amount_cents, project_cost_rates.boost_min_sales.
// ---------------------------------------------------------------------------
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  doublePrecision,
  primaryKey,
  uuid,
  boolean,
  jsonb,
  timestamp,
  date,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// SQLite datetime('now') yields 'YYYY-MM-DD HH:MM:SS' (UTC). Reproduce the same
// text shape so existing string parsing/sorting is unchanged.
const nowText = sql`(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`;

// ── users ──────────────────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  password_hash: text("password_hash"),
  role_id: integer("role_id").notNull(),
  status: text("status").notNull().default("invited"),
  invited_by: integer("invited_by"),
  invited_at: text("invited_at"),
  joined_at: text("joined_at"),
  last_login_at: text("last_login_at"),
  created_at: text("created_at").default(nowText),
  manager_id: integer("manager_id"),
  department_id: integer("department_id"),
  position_id: integer("position_id"),
  points_balance: integer("points_balance").notNull().default(0),
  gifting_balance: integer("gifting_balance").notNull().default(0),
  gifting_reset_at: text("gifting_reset_at"),
  current_streak: integer("current_streak").notNull().default(0),
  profile_pic_r2_key: text("profile_pic_r2_key"),
  phone: text("phone"),
});

// ── roles ──────────────────────────────────────────────────
export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  permissions: text("permissions").notNull().default("[]"),
  is_system: integer("is_system").notNull().default(0),
  scope_to_pic: integer("scope_to_pic").notNull().default(0),
  created_at: text("created_at").default(nowText),
});

// ── role_page_access (mig 073) ─────────────────────────────
export const role_page_access = pgTable(
  "role_page_access",
  {
    role_id: integer("role_id").notNull(),
    page_key: text("page_key").notNull(),
    level: text("level").notNull(),
    created_at: text("created_at").default(nowText),
    updated_at: text("updated_at").default(nowText),
  },
  (t) => ({ pk: primaryKey({ columns: [t.role_id, t.page_key] }) }),
);

// ── departments ────────────────────────────────────────────
export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  color: text("color").notNull().default("64748b"),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: text("created_at").default(nowText),
});

// ── projects ───────────────────────────────────────────────
export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  code: text("code").unique(),
  name: text("name").notNull(),
  stage: text("stage").notNull().default("draft"),
  status: text("status").notNull().default("pending"),
  start_date: text("start_date"),
  end_date: text("end_date"),
  venue: text("venue"),
  venue_address: text("venue_address"),
  brand: text("brand"),
  pic_id: integer("pic_id"),
  created_by: integer("created_by"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
  archived_at: text("archived_at"),
  setup_start_at: text("setup_start_at"),
  setup_end_at: text("setup_end_at"),
  dismantle_start_at: text("dismantle_start_at"),
  dismantle_end_at: text("dismantle_end_at"),
  setup_driver_user_id: integer("setup_driver_user_id"),
  setup_lorry_id: integer("setup_lorry_id"),
  dismantle_driver_user_id: integer("dismantle_driver_user_id"),
  dismantle_lorry_id: integer("dismantle_lorry_id"),
  setup_helper_1_id: integer("setup_helper_1_id"),
  setup_helper_2_id: integer("setup_helper_2_id"),
  setup_helper_outsourced: integer("setup_helper_outsourced").notNull().default(0),
  dismantle_helper_1_id: integer("dismantle_helper_1_id"),
  dismantle_helper_2_id: integer("dismantle_helper_2_id"),
  dismantle_helper_outsourced: integer("dismantle_helper_outsourced").notNull().default(0),
});

// ── project_phase_photos ───────────────────────────────────
export const project_phase_photos = pgTable("project_phase_photos", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  phase: text("phase").notNull(),
  r2_key: text("r2_key").notNull(),
  content_type: text("content_type"),
  caption: text("caption"),
  uploaded_by: integer("uploaded_by"),
  uploaded_at: text("uploaded_at").notNull().default(nowText),
});

// ── project_brands ─────────────────────────────────────────
export const project_brands = pgTable("project_brands", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("64748b"),
  sort_order: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

// ── user_brands (mig 049) ──────────────────────────────────
export const user_brands = pgTable(
  "user_brands",
  {
    user_id: integer("user_id").notNull(),
    brand: text("brand").notNull(),
    created_at: text("created_at").default(nowText),
  },
  (t) => ({ pk: primaryKey({ columns: [t.user_id, t.brand] }) }),
);

// ── project_activity ───────────────────────────────────────
export const project_activity = pgTable("project_activity", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  user_id: integer("user_id"),
  action: text("action").notNull(),
  from_value: text("from_value"),
  to_value: text("to_value"),
  note: text("note"),
  created_at: text("created_at").default(nowText),
  archived_at: text("archived_at"),
});

// ── project_reads (mig 045) ────────────────────────────────
export const project_reads = pgTable(
  "project_reads",
  {
    project_id: integer("project_id").notNull(),
    user_id: integer("user_id").notNull(),
    last_read_at: text("last_read_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.project_id, t.user_id] }) }),
);

// ── sessions ───────────────────────────────────────────────
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  user_id: integer("user_id").notNull(),
  expires_at: text("expires_at").notNull(),
  created_at: text("created_at").default(nowText),
});

// ── invitations ────────────────────────────────────────────
export const invitations = pgTable("invitations", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  role_id: integer("role_id").notNull(),
  token: text("token").notNull().unique(),
  invited_by: integer("invited_by").notNull(),
  expires_at: text("expires_at").notNull(),
  accepted_at: text("accepted_at"),
  created_at: text("created_at").default(nowText),
  // Org dimensions carried by the invite + applied on accept (mig 094).
  position_id: integer("position_id"),
  department_id: integer("department_id"),
  manager_id: integer("manager_id"),
});

// ── positions (mig 094) — staff org unit (department × position) ──
export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  department_id: integer("department_id"),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  level: integer("level").notNull().default(100),
  sort_order: integer("sort_order").notNull().default(100),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

// ── position_page_access (mig 094) — 4-level matrix (none/view/edit/full) ──
export const position_page_access = pgTable(
  "position_page_access",
  {
    position_id: integer("position_id").notNull(),
    page_key: text("page_key").notNull(),
    level: text("level").notNull(),
    created_at: text("created_at").default(nowText),
    updated_at: text("updated_at").default(nowText),
  },
  (t) => ({ pk: primaryKey({ columns: [t.position_id, t.page_key] }) }),
);

// ── password_resets (mig 027) ──────────────────────────────
export const password_resets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull(),
  token: text("token").notNull().unique(),
  requested_by: integer("requested_by"),
  expires_at: text("expires_at").notNull(),
  consumed_at: text("consumed_at"),
  created_at: text("created_at").default(nowText),
});

// ── events ─────────────────────────────────────────────────
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  event_date: text("event_date").notNull(),
  address: text("address"),
  status: text("status"),
  notes: text("notes"),
  created_by: integer("created_by"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
});

// ── lorries ────────────────────────────────────────────────
export const lorries = pgTable("lorries", {
  id: serial("id").primaryKey(),
  plate: text("plate").notNull(),
  size: text("size"),
  default_driver_user_id: integer("default_driver_user_id"),
});

// ── warehouses ─────────────────────────────────────────────
export const warehouses = pgTable("warehouses", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
});

// ── trips ──────────────────────────────────────────────────
export const trips = pgTable("trips", {
  id: serial("id").primaryKey(),
  driver_user_id: integer("driver_user_id"),
  lorry_id: integer("lorry_id"),
  warehouse: text("warehouse"),
  trip_date: text("trip_date").notNull(),
  status: text("status").notNull(),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
});

// ── trip_stops ─────────────────────────────────────────────
export const trip_stops = pgTable("trip_stops", {
  id: serial("id").primaryKey(),
  trip_id: integer("trip_id").notNull(),
  sequence: integer("sequence").notNull(),
  status: text("status").notNull(),
  pod_photo_r2_key: text("pod_photo_r2_key"),
  signature_r2_key: text("signature_r2_key"),
  updated_at: text("updated_at").default(nowText),
});

// ── trip_locations ─────────────────────────────────────────
export const trip_locations = pgTable("trip_locations", {
  id: serial("id").primaryKey(),
  trip_id: integer("trip_id").notNull(),
  lat: integer("lat").notNull(),
  lng: integer("lng").notNull(),
  accuracy: integer("accuracy"),
  recorded_at: text("recorded_at").notNull(),
});

// ── lorry_incidents ────────────────────────────────────────
export const lorry_incidents = pgTable("lorry_incidents", {
  id: serial("id").primaryKey(),
  trip_id: integer("trip_id"),
});

// ── salary_trip_lines ──────────────────────────────────────
export const salary_trip_lines = pgTable("salary_trip_lines", {
  id: serial("id").primaryKey(),
  trip_id: integer("trip_id").notNull(),
});

// ── sales_orders ───────────────────────────────────────────
export const sales_orders = pgTable("sales_orders", {
  doc_no: text("doc_no").primaryKey(),
  doc_date: text("doc_date"),
  ref: text("ref"),
  branding: text("branding"),
  debtor_name: text("debtor_name"),
  phone: text("phone"),
  sales_location: text("sales_location"),
  sales_agent: text("sales_agent"),
  region: text("region"),
  local_total: integer("local_total"),
  balance: integer("balance"),
  remark2: text("remark2"),
  remark3: text("remark3"),
  remark4: text("remark4"),
  processing_date: text("processing_date"),
  expiry_date: text("expiry_date"),
  po_doc_no: text("po_doc_no"),
  venue: text("venue"),
  attention: text("attention"),
  last_modified: text("last_modified"),
  sync_status: text("sync_status"),
  updated_at: text("updated_at"),
  // Houzs-side recipient for auto-sent DO/invoice email; AutoCount debtor sync
  // carries no email, so this is maintained manually (mig 098/0009).
  customer_email: text("customer_email"),
});

// ── order_details ──────────────────────────────────────────
export const order_details = pgTable("order_details", {
  doc_no: text("doc_no").primaryKey(),
  delivery_date: text("delivery_date"),
  time_range: text("time_range"),
  time_confirmed: integer("time_confirmed"),
  lorry_plate: text("lorry_plate"),
  driver_name: text("driver_name"),
  driver_contact: text("driver_contact"),
  days_left: integer("days_left"),
  internal_purchasing: text("internal_purchasing"),
  property_type: text("property_type"),
  new_house_replacement: text("new_house_replacement"),
  item_details: text("item_details"),
  done_delivery: integer("done_delivery"),
  consignment_no: text("consignment_no"),
  eta_port: text("eta_port"),
  estimate_delivery: text("estimate_delivery"),
  m3: integer("m3"),
  vessel_voyage: text("vessel_voyage"),
  etd_port_klang: text("etd_port_klang"),
  eta_destination: text("eta_destination"),
  transporter_remarks: text("transporter_remarks"),
  seafreight: integer("seafreight"),
  local_charges: integer("local_charges"),
  inland: integer("inland"),
  agent_fee: integer("agent_fee"),
  insurance: integer("insurance"),
  total_cost: integer("total_cost"),
  shipout_date: text("shipout_date"),
  warehouse: text("warehouse"),
  state: text("state"),
  lat: integer("lat"),
  lng: integer("lng"),
  order_type: text("order_type"),
  proposed_delivery_date: text("proposed_delivery_date"),
  updated_at: text("updated_at"),
});

// ── purchase_orders ────────────────────────────────────────
export const purchase_orders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  doc_no: text("doc_no").notNull(),
  doc_date: text("doc_date"),
  creditor_code: text("creditor_code"),
  creditor_name: text("creditor_name"),
  item_code: text("item_code"),
  item_description: text("item_description"),
  remaining_qty: integer("remaining_qty"),
  delivery_date: text("delivery_date"),
  supplier_date1: text("supplier_date1"),
  supplier_date2: text("supplier_date2"),
  supplier_date3: text("supplier_date3"),
  overdue_days: text("overdue_days"),
  amount: integer("amount"),
  unit_price: integer("unit_price"),
  amount_source: text("amount_source"),
  amount_updated_at: text("amount_updated_at"),
  amount_updated_by: integer("amount_updated_by"),
  updated_at: text("updated_at"),
});

// ── creditors ──────────────────────────────────────────────
export const creditors = pgTable("creditors", {
  creditor_code: text("creditor_code").primaryKey(),
  company_name: text("company_name"),
  desc2: text("desc2"),
  email: text("email"),
  phone1: text("phone1"),
  mobile: text("mobile"),
  tax_register_no: text("tax_register_no"),
  currency_code: text("currency_code"),
  type: text("type"),
  type_description: text("type_description"),
  purchase_agent: text("purchase_agent"),
  purchase_agent_description: text("purchase_agent_description"),
  updated_at: text("updated_at"),
});

// ── overdue_history ────────────────────────────────────────
export const overdue_history = pgTable("overdue_history", {
  id: serial("id").primaryKey(),
  pull_date: text("pull_date").notNull(),
  doc_no: text("doc_no").notNull(),
  debtor_name: text("debtor_name"),
  location: text("location"),
  region: text("region"),
  balance: integer("balance"),
  original_expiry_date: text("original_expiry_date"),
  extended_to: text("extended_to"),
  remark4: text("remark4"),
  created_at: text("created_at").default(nowText),
});

// ── purchase_order_docs ────────────────────────────────────
export const purchase_order_docs = pgTable("purchase_order_docs", {
  doc_no: text("doc_no").primaryKey(),
  doc_date: text("doc_date"),
  ref: text("ref"),
  creditor_code: text("creditor_code"),
  creditor_name: text("creditor_name"),
  cancelled: integer("cancelled"),
  doc_status: text("doc_status"),
  final_total: integer("final_total"),
  local_ex_tax: integer("local_ex_tax"),
  currency_code: text("currency_code"),
  updated_at: text("updated_at"),
});

// ── project_finance ────────────────────────────────────────
export const project_finance = pgTable("project_finance", {
  project_id: integer("project_id").primaryKey(),
  rental: integer("rental"),
  total_sales: integer("total_sales"),
  contractor_cost: integer("contractor_cost"),
  license_fee: integer("license_fee"),
  updated_at: text("updated_at"),
});

// ── project_checklist_sections (mig 050) ───────────────────
export const project_checklist_sections = pgTable("project_checklist_sections", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  name: text("name").notNull(),
  sort_order: integer("sort_order").notNull().default(0),
  display_mode: text("display_mode").notNull().default("list"),
  created_at: text("created_at").default(nowText),
});

// ── project_checklist_template_sections (mig 050) ──────────
export const project_checklist_template_sections = pgTable(
  "project_checklist_template_sections",
  {
    id: serial("id").primaryKey(),
    template_id: integer("template_id").notNull(),
    name: text("name").notNull(),
    sort_order: integer("sort_order").notNull().default(0),
    display_mode: text("display_mode").notNull().default("list"),
    created_at: text("created_at").default(nowText),
  },
);

// ── project_checklist_attachments (mig 050) ────────────────
export const project_checklist_attachments = pgTable(
  "project_checklist_attachments",
  {
    id: serial("id").primaryKey(),
    item_id: integer("item_id").notNull(),
    r2_key: text("r2_key").notNull(),
    file_name: text("file_name").notNull(),
    content_type: text("content_type"),
    size_bytes: integer("size_bytes"),
    uploaded_by: integer("uploaded_by"),
    uploaded_at: text("uploaded_at").default(nowText),
    archived_at: text("archived_at"),
  },
);

// ── project_checklist ──────────────────────────────────────
export const project_checklist = pgTable("project_checklist", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  section_id: integer("section_id"),
  seq: integer("seq").notNull().default(0),
  title: text("title").notNull(),
  description: text("description"),
  required_perm: text("required_perm"),
  role_label: text("role_label"),
  crew_visible: integer("crew_visible").notNull().default(0),
  due_date: text("due_date"),
  due_offset_days: integer("due_offset_days"),
  owner_user_id: integer("owner_user_id"),
  status: text("status").notNull().default("pending"),
  evidence_r2_key: text("evidence_r2_key"),
  completed_by: integer("completed_by"),
  completed_at: text("completed_at"),
  notes: text("notes"),
  review_status: text("review_status"),
  rejection_reason: text("rejection_reason"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
});

// ── project_checklist_templates ────────────────────────────
export const project_checklist_templates = pgTable("project_checklist_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

// ── project_checklist_template_items (mig 050) ─────────────
export const project_checklist_template_items = pgTable(
  "project_checklist_template_items",
  {
    id: serial("id").primaryKey(),
    template_id: integer("template_id").notNull(),
    section_id: integer("section_id"),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    required_perm: text("required_perm"),
    role_label: text("role_label"),
    crew_visible: integer("crew_visible").notNull().default(0),
    due_offset_days: integer("due_offset_days"),
    requires_review: integer("requires_review").notNull().default(0),
  },
);

// ── sales_entries (mig 041 / 051) ──────────────────────────
export const sales_entries = pgTable("sales_entries", {
  id: serial("id").primaryKey(),
  doc_no: text("doc_no"),
  project_id: integer("project_id"),
  ref_no: text("ref_no"),
  customer_name: text("customer_name").notNull(),
  customer_code: text("customer_code"),
  customer_address: text("customer_address"),
  customer_address_2: text("customer_address_2"),
  customer_postcode: text("customer_postcode"),
  customer_state: text("customer_state"),
  customer_phone: text("customer_phone"),
  customer_phone_2: text("customer_phone_2"),
  customer_email: text("customer_email"),
  amount: integer("amount").notNull(),
  deposit_amount: integer("deposit_amount"),
  deposit_payment_type: text("deposit_payment_type"),
  currency: text("currency").notNull().default("MYR"),
  occurred_at: text("occurred_at").notNull(),
  processing_date: text("processing_date"),
  delivery_date: text("delivery_date"),
  status_2: text("status_2"),
  venue: text("venue"),
  warehouse: text("warehouse"),
  branding: text("branding"),
  po_doc_no: text("po_doc_no"),
  payment_status: text("payment_status"),
  source: text("source"),
  remarks: text("remarks"),
  notes: text("notes"),
  status: text("status").notNull().default("draft"),
  autocount_doc_no: text("autocount_doc_no"),
  autocount_doc_type: text("autocount_doc_type"),
  pushed_at: text("pushed_at"),
  push_error: text("push_error"),
  sales_person_id: integer("sales_person_id"),
  created_by: integer("created_by").notNull(),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
  archived_at: text("archived_at"),
});

// ── sales_entry_items ──────────────────────────────────────
export const sales_entry_items = pgTable("sales_entry_items", {
  id: serial("id").primaryKey(),
  entry_id: integer("entry_id").notNull(),
  line_no: integer("line_no").notNull().default(0),
  item_code: text("item_code"),
  item_description: text("item_description"),
  remarks: text("remarks"),
  qty: doublePrecision("qty").notNull().default(1),
  unit_price: doublePrecision("unit_price").notNull().default(0),
  amount: doublePrecision("amount").notNull().default(0),
  group_tag: text("group_tag"),
  created_at: text("created_at").default(nowText),
});

// ── sales_entry_payments ───────────────────────────────────
export const sales_entry_payments = pgTable("sales_entry_payments", {
  id: serial("id").primaryKey(),
  entry_id: integer("entry_id").notNull(),
  paid_at: text("paid_at").notNull(),
  payment_method: text("payment_method").notNull(),
  amount: doublePrecision("amount").notNull(),
  account_sheet: text("account_sheet"),
  approval_code: text("approval_code"),
  collected_by: text("collected_by"),
  created_at: text("created_at").default(nowText),
});

// ── project_finance_lines ──────────────────────────────────
export const project_finance_lines = pgTable("project_finance_lines", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  kind: text("kind").notNull(),
  category: text("category"),
  description: text("description"),
  amount: integer("amount"),
  occurred_at: text("occurred_at"),
  notes: text("notes"),
  r2_key: text("r2_key"),
  file_name: text("file_name"),
  created_at: text("created_at").default(nowText),
  created_by: integer("created_by"),
  archived_at: text("archived_at"),
  auto_source: text("auto_source"),
});

// ── project_cost_rates (mig 063) ───────────────────────────
export const project_cost_rates = pgTable("project_cost_rates", {
  id: serial("id").primaryKey(),
  brand: text("brand").notNull().unique(),
  transport_pct: integer("transport_pct").notNull().default(0),
  merchandise_pct: integer("merchandise_pct").notNull().default(0),
  commission_normal_pct: integer("commission_normal_pct").notNull().default(0),
  commission_boost_pct: integer("commission_boost_pct"),
  boost_min_gp_pct: integer("boost_min_gp_pct"),
  boost_min_sales: integer("boost_min_sales"),
  updated_at: text("updated_at").default(nowText),
  updated_by: integer("updated_by"),
});

// ── point_transactions (mig 055) ───────────────────────────
export const point_transactions = pgTable("point_transactions", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull(),
  pool: text("pool").notNull(),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  ref_type: text("ref_type"),
  ref_id: integer("ref_id"),
  counterparty_user_id: integer("counterparty_user_id"),
  note: text("note"),
  created_at: text("created_at").default(nowText),
});

// ── user_streak_weeks (mig 055) ────────────────────────────
export const user_streak_weeks = pgTable(
  "user_streak_weeks",
  {
    user_id: integer("user_id").notNull(),
    iso_week: text("iso_week").notNull(),
    upvotes_count: integer("upvotes_count").notNull().default(0),
    qualified: integer("qualified").notNull().default(0),
    computed_at: text("computed_at").default(nowText),
  },
  (t) => ({ pk: primaryKey({ columns: [t.user_id, t.iso_week] }) }),
);

// ── leaderboard_cache (mig 055) ────────────────────────────
export const leaderboard_cache = pgTable(
  "leaderboard_cache",
  {
    scope: text("scope").notNull(),
    period: text("period").notNull(),
    computed_at: text("computed_at").notNull(),
    rows_json: text("rows_json").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.scope, t.period] }) }),
);

// ── gamify_settings (mig 055) ──────────────────────────────
export const gamify_settings = pgTable("gamify_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ── awards (mig 056) ───────────────────────────────────────
export const awards = pgTable("awards", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  cost_points: integer("cost_points").notNull(),
  stock: integer("stock"),
  image_r2_key: text("image_r2_key"),
  active: integer("active").notNull().default(1),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
});

// ── award_redemptions (mig 056) ────────────────────────────
export const award_redemptions = pgTable("award_redemptions", {
  id: serial("id").primaryKey(),
  award_id: integer("award_id").notNull(),
  user_id: integer("user_id").notNull(),
  cost_points: integer("cost_points").notNull(),
  status: text("status").notNull().default("pending"),
  shipping_addr: text("shipping_addr"),
  admin_note: text("admin_note"),
  created_at: text("created_at").default(nowText),
  shipped_at: text("shipped_at"),
  delivered_at: text("delivered_at"),
  cancelled_at: text("cancelled_at"),
  cancelled_by: integer("cancelled_by"),
  ledger_tx_id: integer("ledger_tx_id"),
});

// ── innovations (mig 057) ──────────────────────────────────
export const innovations = pgTable("innovations", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  tags: text("tags"),
  status: text("status").notNull().default("review"),
  decided_by: integer("decided_by"),
  decided_at: text("decided_at"),
  decline_reason: text("decline_reason"),
  awarded_at: text("awarded_at"),
  created_at: text("created_at").default(nowText),
  archived_at: text("archived_at"),
});

// ── suggestions (mig 057) ──────────────────────────────────
export const suggestions = pgTable("suggestions", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  status: text("status").notNull().default("review"),
  decided_by: integer("decided_by"),
  decided_at: text("decided_at"),
  decline_reason: text("decline_reason"),
  awarded_at: text("awarded_at"),
  created_at: text("created_at").default(nowText),
  archived_at: text("archived_at"),
});

// ── votes (mig 057) ────────────────────────────────────────
export const votes = pgTable("votes", {
  id: serial("id").primaryKey(),
  target_type: text("target_type").notNull(),
  target_id: integer("target_id").notNull(),
  user_id: integer("user_id").notNull(),
  created_at: text("created_at").default(nowText),
});

// ── idea_attachments (mig 059) ─────────────────────────────
export const idea_attachments = pgTable("idea_attachments", {
  id: serial("id").primaryKey(),
  target_type: text("target_type").notNull(),
  target_id: integer("target_id").notNull(),
  r2_key: text("r2_key").notNull(),
  file_name: text("file_name").notNull(),
  content_type: text("content_type"),
  size_bytes: integer("size_bytes"),
  uploaded_by: integer("uploaded_by"),
  uploaded_at: text("uploaded_at").default(nowText),
  archived_at: text("archived_at"),
});

// ── petty_cash_entries (mig 060) ───────────────────────────
export const petty_cash_entries = pgTable("petty_cash_entries", {
  id: serial("id").primaryKey(),
  direction: text("direction").notNull(),
  amount_cents: integer("amount_cents").notNull(),
  category: text("category"),
  counterparty: text("counterparty"),
  note: text("note"),
  receipt_r2_key: text("receipt_r2_key"),
  posted_by: integer("posted_by").notNull(),
  occurred_on: text("occurred_on").notNull(),
  archived_at: text("archived_at"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
});

// ── sales_positions / tiers / reps (mig 067) ───────────────
export const sales_positions = pgTable("sales_positions", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  level: integer("level").notNull().default(20),
  sort_order: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

export const sales_commission_tiers = pgTable("sales_commission_tiers", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  rate: integer("rate").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

export const sales_reps = pgTable("sales_reps", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  nric: text("nric"),
  position_id: integer("position_id"),
  upline_id: integer("upline_id"),
  upline_secondary_id: integer("upline_secondary_id"),
  user_id: integer("user_id").unique(),
  status: text("status").notNull().default("active"),
  is_admin: integer("is_admin").notNull().default(0),
  commission_rate: integer("commission_rate"),
  commission_tier_id: integer("commission_tier_id"),
  commission_min_rate: integer("commission_min_rate").notNull().default(0),
  joined_on: text("joined_on"),
  notes: text("notes"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
  archived_at: text("archived_at"),
  archived_by: integer("archived_by"),
});

export const sales_rep_commission_tiers = pgTable(
  "sales_rep_commission_tiers",
  {
    id: serial("id").primaryKey(),
    rep_id: integer("rep_id").notNull(),
    threshold: integer("threshold").notNull().default(0),
    rate: integer("rate").notNull().default(0),
    sort_order: integer("sort_order").notNull().default(0),
    created_at: text("created_at").default(nowText),
  },
);

export const sales_rep_brands = pgTable(
  "sales_rep_brands",
  {
    rep_id: integer("rep_id").notNull(),
    brand: text("brand").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.rep_id, t.brand] }) }),
);

export const sales_team_activity = pgTable("sales_team_activity", {
  id: serial("id").primaryKey(),
  rep_id: integer("rep_id").notNull(),
  action: text("action").notNull(),
  from_value: text("from_value"),
  to_value: text("to_value"),
  note: text("note"),
  user_id: integer("user_id"),
  created_at: text("created_at").default(nowText),
});

// ── project_sales_attendees (mig 087) ──────────────────────
export const project_sales_attendees = pgTable(
  "project_sales_attendees",
  {
    project_id: integer("project_id").notNull(),
    sales_rep_id: integer("sales_rep_id").notNull(),
    created_at: text("created_at").default(nowText),
    created_by: integer("created_by"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.project_id, t.sales_rep_id] }) }),
);

// ── Supply Chain module ─────────────────────────────────────────────────
// The earlier adapted "scm_*" island was removed here. The owner rejected that
// adaptation (single-PO GRN, text-typed status, scm_ prefix) in favour of a
// verbatim 1:1 clone of 2990s's SCM — decision 2026-06-17, see
// docs/scm-clone/PLAN.md. The physical scm_* tables are dropped by
// migrations-pg/0023_drop_adapted_scm_island.sql. The 1:1 clone tables
// (suppliers, supplier_material_bindings, purchase_orders, grns, ...) are added
// slice by slice in following edits/migrations.

// ── Suppliers slice (1:1 clone of 2990s) ────────────────────────────────
// Copied VERBATIM from 2990s packages/db/src/schema.ts (suppliers ~L860,
// supplierMaterialBindings ~L911) + the pgEnums they use (supplierStatus,
// currencyCode, materialKind). camelCase keys + snake_case column strings +
// real pgEnums, exactly as in 2990s. Only the surrounding stack changes.

export const supplierStatus = pgEnum('supplier_status', ['ACTIVE', 'INACTIVE', 'BLOCKED']);

export const currencyCode = pgEnum('currency_code', ['MYR', 'RMB', 'USD', 'SGD']);

export const materialKind = pgEnum('material_kind', ['mfg_product', 'fabric', 'raw']);

export const suppliers = pgTable('suppliers', {
  id:             uuid('id').primaryKey().defaultRandom(),
  code:           text('code').notNull().unique(),                          // Credit Account ('400-B002')
  name:           text('name').notNull(),                                   // Company Name
  whatsappNumber: text('whatsapp_number'),
  email:          text('email'),
  // HOOKKA-port fields (migration 0041): full master record for purchasing.
  contactPerson:  text('contact_person'),
  phone:          text('phone'),
  address:        text('address'),                                          // Billing Address (multiline)
  state:          text('state'),
  /* PR #47 — country drives State cascade from my_localities */
  country:        text('country').notNull().default('Malaysia'),
  paymentTerms:   text('payment_terms'),                                    // dropdown: 'COD' | 'NET 7' | 'NET 30' | etc
  status:         supplierStatus('status').notNull().default('ACTIVE'),
  rating:         integer('rating').notNull().default(0),                   // 0-5 scale
  notes:          text('notes'),
  /* PR #40 — Commander 2026-05-26 AutoCount parity (migration 0055) */
  supplierType:   text('supplier_type'),                                    // 'Matrix', 'Distributor', 'Maker', ...
  category:       text('category'),                                         // 'Bedframe', 'Fabric', 'Hardware', ...
  tinNumber:      text('tin_number'),
  businessRegNo: text('business_reg_no'),
  postcode:       text('postcode'),
  area:           text('area'),
  mobile:         text('mobile'),
  fax:            text('fax'),
  website:        text('website'),
  attention:      text('attention'),
  businessNature: text('business_nature'),
  currency:       text('currency').notNull().default('MYR'),
  statementType:  text('statement_type').notNull().default('OPEN_ITEM'),    // OPEN_ITEM | BALANCE_FORWARD | NO_STATEMENT
  agingBasis:     text('aging_basis').notNull().default('INVOICE_DATE'),    // INVOICE_DATE | DUE_DATE
  creditLimitSen: integer('credit_limit_sen').notNull().default(0),         // 0 = unlimited
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ───── supplier_material_bindings — the "two-code mapping" table ─────
   The crux of the HOOKKA port: maps our internal `material_code`
   (e.g. mfg_products.code '1003-(K)' or fabrics.code 'AVANI 01')
   to the supplier's own SKU + price + lead time + currency.
   One material can have N suppliers; exactly one per material is
   `is_main_supplier=true` (enforced at app layer, not DB constraint).

   `material_kind` lets one binding row reference either a finished
   SKU (mfg_product) or a fabric — extend with more values when raw
   materials get ported.
   ─────────────────────────────────────────────────────────────────── */

export const supplierMaterialBindings = pgTable('supplier_material_bindings', {
  id:                uuid('id').primaryKey().defaultRandom(),
  supplierId:        uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'cascade' }),
  materialKind:      materialKind('material_kind').notNull(),
  materialCode:      text('material_code').notNull(),    // OUR internal code ('1003-(K)','AVANI 01')
  materialName:      text('material_name').notNull(),    // snapshot for the binding row
  supplierSku:       text('supplier_sku').notNull(),     // SUPPLIER's own SKU
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),  // × 100; works for both MYR + RMB
  currency:          currencyCode('currency').notNull().default('MYR'),
  leadTimeDays:      integer('lead_time_days').notNull().default(0),
  paymentTermsOverride: text('payment_terms_override'),  // overrides supplier.payment_terms if set
  moq:               integer('moq').notNull().default(0),                // min order quantity
  priceValidFrom:    date('price_valid_from'),
  priceValidTo:      date('price_valid_to'),
  isMainSupplier:    boolean('is_main_supplier').notNull().default(false),
  notes:             text('notes'),
  /* PR — Commander 2026-05-27 ("跟着 Product Maintenance 的排版"): per-category
     cost matrix that mirrors the Products Maintenance shape. Migration 0089.
     SOFA:      {"24":{"P1":N,"P2":N,"P3":N},"26":{...},...} centi per
                (seat-height × fabric tier) — same axes as the Products SOFA
                price table.
     BEDFRAME:  {"P1":N,"P2":N} centi per fabric upholstery tier.
     MATTRESS/ACCESSORY/SERVICE: NULL — single price flows through
                unit_price_centi above (unchanged).
     Shape is validated server-side (apps/api/src/routes/suppliers.ts) per
     the binding's mfg_products.category. */
  priceMatrix:       jsonb('price_matrix'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSupplier:        index('idx_smb_supplier').on(t.supplierId),
  idxMaterial:        index('idx_smb_material').on(t.materialKind, t.materialCode),
  idxMain:            index('idx_smb_main_per_material')
                        .on(t.materialKind, t.materialCode)
                        .where(sql`${t.isMainSupplier} = true`),
}));

// ── Purchase Orders slice (1:1 clone of 2990s) ──────────────────────────
// Copied VERBATIM from 2990s packages/db/src/schema.ts (poStatus ~L853,
// purchaseOrders ~L948, purchaseOrderItems ~L979, purchaseOrderLines ~L1031).
// camelCase keys + snake_case column strings + the real po_status pgEnum,
// exactly as in 2990s, so the ported route references (.poNumber, .supplierId,
// .soItemId, …) compile unchanged. Only the documented SEAMS change:
//
//   - PHYSICAL TABLE NAME (collision deviation — see docs/scm-clone/PLAN.md
//     collision map): Houzs ALREADY has an AutoCount table physically named
//     `purchase_orders` (schema.pg.ts ~L399, ~thousands of live rows, served by
//     /api/po). Two pgTable('purchase_orders', ...) cannot coexist, and the
//     brief forbids touching the AutoCount route/table. So the clone tables take
//     2990s's OWN `mfg_*` vocabulary (its route file is mfg-purchase-orders.ts;
//     it already uses mfg_sales_orders / mfg_sales_order_items) as the physical
//     name — `mfg_purchase_orders` / `mfg_purchase_order_items` /
//     `mfg_purchase_order_lines`. The Drizzle EXPORT KEYS stay verbatim
//     (purchaseOrders / purchaseOrderItems / purchaseOrderLines). Tighten to the
//     bare `purchase_orders` name only at the gated cutover (task #71), once the
//     AutoCount table is removed.
//
//   - createdBy: 2990s is uuid -> staff.id. Houzs has no `staff` table; rule #4
//     maps staff -> Houzs `users` (id = serial INTEGER). So createdBy is INTEGER
//     and a SOFT ref (no FK) to users.id.
//
//   - purchaseLocationId / warehouseId: 2990s FK -> warehouses.id (uuid). Houzs's
//     `warehouses` (AutoCount) is keyed by a text `code` and the 2990s warehouses
//     table is NOT cloned yet. Kept as a NULLABLE SOFT ref (uuid, no FK); tighten
//     when the Warehouse slice lands (PLAN "Collisions for UPCOMING slices").
//
//   - soItemId: 2990s FK -> mfg_sales_order_items.id (uuid). The SO slice is not
//     cloned yet -> NULLABLE SOFT ref (uuid, no FK). Tighten when SO lands.
//
//   - purchaseOrderLines.orderId: 2990s FK -> orders.id (the retail POS order).
//     Houzs has no `orders` table in this schema -> NULLABLE SOFT ref (text, no
//     FK). This child table is the legacy retail-order→supplier-PO link and is
//     unused by the mfg PO route; ported verbatim for schema fidelity.

export const poStatus = pgEnum('po_status', [
  'SUBMITTED',            // sent to supplier, awaiting acknowledgement (default on create)
  'PARTIALLY_RECEIVED',   // some GRN posted
  'RECEIVED',             // all items GRN'd
  'CANCELLED',
]);

export const purchaseOrders = pgTable('mfg_purchase_orders', {
  id:          uuid('id').primaryKey().defaultRandom(),
  poNumber:    text('po_number').notNull().unique(),       // 'PO-2026-001'
  supplierId:  uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  // Extended fields (migration 0041)
  status:      poStatus('status').notNull().default('SUBMITTED'),
  poDate:      date('po_date').notNull().defaultNow(),
  expectedAt:  date('expected_at'),                        // delivery ETA
  // PR #77 — Default ship-to warehouse for every line on this PO (mirrors
  // AutoCount's header "Purchase Location"). Per-line warehouse_id on the
  // items table overrides when commander wants split delivery.
  // SEAM: nullable SOFT ref (no FK) — warehouses table not cloned yet.
  purchaseLocationId: uuid('purchase_location_id'),
  currency:    currencyCode('currency').notNull().default('MYR'),
  subtotalCenti: integer('subtotal_centi').notNull().default(0),
  taxCenti:    integer('tax_centi').notNull().default(0),
  totalCenti:  integer('total_centi').notNull().default(0),
  notes:       text('notes'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  receivedAt:  timestamp('received_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // SEAM (rule #4): 2990s uuid -> staff.id. Houzs users.id is serial INTEGER;
  // SOFT ref (no FK) so the PO module isn't coupled to the users table FK.
  createdBy:   integer('created_by').notNull(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSupplier: index('idx_po_supplier').on(t.supplierId),
  idxStatus:   index('idx_po_status').on(t.status),
}));

/* PO items — what we're ordering FROM a supplier (vs purchase_order_lines
   which links a retail-order SKU to a supplier-PO for the existing retail
   /purchase-orders skeleton). */
export const purchaseOrderItems = pgTable('mfg_purchase_order_items', {
  id:               uuid('id').primaryKey().defaultRandom(),
  purchaseOrderId:  uuid('purchase_order_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  // Optional FK to the binding row that priced this line — gives us
  // traceability when supplier prices change later.
  bindingId:        uuid('binding_id').references(() => supplierMaterialBindings.id, { onDelete: 'set null' }),
  materialKind:     materialKind('material_kind').notNull(),
  materialCode:     text('material_code').notNull(),
  materialName:     text('material_name').notNull(),
  supplierSku:      text('supplier_sku'),                  // snapshot at PO time
  qty:              integer('qty').notNull(),
  unitPriceCenti:   integer('unit_price_centi').notNull(),
  lineTotalCenti:   integer('line_total_centi').notNull(),
  receivedQty:      integer('received_qty').notNull().default(0), // updated by GRN (when ported)
  notes:            text('notes'),
  /* PR #41 — Variant fields (migration 0056). Mirrors mfg_sales_order_items
     so SO→PO and PO→GRN conversions preserve sofa color / bedframe D1 etc.
     Strategy-2: KEPT for fidelity; the Houzs UI does not surface the
     sofa-variant editor (generic qty/price fields only). */
  gapInches:               integer('gap_inches'),
  divanHeightInches:       integer('divan_height_inches'),
  divanPriceSen:           integer('divan_price_sen').notNull().default(0),
  legHeightInches:         integer('leg_height_inches'),
  legPriceSen:             integer('leg_price_sen').notNull().default(0),
  customSpecials:          jsonb('custom_specials'),
  lineSuffix:              text('line_suffix'),
  specialOrderPriceSen:    integer('special_order_price_sen').notNull().default(0),
  variants:                jsonb('variants'),               // { fabricColor, seatHeight, ... }
  itemGroup:               text('item_group'),              // 'sofa'|'bedframe'|'mattress'|'accessory'|'service'
  description:             text('description'),
  description2:            text('description2'),
  uom:                     text('uom').notNull().default('UNIT'),
  discountCenti:           integer('discount_centi').notNull().default(0),
  unitCostCenti:           integer('unit_cost_centi').notNull().default(0),
  // PR #77 — per-line delivery date + ship-to warehouse. Both nullable;
  // empty = inherit from PO header (expected_at + purchase_location_id).
  // SEAM: warehouseId is a nullable SOFT ref (no FK) — warehouses not cloned.
  deliveryDate:            date('delivery_date'),
  warehouseId:             uuid('warehouse_id'),
  /* Migration 0098 — Commander 2026-05-29 (BUG 1). Source SO line this PO
     line was converted from (From-SO picker). NULL for manually-added lines.
     Lets the delete handler release po_qty_picked back to the SO line.
     SEAM: nullable SOFT ref (no FK) — mfg_sales_order_items not cloned yet. */
  soItemId:                uuid('so_item_id'),
  /* Migration 0118 — Commander 2026-05-31. Tags a PO line raised through the MRP
     "convert to PO" path. MRP-origin lines are REFERENCE-ONLY: excluded from the
     po_qty_picked recount + the qty_exceeds_remaining cap, so the same SO line is
     infinitely convertible from MRP. Ordinary SO→PO picks keep from_mrp=false. */
  fromMrp:                 boolean('from_mrp').notNull().default(false),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPo:        index('idx_po_items_po').on(t.purchaseOrderId),
  idxWarehouse: index('idx_po_items_warehouse').on(t.warehouseId),
  idxSoItem:    index('idx_po_items_so_item').on(t.soItemId),
}));

export const purchaseOrderLines = pgTable('mfg_purchase_order_lines', {
  id:               uuid('id').primaryKey().defaultRandom(),
  purchaseOrderId:  uuid('purchase_order_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  // SEAM: 2990s FK -> orders.id (retail POS order, text). Houzs has no `orders`
  // table here -> nullable SOFT ref (text, no FK). Legacy retail link, unused
  // by the mfg PO route; ported verbatim for schema fidelity.
  orderId:          text('order_id').notNull(),
  sku:              text('sku').notNull(),
  name:             text('name').notNull(),
  size:             text('size'),
  colour:           text('colour'),
  qty:              integer('qty').notNull(),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
