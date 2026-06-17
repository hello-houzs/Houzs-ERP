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
  uniqueIndex,
  check,
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

// ── Goods Receipt (GRN) slice (1:1 clone of 2990s) ──────────────────────────
// Copied VERBATIM from 2990s packages/db/src/schema.ts: grn_status (enum, ~L1051),
// grns (~L1057), grn_items (~L1083). camelCase keys + snake_case column strings +
// the real grn_status pgEnum, so the ported /grns route + grn-rack-sync reference
// these unchanged. The procurement chain is PO -> GRN -> (PI/PR later); a GRN POST
// rolls qty_accepted onto mfg_purchase_order_items.received_qty, recomputes the
// parent mfg_purchase_orders.status, writes an inventory IN movement (FIFO trigger,
// migration 0026), and optionally places lines onto warehouse racks.
//
// NO AutoCount collision (Houzs has no `grns` / `grn_items`) -> BARE names + bare
// export keys (rule #1). All later-migration columns are folded in so the schema
// is the FINAL shape migration 0027 creates: currency/subtotal/tax/total (2990s
// mig 0101), discount/line_total/delivery_date/unit_cost/supplier_sku (0101),
// invoiced_qty/returned_qty (0106), rack_id (0151).
//
// Only the documented SEAMS change vs 2990s:
//   - purchaseOrderId: 2990s declares it .notNull() with FK -> purchase_orders,
//     BUT the route inserts purchase_order_id:null for MANUAL/blank GRNs
//     (Commander 2026-05-29). To keep that route path faithful, the FK is REAL
//     (-> mfg_purchase_orders) but NULLABLE (onDelete:'set null'). Documented
//     necessary deviation (the 2990s schema/route already disagree here).
//   - supplierId / purchaseOrderItemId / grnId: REAL FKs (suppliers /
//     mfg_purchase_order_items / grns), exactly as 2990s.
//   - warehouseId: 2990s FK -> warehouses.id (uuid). Now that the Inventory slice
//     cloned mfg_warehouses, this is a REAL FK -> mfgWarehouses (matching the
//     inventory ledger the GRN posts into). 2990s ON DELETE behaviour kept loose
//     (set null) so deleting a warehouse never blocks GRN history.
//   - rackId: REAL FK -> warehouseRacks (set null), as 2990s (mig 0151).
//   - createdBy: 2990s uuid -> staff.id. rule #4 -> Houzs users.id (serial
//     INTEGER); SOFT ref (no FK), matching the PO/inventory slices.

export const grnStatus = pgEnum('grn_status', ['POSTED', 'CLOSED', 'CANCELLED']);

export const grns = pgTable('grns', {
  id:                uuid('id').primaryKey().defaultRandom(),
  grnNumber:         text('grn_number').notNull().unique(),         // 'GRN-2605-001'
  // SEAM (see header): nullable REAL FK so manual/blank GRNs (no parent PO) save.
  purchaseOrderId:   uuid('purchase_order_id').references(() => purchaseOrders.id, { onDelete: 'set null' }),
  supplierId:        uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  // SEAM: REAL FK -> mfg_warehouses (the cloned inventory warehouse table).
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  receivedAt:        date('received_at').notNull().defaultNow(),
  deliveryNoteRef:   text('delivery_note_ref'),                     // supplier's DO number
  status:            grnStatus('status').notNull().default('POSTED'),
  notes:             text('notes'),
  /* 2990s migration 0101 — GRN <-> PO money parity. currency reuses the same
     currency_code enum as purchase_orders. subtotal/total are recomputed
     server-side as Σ grn_items.line_total_centi (no tax for GRN). */
  currency:          currencyCode('currency').notNull().default('MYR'),
  subtotalCenti:     integer('subtotal_centi').notNull().default(0),
  taxCenti:          integer('tax_centi').notNull().default(0),
  totalCenti:        integer('total_centi').notNull().default(0),
  postedAt:          timestamp('posted_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // SEAM (rule #4): 2990s uuid -> staff.id. Houzs users.id is serial INTEGER; soft ref.
  createdBy:         integer('created_by').notNull(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPo:       index('idx_grn_po').on(t.purchaseOrderId),
  idxSupplier: index('idx_grn_supplier').on(t.supplierId),
  idxStatus:   index('idx_grn_status').on(t.status),
}));

export const grnItems = pgTable('grn_items', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  grnId:                 uuid('grn_id').notNull().references(() => grns.id, { onDelete: 'cascade' }),
  purchaseOrderItemId:   uuid('purchase_order_item_id').references(() => purchaseOrderItems.id, { onDelete: 'set null' }),
  materialKind:          materialKind('material_kind').notNull(),
  materialCode:          text('material_code').notNull(),
  materialName:          text('material_name').notNull(),
  qtyReceived:           integer('qty_received').notNull(),
  qtyAccepted:           integer('qty_accepted').notNull(),
  qtyRejected:           integer('qty_rejected').notNull().default(0),
  rejectionReason:       text('rejection_reason'),
  unitPriceCenti:        integer('unit_price_centi').notNull(),     // snapshot from PO line
  notes:                 text('notes'),
  /* 2990s PR #42 — variant fields (migration 0057). Strategy-2: KEPT for fidelity;
     the Houzs UI does not surface the sofa-variant editor (generic fields only). */
  gapInches:             integer('gap_inches'),
  divanHeightInches:     integer('divan_height_inches'),
  divanPriceSen:         integer('divan_price_sen').notNull().default(0),
  legHeightInches:       integer('leg_height_inches'),
  legPriceSen:           integer('leg_price_sen').notNull().default(0),
  customSpecials:        jsonb('custom_specials'),
  lineSuffix:            text('line_suffix'),
  specialOrderPriceSen:  integer('special_order_price_sen').notNull().default(0),
  variants:              jsonb('variants'),
  itemGroup:             text('item_group'),
  description:           text('description'),
  description2:          text('description2'),
  uom:                   text('uom').notNull().default('UNIT'),
  discountCenti:         integer('discount_centi').notNull().default(0),
  /* 2990s migration 0101 — GRN <-> PO line money parity.
     lineTotalCenti = qty_received * unit_price_centi - discount_centi.
     deliveryDate / unitCostCenti / supplierSku mirror mfg_purchase_order_items. */
  lineTotalCenti:        integer('line_total_centi').notNull().default(0),
  deliveryDate:          date('delivery_date'),
  unitCostCenti:         integer('unit_cost_centi').notNull().default(0),
  supplierSku:           text('supplier_sku'),
  /* 2990s migration 0106 — GRN line consumption tracking (GRN -> {PI, PR}).
     invoicedQty = Σ PI line qty drawn from this line; returnedQty = Σ PR line qty
     drawn. Either > 0 => the GRN has a downstream child (edit-lock). The PI/PR
     slices that WRITE these land later; the GRN route READS them for has_children. */
  invoicedQty:           integer('invoiced_qty').notNull().default(0),
  returnedQty:           integer('returned_qty').notNull().default(0),
  /* 2990s migration 0151 — physical rack this received line is placed onto.
     REAL FK -> warehouse_racks (set null); grn-rack-sync reads it on post. */
  rackId:                uuid('rack_id').references(() => warehouseRacks.id, { onDelete: 'set null' }),
  createdAt:             timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxGrn: index('idx_grn_items_grn').on(t.grnId),
}));

// ── Inventory + Warehouse slice (1:1 clone of 2990s) ────────────────────────
// Copied VERBATIM from 2990s packages/db/src/schema.ts:
//   inventoryMovementType (enum) ~L2344, warehouses ~L2348, inventoryMovements
//   ~L2424, inventoryLots ~L2456, stockTransfers ~L2488, stockTransferLines
//   ~L2508, stockTakes ~L2529, stockTakeLines ~L2549, inventoryLotConsumptions
//   ~L2568, warehouseRacks ~L2695, warehouseRackItems ~L2715,
//   warehouseRackMovements ~L2734. camelCase keys + snake_case column strings +
//   the real inventory_movement_type pgEnum, exactly as in 2990s, so the ported
//   inventory/warehouse route references compile unchanged. The FIFO engine
//   itself is a DB trigger (fn_inventory_movement_fifo + fn_consume_fifo[_batch]),
//   cloned verbatim into migration 0026; these tables are the ledger it maintains.
//
// LATER-MIGRATION COLUMNS folded in (so the schema is the final shape, matching
// what migration 0026 creates): inventory_movements.variant_key (2990s mig 0095),
// .batch_no (0120), .reason_code (0150); inventory_lots.variant_key + .batch_no;
// inventory_lot_consumptions.variant_key; stock_transfer_lines.variant_key;
// warehouses.is_consignment (0152).
//
// Only the documented SEAMS change:
//   - PHYSICAL TABLE NAME + EXPORT KEY (collision deviation — PLAN.md collision
//     map / NAMING CONVENTION): Houzs ALREADY has an AutoCount table physically
//     named `warehouses` AND already `export const warehouses` (schema.pg.ts
//     ~L282, keyed by `code`), served by /api/warehouses. Two pgTable
//     ('warehouses', ...) — and two `export const warehouses` — cannot coexist,
//     and the brief forbids touching the AutoCount route/table. So the clone
//     takes 2990s's own `mfg_` vocabulary for BOTH: physical name `mfg_warehouses`
//     and export key `mfgWarehouses`. Ported routes import it aliased
//     (`mfgWarehouses as warehousesTable`) so the route bodies still read like
//     2990s. (PLAN said "export key stays `warehouses`", but the pre-existing
//     AutoCount `export const warehouses` makes that impossible — documented
//     necessary deviation.) The four non-colliding tables (warehouse_racks,
//     inventory_movements, inventory_lots, inventory_lot_consumptions — Houzs has
//     none) keep bare names; their warehouse FKs point at mfgWarehouses (the
//     mfg_warehouses table). Rename both to the bare `warehouses` only at the
//     gated cutover (task #71), once the AutoCount table/export is removed.
//   - performedBy / createdBy: 2990s is uuid -> staff.id. Houzs has no `staff`
//     table; rule #4 maps staff -> Houzs `users` (id = serial INTEGER). So these
//     are INTEGER + SOFT refs (no FK) to users.id (matching the PO slice's
//     created_by). 2990s ON DELETE SET NULL becomes "just a soft int" here.
//   - Stock-transfer / stock-take tables ARE cloned now (the inventory ledger +
//     FIFO trigger they post into must exist as one unit), but their POST routes
//     land in the Transfers/Stocktake slice (#63). Cloned verbatim for fidelity.

export const inventoryMovementType = pgEnum('inventory_movement_type', [
  'IN', 'OUT', 'ADJUSTMENT', 'TRANSFER',
]);

export const mfgWarehouses = pgTable('mfg_warehouses', {
  id:         uuid('id').primaryKey().defaultRandom(),
  code:       text('code').notNull().unique(),    // 'KL', 'PJ'
  name:       text('name').notNull(),
  location:   text('location'),
  isActive:   boolean('is_active').notNull().default(true),
  isDefault:  boolean('is_default').notNull().default(false),
  // 2990s migration 0152 — virtual holding warehouse for goods out on sales
  // consignment (still owned, not sellable). Excluded from pickers; the
  // inventory route reads is_consignment to keep consigned stock visible.
  isConsignment: boolean('is_consignment').notNull().default(false),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxActive: index('idx_warehouses_active').on(t.isActive),
}));

export const inventoryMovements = pgTable('inventory_movements', {
  id:             uuid('id').primaryKey().defaultRandom(),
  movementType:   inventoryMovementType('movement_type').notNull(),
  warehouseId:    uuid('warehouse_id').notNull().references(() => mfgWarehouses.id, { onDelete: 'restrict' }),
  productCode:    text('product_code').notNull(),
  productName:    text('product_name'),
  // 2990s migration 0095 — attribute-composition bucket key (packages/shared
  // computeVariantKey). '' = unclassified/legacy. Strategy-2: Houzs materials are
  // plain text with no category, so this stays '' (one unclassified bucket per
  // product_code) until a product layer lands. computeVariantKey is ported.
  variantKey:     text('variant_key').notNull().default(''),
  qty:            integer('qty').notNull(),
  // 2990s PR #37 — per-unit cost in sen. IN: provided by caller (from GRN/PI).
  // OUT: computed by the FIFO trigger from consumed lots.
  unitCostSen:    integer('unit_cost_sen').default(0),
  totalCostSen:   integer('total_cost_sen').default(0),
  sourceDocType:  text('source_doc_type'),  // 'GRN' | 'DO' | 'CONSIGNMENT_NOTE' | 'PURCHASE_RETURN' | 'ADJUSTMENT' | ...
  sourceDocId:    uuid('source_doc_id'),
  sourceDocNo:    text('source_doc_no'),
  // 2990s migration 0120 — production batch (source PO number). Carried on the IN
  // movement; the FIFO trigger copies it onto the lot it creates. NULL = un-batched.
  batchNo:        text('batch_no'),
  // 2990s migration 0150 — structured adjustment reason (DAMAGE/LOSS/THEFT/FOUND/
  // COUNT/SAMPLE/WRITEOFF/OTHER). NULL for IN/OUT + legacy rows.
  reasonCode:     text('reason_code'),
  notes:          text('notes'),
  // SEAM (rule #4): 2990s uuid -> staff.id. Houzs users.id is serial INTEGER;
  // SOFT ref (no FK).
  performedBy:    integer('performed_by'),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxWarehouseProduct: index('idx_inv_mov_warehouse_product').on(t.warehouseId, t.productCode, t.variantKey),
  idxDoc:              index('idx_inv_mov_doc').on(t.sourceDocType, t.sourceDocId),
  idxCreated:          index('idx_inv_mov_created').on(t.createdAt),
}));

/* 2990s PR #37 — FIFO lots (one row per IN) + consumptions (FIFO consumes per
   OUT). The DB-side trigger fn_inventory_movement_fifo() maintains these. */
export const inventoryLots = pgTable('inventory_lots', {
  id:             uuid('id').primaryKey().defaultRandom(),
  warehouseId:    uuid('warehouse_id').notNull().references(() => mfgWarehouses.id, { onDelete: 'restrict' }),
  productCode:    text('product_code').notNull(),
  productName:    text('product_name'),
  variantKey:     text('variant_key').notNull().default(''),  // migration 0095
  qtyReceived:    integer('qty_received').notNull(),
  qtyRemaining:   integer('qty_remaining').notNull(),
  unitCostSen:    integer('unit_cost_sen').notNull().default(0),
  receivedAt:     timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  sourceDocType:  text('source_doc_type'),
  sourceDocId:    uuid('source_doc_id'),
  sourceDocNo:    text('source_doc_no'),
  movementId:     uuid('movement_id'),
  // migration 0120 — production batch (source PO number), copied from the IN
  // movement by the FIFO trigger. NULL = un-batched.
  batchNo:        text('batch_no'),
  notes:          text('notes'),
  createdBy:      integer('created_by'),  // SEAM rule #4: 2990s uuid -> users.id int
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxWhProduct: index('idx_inv_lots_wh_product').on(t.warehouseId, t.productCode, t.variantKey, t.receivedAt),
  idxBatch:     index('idx_inv_lots_batch').on(t.warehouseId, t.batchNo, t.productCode, t.variantKey),
}));

/* 2990s PR Inv PR4. Stock transfers move qty between warehouses with a proper
   document trail. POST writes paired OUT (from) + IN (to) into
   inventory_movements with source_doc_type='STOCK_TRANSFER'. Route lands in the
   Transfers slice (#63); cloned now so the ledger schema is whole. */
export const stockTransfers = pgTable('stock_transfers', {
  id:                uuid('id').primaryKey().defaultRandom(),
  transferNo:        text('transfer_no').notNull().unique(),         // ST-YYMM-NNN
  status:            text('status').notNull().default('POSTED'),     // POSTED|CANCELLED
  fromWarehouseId:   uuid('from_warehouse_id').notNull().references(() => mfgWarehouses.id, { onDelete: 'restrict' }),
  toWarehouseId:     uuid('to_warehouse_id').notNull().references(() => mfgWarehouses.id, { onDelete: 'restrict' }),
  transferDate:      date('transfer_date').notNull().defaultNow(),
  notes:             text('notes'),
  postedAt:          timestamp('posted_at', { withTimezone: true }),
  cancelledAt:       timestamp('cancelled_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),  // SEAM rule #4
}, (t) => ({
  idxStatus:  index('idx_stock_transfers_status').on(t.status, t.transferDate),
  idxFromWh:  index('idx_stock_transfers_from_wh').on(t.fromWarehouseId),
  idxToWh:    index('idx_stock_transfers_to_wh').on(t.toWarehouseId),
  notSameWh:  check('stock_transfers_not_same_wh', sql`from_warehouse_id <> to_warehouse_id`),
  statusEnum: check('stock_transfers_status_chk', sql`status IN ('POSTED','CANCELLED')`),
}));

export const stockTransferLines = pgTable('stock_transfer_lines', {
  id:                uuid('id').primaryKey().defaultRandom(),
  stockTransferId:   uuid('stock_transfer_id').notNull().references(() => stockTransfers.id, { onDelete: 'cascade' }),
  productCode:       text('product_code').notNull(),
  productName:       text('product_name'),
  variantKey:        text('variant_key').notNull().default(''),  // migration 0117
  qty:               integer('qty').notNull(),
  notes:             text('notes'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxXfer: index('idx_stock_transfer_lines_xfer').on(t.stockTransferId),
  qtyPos:  check('stock_transfer_lines_qty_pos', sql`qty > 0`),
}));

/* 2990s PR Inv PR5. Stock takes are AutoCount-style cycle counts. Post writes
   ADJUSTMENT movements per non-zero variance line. Route lands in the Stocktake
   slice (#63); cloned now so the ledger schema is whole. */
export const stockTakes = pgTable('stock_takes', {
  id:              uuid('id').primaryKey().defaultRandom(),
  takeNo:          text('take_no').notNull().unique(),              // STK-YYMM-NNN
  status:          text('status').notNull().default('OPEN'),        // OPEN|POSTED|CANCELLED
  warehouseId:     uuid('warehouse_id').notNull().references(() => mfgWarehouses.id, { onDelete: 'restrict' }),
  scopeType:       text('scope_type').notNull().default('ALL'),     // ALL|CATEGORY|CODE_PREFIX
  scopeValue:      text('scope_value'),
  takeDate:        date('take_date').notNull().defaultNow(),
  notes:           text('notes'),
  postedAt:        timestamp('posted_at', { withTimezone: true }),
  cancelledAt:     timestamp('cancelled_at', { withTimezone: true }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:       integer('created_by'),  // SEAM rule #4
}, (t) => ({
  idxStatus:    index('idx_stock_takes_status').on(t.status, t.takeDate),
  idxWarehouse: index('idx_stock_takes_warehouse').on(t.warehouseId),
  statusEnum:   check('stock_takes_status_chk',     sql`status IN ('OPEN','POSTED','CANCELLED')`),
  scopeEnum:    check('stock_takes_scope_type_chk', sql`scope_type IN ('ALL','CATEGORY','CODE_PREFIX')`),
}));

export const stockTakeLines = pgTable('stock_take_lines', {
  id:              uuid('id').primaryKey().defaultRandom(),
  stockTakeId:     uuid('stock_take_id').notNull().references(() => stockTakes.id, { onDelete: 'cascade' }),
  productCode:     text('product_code').notNull(),
  productName:     text('product_name'),
  systemQty:       integer('system_qty').notNull().default(0),  // snapshot at create time
  countedQty:      integer('counted_qty'),                      // nullable until entered
  // GENERATED ALWAYS in the DB; modeled as a plain integer for reads.
  variance:        integer('variance'),
  notes:           text('notes'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxTake:    index('idx_stock_take_lines_take').on(t.stockTakeId),
  uniqLine:   uniqueIndex('stock_take_lines_take_product_unique').on(t.stockTakeId, t.productCode),
}));

export const inventoryLotConsumptions = pgTable('inventory_lot_consumptions', {
  id:             uuid('id').primaryKey().defaultRandom(),
  lotId:          uuid('lot_id').notNull().references(() => inventoryLots.id, { onDelete: 'cascade' }),
  warehouseId:    uuid('warehouse_id').notNull().references(() => mfgWarehouses.id, { onDelete: 'restrict' }),
  productCode:    text('product_code').notNull(),
  variantKey:     text('variant_key').notNull().default(''),  // migration 0095
  qtyConsumed:    integer('qty_consumed').notNull(),
  unitCostSen:    integer('unit_cost_sen').notNull(),
  totalCostSen:   integer('total_cost_sen').notNull(),
  consumedAt:     timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
  sourceDocType:  text('source_doc_type'),
  sourceDocId:    uuid('source_doc_id'),
  sourceDocNo:    text('source_doc_no'),
  movementId:     uuid('movement_id'),
  createdBy:      integer('created_by'),  // SEAM rule #4
}, (t) => ({
  idxLot:      index('idx_inv_cons_lot').on(t.lotId),
  idxDoc:      index('idx_inv_cons_doc').on(t.sourceDocType, t.sourceDocId),
  idxConsumed: index('idx_inv_cons_consumed').on(t.consumedAt),
}));

/* ── Warehouse rack/bin management (2990s migration 0094, ported from Hookka) ──
   A physical-location layer on top of warehouses: each warehouse splits into
   racks, each rack holds zero-to-many items, every stock-in/out/transfer is an
   append-only rack movement. Status (OCCUPIED/RESERVED/EMPTY) is derived but
   persisted so the rack-grid list stays a single SELECT. Complementary to (not
   a replacement for) the FIFO ledger above. TEXT + CHECK (not pgEnum), verbatim. */
export const warehouseRacks = pgTable('warehouse_racks', {
  id:          uuid('id').primaryKey().defaultRandom(),
  warehouseId: uuid('warehouse_id').notNull().references(() => mfgWarehouses.id, { onDelete: 'cascade' }),
  rack:        text('rack').notNull(),                // 'Rack 1' … 'Rack N' — unique per warehouse
  position:    text('position'),                      // optional finer position
  status:      text('status').notNull().default('EMPTY'),  // 'OCCUPIED' | 'EMPTY' | 'RESERVED'
  reserved:    boolean('reserved').notNull().default(false),
  notes:       text('notes'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqWhRack:   uniqueIndex('warehouse_racks_warehouse_rack_key').on(t.warehouseId, t.rack),
  idxWarehouse: index('idx_warehouse_racks_warehouse').on(t.warehouseId, t.rack),
  idxStatus:    index('idx_warehouse_racks_status').on(t.status),
  statusEnum:   check('warehouse_racks_status_chk', sql`status IN ('OCCUPIED','EMPTY','RESERVED')`),
}));

export const warehouseRackItems = pgTable('warehouse_rack_items', {
  id:            uuid('id').primaryKey().defaultRandom(),
  rackId:        uuid('rack_id').notNull().references(() => warehouseRacks.id, { onDelete: 'cascade' }),
  productCode:   text('product_code').notNull(),
  variantKey:    text('variant_key').notNull().default(''),  // aligns with inventory buckets
  productName:   text('product_name'),
  sizeLabel:     text('size_label'),
  customerName:  text('customer_name'),
  sourceDocNo:   text('source_doc_no'),               // optional ref to the SO/doc that stocked it in
  qty:           integer('qty').notNull().default(1),
  stockedInDate: date('stocked_in_date').notNull().defaultNow(),
  notes:         text('notes'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxRack:    index('idx_warehouse_rack_items_rack').on(t.rackId),
  idxProduct: index('idx_warehouse_rack_items_product').on(t.productCode),
  qtyPos:     check('warehouse_rack_items_qty_pos', sql`qty > 0`),
}));

export const warehouseRackMovements = pgTable('warehouse_rack_movements', {
  id:           uuid('id').primaryKey().defaultRandom(),
  movementType: text('movement_type').notNull(),      // 'STOCK_IN' | 'STOCK_OUT' | 'TRANSFER'
  // Kept loose (no FK) so history survives a rack being deleted/renamed — the
  // rack_label snapshot preserves the display.
  rackId:       uuid('rack_id'),
  rackLabel:    text('rack_label'),
  toRackId:     uuid('to_rack_id'),     // TRANSFER destination (rackId = source)
  toRackLabel:  text('to_rack_label'),
  warehouseId:  uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  productCode:  text('product_code'),
  variantKey:   text('variant_key').notNull().default(''),
  productName:  text('product_name'),
  sourceDocNo:  text('source_doc_no'),
  quantity:     integer('quantity').notNull().default(1),
  reason:       text('reason'),
  performedBy:  integer('performed_by'),  // SEAM rule #4
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxType:    index('idx_warehouse_rack_movements_type').on(t.movementType),
  idxRack:    index('idx_warehouse_rack_movements_rack').on(t.rackId),
  idxCreated: index('idx_warehouse_rack_movements_created').on(t.createdAt),
  typeEnum:   check('warehouse_rack_movements_type_chk',
    sql`movement_type IN ('STOCK_IN','STOCK_OUT','TRANSFER')`),
}));

// ── Purchase Invoice + Purchase Return slice (1:1 clone of 2990s) ───────────
// Copied VERBATIM from 2990s packages/db/src/schema.ts:
//   purchase_invoice_status (enum, ~L1053), purchase_invoices (~L1129),
//   purchase_invoice_items (~L1155), purchase_return_status (~L1772),
//   purchase_returns (~L1778), purchase_return_items (~L1801). camelCase keys +
//   snake_case column strings + the real pgEnums, so the ported /purchase-invoices
//   + /purchase-returns routes reference these unchanged.
//
// Document flow: PO -> GRN -> {Purchase Invoice (AP), Purchase Return (return to
// supplier)}. A PI is a FINANCE record (no stock impact — that landed at GRN
// time); on post it bumps grn_items.invoiced_qty. A PR is a stock-OUT (returns
// goods to the supplier); on post it writes inventory OUT movements + bumps
// grn_items.returned_qty + recomputes the parent PO's received_qty.
//
// NO AutoCount collision (Houzs has none of these tables) -> BARE physical names
// + bare export keys (rule #1). All later-migration columns are folded in so the
// schema is the FINAL shape migration 0028 creates: PI variant/discount/unit-cost
// fields (2990s mig 0057), paid_centi + statuses, PR variant fields (0057).
//
// Only the documented SEAMS change vs 2990s:
//   - createdBy: 2990s uuid -> staff.id. rule #4 -> Houzs users.id is serial
//     INTEGER; SOFT ref (no FK), matching the PO/GRN/inventory slices.
//   - supplierId -> suppliers(id) REAL FK (restrict), exactly as 2990s.
//   - purchaseOrderId -> mfg_purchase_orders(id) (the cloned PO table); nullable
//     REAL FK (set null) — 2990s declares it nullable on PI/PR too.
//   - grnId -> grns(id) nullable REAL FK (set null), exactly as 2990s.
//   - item grnItemId -> grn_items(id) nullable REAL FK (set null), as 2990s.
//   - GL/accounting AP-posting is OUT OF SCOPE (Houzs GL differs) — the schema is
//     unaffected (2990s posts to a separate chart-of-accounts; no PI/PR column).

export const purchaseInvoiceStatus = pgEnum('purchase_invoice_status', [
  'POSTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
]);

export const purchaseInvoices = pgTable('purchase_invoices', {
  id:                uuid('id').primaryKey().defaultRandom(),
  invoiceNumber:     text('invoice_number').notNull().unique(),     // 'PI-2605-001' (ours)
  supplierInvoiceRef: text('supplier_invoice_ref'),                 // supplier's invoice number
  supplierId:        uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  // SEAM: -> mfg_purchase_orders (the cloned PO table); nullable as 2990s.
  purchaseOrderId:   uuid('purchase_order_id').references(() => purchaseOrders.id, { onDelete: 'set null' }),
  grnId:             uuid('grn_id').references(() => grns.id, { onDelete: 'set null' }),
  invoiceDate:       date('invoice_date').notNull().defaultNow(),
  dueDate:           date('due_date'),
  currency:          currencyCode('currency').notNull().default('MYR'),
  subtotalCenti:     integer('subtotal_centi').notNull().default(0),
  taxCenti:          integer('tax_centi').notNull().default(0),
  totalCenti:        integer('total_centi').notNull().default(0),
  paidCenti:         integer('paid_centi').notNull().default(0),
  status:            purchaseInvoiceStatus('status').notNull().default('POSTED'),
  notes:             text('notes'),
  postedAt:          timestamp('posted_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // SEAM (rule #4): 2990s uuid -> staff.id. Houzs users.id is serial INTEGER; soft ref.
  createdBy:         integer('created_by').notNull(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSupplier: index('idx_pi_supplier').on(t.supplierId),
  idxPo:       index('idx_pi_po').on(t.purchaseOrderId),
  idxStatus:   index('idx_pi_status').on(t.status),
}));

export const purchaseInvoiceItems = pgTable('purchase_invoice_items', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  purchaseInvoiceId:   uuid('purchase_invoice_id').notNull().references(() => purchaseInvoices.id, { onDelete: 'cascade' }),
  grnItemId:           uuid('grn_item_id').references(() => grnItems.id, { onDelete: 'set null' }),
  materialKind:        materialKind('material_kind').notNull(),
  materialCode:        text('material_code').notNull(),
  materialName:        text('material_name').notNull(),
  qty:                 integer('qty').notNull(),
  unitPriceCenti:      integer('unit_price_centi').notNull(),
  lineTotalCenti:      integer('line_total_centi').notNull(),
  notes:               text('notes'),
  /* 2990s PR #42 — variant fields (migration 0057). Strategy-2: KEPT for fidelity;
     the Houzs UI does not surface the sofa-variant editor (generic fields only). */
  gapInches:             integer('gap_inches'),
  divanHeightInches:     integer('divan_height_inches'),
  divanPriceSen:         integer('divan_price_sen').notNull().default(0),
  legHeightInches:       integer('leg_height_inches'),
  legPriceSen:           integer('leg_price_sen').notNull().default(0),
  customSpecials:        jsonb('custom_specials'),
  lineSuffix:            text('line_suffix'),
  specialOrderPriceSen:  integer('special_order_price_sen').notNull().default(0),
  variants:              jsonb('variants'),
  itemGroup:             text('item_group'),
  description:           text('description'),
  description2:          text('description2'),
  uom:                   text('uom').notNull().default('UNIT'),
  discountCenti:         integer('discount_centi').notNull().default(0),
  unitCostCenti:         integer('unit_cost_centi').notNull().default(0),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPi: index('idx_pi_items_pi').on(t.purchaseInvoiceId),
}));

export const purchaseReturnStatus = pgEnum('purchase_return_status', [
  'POSTED',      // created + sent to supplier, awaiting confirmation (default on create)
  'COMPLETED',   // supplier confirmed refund / credit-note
  'CANCELLED',   // returned items kept after all
]);

export const purchaseReturns = pgTable('purchase_returns', {
  id:                uuid('id').primaryKey().defaultRandom(),
  returnNumber:      text('return_number').notNull().unique(),       // 'PRT-2605-001'
  // SEAM: -> mfg_purchase_orders (the cloned PO table); nullable as 2990s.
  purchaseOrderId:   uuid('purchase_order_id').references(() => purchaseOrders.id, { onDelete: 'set null' }),
  grnId:             uuid('grn_id').references(() => grns.id, { onDelete: 'set null' }),
  supplierId:        uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  returnDate:        date('return_date').notNull().defaultNow(),
  reason:            text('reason'),                                 // 'DEFECT'|'WRONG_ITEM'|'OVERSUPPLY'|free text
  status:            purchaseReturnStatus('status').notNull().default('POSTED'),
  postedAt:          timestamp('posted_at', { withTimezone: true }),
  completedAt:       timestamp('completed_at', { withTimezone: true }),
  creditNoteRef:     text('credit_note_ref'),                        // supplier's CN# once issued
  refundCenti:       integer('refund_centi').notNull().default(0),
  notes:             text('notes'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // SEAM (rule #4): 2990s uuid -> staff.id. Houzs users.id is serial INTEGER; soft ref.
  createdBy:         integer('created_by').notNull(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPo:       index('idx_pr_po').on(t.purchaseOrderId),
  idxSupplier: index('idx_pr_supplier').on(t.supplierId),
  idxStatus:   index('idx_pr_status').on(t.status),
}));

export const purchaseReturnItems = pgTable('purchase_return_items', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  purchaseReturnId:      uuid('purchase_return_id').notNull().references(() => purchaseReturns.id, { onDelete: 'cascade' }),
  grnItemId:             uuid('grn_item_id').references(() => grnItems.id, { onDelete: 'set null' }),
  materialKind:          materialKind('material_kind').notNull(),
  materialCode:          text('material_code').notNull(),
  materialName:          text('material_name').notNull(),
  qtyReturned:           integer('qty_returned').notNull(),
  unitPriceCenti:        integer('unit_price_centi').notNull().default(0),
  lineRefundCenti:       integer('line_refund_centi').notNull().default(0),
  reason:                text('reason'),                             // per-line reason if mixed
  notes:                 text('notes'),
  /* 2990s PR #42 — variant fields (migration 0057). Strategy-2: KEPT for fidelity. */
  gapInches:             integer('gap_inches'),
  divanHeightInches:     integer('divan_height_inches'),
  divanPriceSen:         integer('divan_price_sen').notNull().default(0),
  legHeightInches:       integer('leg_height_inches'),
  legPriceSen:           integer('leg_price_sen').notNull().default(0),
  customSpecials:        jsonb('custom_specials'),
  lineSuffix:            text('line_suffix'),
  specialOrderPriceSen:  integer('special_order_price_sen').notNull().default(0),
  variants:              jsonb('variants'),
  itemGroup:             text('item_group'),
  description:           text('description'),
  description2:          text('description2'),
  uom:                   text('uom').notNull().default('UNIT'),
  createdAt:             timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPr: index('idx_pr_items_pr').on(t.purchaseReturnId),
}));

/* ════════════════════════════════════════════════════════════════════════
   SALES ORDERS slice — 1:1 clone of 2990s (packages/db/src/schema.ts:
   customers L513, mfgSalesOrders L1210, mfgSalesOrderItems L1379 + the SO
   audit / payment tables L1483-1572). BARE names (Houzs has `sales_orders`
   (AutoCount, different name) + no `customers`/`mfg_sales_orders`), so no
   collision -> verbatim 2990s names.

   Defs copied verbatim (camelCase keys + snake_case cols + enums). KEPT all
   columns incl. the furniture variant/pricing cols for fidelity. The only
   deviations are the documented seams:
     - staff.id (uuid) refs (created_by / salesperson_id / changed_by /
       approved_by / actor_id / collected_by) -> Houzs users.id (INTEGER)
       soft-refs, no FK (rule #4). Houzs `users` is a separate auth table.
     - venue_id / hub_id / customer_po_id -> nullable columns, FK DROPPED
       (Houzs has no venues / delivery_hubs; kept for fidelity, soft).
     - warehouse_id (per-line) -> real FK to mfg_warehouses (nullable soft
       binding; same as the PO/GRN slices).
     - customer_id -> real FK to the cloned `customers` table.
   currencyCode + the money centi columns are reused verbatim. The retail
   `orders` table + `venues`/`showrooms`/`my_localities` masters are NOT
   cloned (out of scope); columns that referenced them become soft text/uuid.
   ════════════════════════════════════════════════════════════════════════ */

// Generic customer directory (2990s schema.ts:513). Clean 1:1 clone — no seam.
export const customers = pgTable('customers', {
  id:           uuid('id').primaryKey().defaultRandom(),
  name:         text('name').notNull(),
  phone:        text('phone'),                    // normalized intl format
  email:        text('email'),
  // Human-readable shareable code (minted on first create in 2990s via an RPC;
  // Houzs leaves it nullable — no minting wired this slice).
  customerCode: text('customer_code'),
  address:      text('address'),
  addressLine2: text('address_line2'),
  postcode:     text('postcode'),
  city:         text('city'),
  state:        text('state'),
  notes:        text('notes'),
  firstSeenAt:  timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt:   timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  phoneIdx: index('idx_customers_phone').on(t.phone),
  /* One customer per normalised (name, phone). Partial so legacy phone-less
     rows don't collide on a NULL phone. */
  namePhoneUnique: uniqueIndex('customers_name_phone_unique')
    .on(sql`lower(trim(${t.name}))`, t.phone)
    .where(sql`${t.phone} IS NOT NULL`),
  customerCodeUnique: uniqueIndex('customers_customer_code_unique')
    .on(t.customerCode)
    .where(sql`${t.customerCode} IS NOT NULL`),
}));

// SO header status (2990s mfgSoStatus, schema.ts:1196).
export const mfgSoStatus = pgEnum('mfg_so_status', [
  'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED',
  'DELIVERED', 'INVOICED', 'CLOSED', 'ON_HOLD', 'CANCELLED',
]);

// Slip review state for POS handover payment slips (2990s slipState,
// schema.ts:65). Cloned for fidelity (the SO header carries slip_state).
export const slipState = pgEnum('slip_state', [
  'none', 'pending', 'verified', 'flagged',
]);

export const mfgSalesOrders = pgTable('mfg_sales_orders', {
  // doc_no PK as TEXT — human-readable like 'SO-2606-001'
  docNo:             text('doc_no').primaryKey(),
  transferTo:        text('transfer_to'),
  soDate:            date('so_date').notNull().defaultNow(),
  branding:          text('branding'),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name').notNull(),
  agent:             text('agent'),
  salesLocation:     text('sales_location'),
  ref:               text('ref'),
  poDocNo:           text('po_doc_no'),                            // customer's PO
  venue:             text('venue'),
  // SEAM: 2990s FK -> venues(id). Houzs has no venues master -> nullable uuid,
  // no FK (kept for fidelity).
  venueId:           uuid('venue_id'),

  // Address fields (4 address lines + phone)
  address1:          text('address1'),
  address2:          text('address2'),
  address3:          text('address3'),
  address4:          text('address4'),
  phone:             text('phone'),

  // Money breakdown by category (denormalized for fast filter)
  mattressSofaCenti: integer('mattress_sofa_centi').notNull().default(0),
  bedframeCenti:     integer('bedframe_centi').notNull().default(0),
  accessoriesCenti:  integer('accessories_centi').notNull().default(0),
  othersCenti:       integer('others_centi').notNull().default(0),
  // Per-category COST breakdown (mirrors revenue columns).
  mattressSofaCostCenti: integer('mattress_sofa_cost_centi').notNull().default(0),
  bedframeCostCenti:     integer('bedframe_cost_centi').notNull().default(0),
  accessoriesCostCenti:  integer('accessories_cost_centi').notNull().default(0),
  othersCostCenti:       integer('others_cost_centi').notNull().default(0),
  // SERVICE lines (delivery fee / dispose / lift) own revenue bucket.
  serviceCenti:     integer('service_centi').notNull().default(0),
  serviceCostCenti: integer('service_cost_centi').notNull().default(0),
  localTotalCenti:   integer('local_total_centi').notNull().default(0),
  balanceCenti:      integer('balance_centi').notNull().default(0),

  totalCostCenti:    integer('total_cost_centi').notNull().default(0),
  totalRevenueCenti: integer('total_revenue_centi').notNull().default(0),
  totalMarginCenti:  integer('total_margin_centi').notNull().default(0),
  marginPctBasis:    integer('margin_pct_basis').notNull().default(0), // × 100 (e.g. 23.50% = 2350)
  lineCount:         integer('line_count').notNull().default(0),
  // Fabric-tier SELLING add-on total (reporting snapshot — furniture; KEPT).
  fabricTierAddonCenti: integer('fabric_tier_addon_centi').notNull().default(0),
  // Delivery fee in sen — folded into local_total/revenue/balance/margin.
  deliveryFeeCenti:  integer('delivery_fee_centi').notNull().default(0),
  // Cross-category delivery link (the earlier SO this SO was linked back to).
  crossCategorySourceDocNo: text('cross_category_source_doc_no'),

  currency:          currencyCode('currency').notNull().default('MYR'),
  status:            mfgSoStatus('status').notNull().default('CONFIRMED'),
  remark2:           text('remark2'),
  remark3:           text('remark3'),
  remark4:           text('remark4'),
  note:              text('note'),
  processingDate:    date('processing_date'),
  // POS "Proceed" stamp — auto-set on the FIRST transition to IN_PRODUCTION.
  proceededAt:       timestamp('proceeded_at', { withTimezone: true }),
  salesExemptionExpiry: date('sales_exemption_expiry'),

  // Customer master link (existing customers table) — debtor_name kept as a
  // denormalised snapshot for display speed.
  customerId:        uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  customerState:     text('customer_state'),
  // Country snapshot auto-derived from customer_state.
  customerCountry:   text('customer_country'),
  // Customer PO — 3 structured fields + optional scanned image base64
  customerPo:        text('customer_po'),
  customerPoId:      text('customer_po_id'),
  customerPoDate:    date('customer_po_date'),
  customerPoImageB64: text('customer_po_image_b64'),
  // Customer's own SO number from their ERP.
  customerSoNo:      text('customer_so_no'),
  // Multi-branch customer (nullable uuid + snapshot text).
  hubId:             uuid('hub_id'),
  hubName:           text('hub_name'),
  // Delivery date granularity
  customerDeliveryDate: date('customer_delivery_date'),
  internalExpectedDd: date('internal_expected_dd'),
  linkedDoDocNo:     text('linked_do_doc_no'),
  // Multi-address (in addition to legacy address1-4)
  shipToAddress:     text('ship_to_address'),
  billToAddress:     text('bill_to_address'),
  installToAddress:  text('install_to_address'),
  // Money + overdue
  subtotalSen:       integer('subtotal_sen'),
  overdue:           text('overdue'),                       // 'PENDING' | 'DUE' | 'OVERDUE' | null

  // POS handover customer/address/emergency/target-date round-trip.
  email:                          text('email'),
  customerType:                   text('customer_type'),              // 'NEW' | 'EXISTING'
  // SEAM: 2990s FK -> staff(id) uuid. Houzs users.id INTEGER soft-ref (rule #4).
  salespersonId:                  integer('salesperson_id'),
  city:                           text('city'),
  postcode:                       text('postcode'),
  buildingType:                   text('building_type'),              // Condo / Landed / Apartment / Office / Shop / Other
  emergencyContactName:           text('emergency_contact_name'),
  emergencyContactPhone:          text('emergency_contact_phone'),
  emergencyContactRelationship:   text('emergency_contact_relationship'),
  targetDate:                     date('target_date'),
  // POS handover customer signature (data URL, image/png base64).
  signatureB64:                   text('signature_b64'),
  // POS handover payment slip (R2 key) + coordinator review state.
  slipKey:                        text('slip_key'),
  slipState:                      slipState('slip_state').notNull().default('none'),

  // Payment fields mirrored from POS handover (free text here).
  paymentMethod:        text('payment_method'),       // cash | transfer | merchant
  installmentMonths:    integer('installment_months'), // 6 | 12 — NULL = normal swipe
  merchantProvider:     text('merchant_provider'),    // GHL | HLB | MBB | PBB
  approvalCode:         text('approval_code'),        // auth / slip / receipt no
  paymentDate:          date('payment_date'),
  depositCenti:         integer('deposit_centi').notNull().default(0),
  paidCenti:            integer('paid_centi').notNull().default(0),

  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // SEAM: 2990s FK -> staff(id) uuid. Houzs users.id INTEGER soft-ref (rule #4).
  createdBy:         integer('created_by'),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDate:     index('idx_mso_date').on(t.soDate),
  idxDebtor:   index('idx_mso_debtor').on(t.debtorCode),
  idxStatus:   index('idx_mso_status').on(t.status),
  idxBranding: index('idx_mso_branding').on(t.branding),
  idxCustomer: index('idx_mso_customer').on(t.customerId),
}));

export const mfgSalesOrderItems = pgTable('mfg_sales_order_items', {
  id:                uuid('id').primaryKey().defaultRandom(),
  docNo:             text('doc_no').notNull().references(() => mfgSalesOrders.docNo, { onDelete: 'cascade' }),
  lineDate:          date('line_date').notNull().defaultNow(),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name'),
  agent:             text('agent'),
  itemGroup:         text('item_group').notNull(),                 // bedframe/sofa/mattress/accessory/others
  itemCode:          text('item_code').notNull(),
  description:       text('description'),
  description2:      text('description2'),
  uom:               text('uom').notNull().default('UNIT'),
  location:          text('location'),
  // Per-LINE ship-from warehouse (the warehouse binding). Real FK to
  // mfg_warehouses (nullable soft binding; same as the PO/GRN slices).
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  qty:               integer('qty').notNull().default(1),
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),
  discountCenti:     integer('discount_centi').notNull().default(0),
  totalCenti:        integer('total_centi').notNull().default(0),
  taxCenti:          integer('tax_centi').notNull().default(0),
  totalIncCenti:     integer('total_inc_centi').notNull().default(0),
  balanceCenti:      integer('balance_centi').notNull().default(0),
  paymentStatus:     text('payment_status').notNull().default('Unchecked'),
  venue:             text('venue'),
  branding:          text('branding'),
  remark:            text('remark'),
  cancelled:         boolean('cancelled').notNull().default(false),
  variants:          jsonb('variants'),                             // {fabric, gap, divanHeight, legHeight, ...}
  unitCostCenti:     integer('unit_cost_centi').notNull().default(0),
  lineCostCenti:     integer('line_cost_centi').notNull().default(0),
  lineMarginCenti:   integer('line_margin_centi').notNull().default(0),

  // Bedframe variant pricing + sofa line suffix + free-text custom specials
  // (furniture; KEPT for fidelity, no configurator UI per Strategy-2).
  gapInches:         integer('gap_inches'),
  divanHeightInches: integer('divan_height_inches'),
  divanPriceSen:     integer('divan_price_sen').notNull().default(0),
  legHeightInches:   integer('leg_height_inches'),
  legPriceSen:       integer('leg_price_sen').notNull().default(0),
  customSpecials:    jsonb('custom_specials'),               // [{ description, surchargeSen }]
  lineSuffix:        text('line_suffix'),                    // '-01', '-02' for sofa modules
  specialOrderPriceSen: integer('special_order_price_sen').notNull().default(0),

  // How much of this line has been emitted to one or more POs (cumulative).
  // Remaining convertible = qty - po_qty_picked. Recounted by recomputeSoPicked
  // in the PO route (now wired).
  poQtyPicked:       integer('po_qty_picked').notNull().default(0),

  // Per-item delivery date with master-follower cascade.
  lineDeliveryDate:            date('line_delivery_date'),
  lineDeliveryDateOverridden:  boolean('line_delivery_date_overridden').notNull().default(false),

  // Per-line photos for customisation orders (R2 object keys).
  photoUrls:         text('photo_urls').array().notNull().default([]),

  // Per-line fulfillment flag. PENDING -> READY when stock arrives (manual or
  // auto-from-inventory via recomputeSoStockAllocation). Drives the Stock
  // Status chip + auto-advance to READY_TO_SHIP.
  stockStatus:       text('stock_status').notNull().default('PENDING'),
  // How much of qty is currently allocated/ready (written by allocation).
  stockQtyReady:     integer('stock_qty_ready').notNull().default(0),
  // SOFA whole-set batch lock (furniture; KEPT for fidelity, no sofa allocator
  // wired per Strategy-2).
  allocatedBatchNo:  text('allocated_batch_no'),

  // Explicit per-SO line sequence (listing order). NULL on legacy rows.
  lineNo:            integer('line_no'),

  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDoc:       index('idx_mso_items_doc').on(t.docNo),
  idxItemCode:  index('idx_mso_items_item').on(t.itemCode),
  idxItemGroup: index('idx_mso_items_group').on(t.itemGroup),
}));

/* SO audit trails — two append-only tables driving the SO detail history. */
export const mfgSoStatusChanges = pgTable('mfg_so_status_changes', {
  id:           uuid('id').primaryKey().defaultRandom(),
  docNo:        text('doc_no').notNull().references(() => mfgSalesOrders.docNo, { onDelete: 'cascade' }),
  fromStatus:   text('from_status'),
  toStatus:     text('to_status').notNull(),
  // SEAM: staff(id) uuid -> Houzs users.id INTEGER soft-ref.
  changedBy:    integer('changed_by'),
  notes:        text('notes'),
  autoActions:  jsonb('auto_actions'),                       // string[]
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDoc: index('idx_so_status_changes_doc').on(t.docNo),
  idxAt:  index('idx_so_status_changes_at').on(t.createdAt),
}));

export const mfgSoPriceOverrides = pgTable('mfg_so_price_overrides', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  docNo:              text('doc_no').notNull().references(() => mfgSalesOrders.docNo, { onDelete: 'cascade' }),
  itemId:             uuid('item_id').notNull().references(() => mfgSalesOrderItems.id, { onDelete: 'cascade' }),
  itemCode:           text('item_code').notNull(),
  originalPriceSen:   integer('original_price_sen').notNull(),
  overridePriceSen:   integer('override_price_sen').notNull(),
  reason:             text('reason'),
  // SEAM: staff(id) uuid -> Houzs users.id INTEGER soft-ref.
  approvedBy:         integer('approved_by'),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDoc:  index('idx_so_overrides_doc').on(t.docNo),
  idxItem: index('idx_so_overrides_item').on(t.itemId),
}));

/* Unified SO audit trail — insert-only, captures every mutation type with
   field-level from->to diffs in field_changes. */
export const mfgSoAuditLog = pgTable('mfg_so_audit_log', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  soDocNo:            text('so_doc_no').notNull().references(() => mfgSalesOrders.docNo, { onDelete: 'cascade' }),
  action:             text('action').notNull(),
  // SEAM: staff(id) uuid -> Houzs users.id INTEGER soft-ref.
  actorId:            integer('actor_id'),
  actorNameSnapshot:  text('actor_name_snapshot'),
  fieldChanges:       jsonb('field_changes').notNull().default([]),
  statusSnapshot:     text('status_snapshot'),
  source:             text('source').default('web'),
  note:               text('note'),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDoc:   index('idx_msoaudit_doc').on(t.soDocNo),
  idxDocAt: index('idx_msoaudit_doc_at').on(t.soDocNo, t.createdAt),
  idxActor: index('idx_msoaudit_actor').on(t.actorId),
}));

/* Payments as transactions — each receipt is one row (total paid =
   sum(amount_centi) per so_doc_no). */
export const mfgSalesOrderPayments = pgTable('mfg_sales_order_payments', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  soDocNo:            text('so_doc_no').notNull().references(() => mfgSalesOrders.docNo, { onDelete: 'cascade' }),
  paidAt:             date('paid_at').notNull().defaultNow(),
  method:             text('method').notNull(),               // 'merchant' | 'transfer' | 'cash' | 'installment'
  merchantProvider:   text('merchant_provider'),
  installmentMonths:  integer('installment_months'),
  // Online sub-type (Bank Transfer / TNG / Cheque / DuitNow).
  onlineType:         text('online_type'),
  approvalCode:       text('approval_code'),
  amountCenti:        integer('amount_centi').notNull(),
  accountSheet:       text('account_sheet'),
  slipKey:            text('slip_key'),
  // SEAM: staff(id) uuid -> Houzs users.id INTEGER soft-ref.
  collectedBy:        integer('collected_by'),
  note:               text('note'),
  // True on the auto-row the SO POST writes for a POS deposit.
  isDeposit:          boolean('is_deposit').notNull().default(false),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // SEAM: staff(id) uuid -> Houzs users.id INTEGER soft-ref.
  createdBy:          integer('created_by'),
}, (t) => ({
  idxDoc:    index('idx_msop_doc').on(t.soDocNo),
  idxPaidAt: index('idx_msop_paid_at').on(t.paidAt),
}));

/* ════════════════════════════════════════════════════════════════════════
   Delivery Orders + Sales Invoices + Delivery Returns (SCM #66 — order-to-cash
   downstream). 1:1 clone of 2990s delivery_orders / sales_invoices /
   delivery_returns (+ their items + the DO/SI payment ledgers). BARE names —
   Houzs has none of these tables. Columns reflect the LIVE 2990s schema (route
   field-set with migrations 0100/0101/0102/0165 folded in — packages/db/src/
   schema.ts is the pre-rebuild version and is NOT the source of truth here; the
   routes are). Seams (docs/scm-clone/PLAN.md, identical to prior slices):
     - created_by / salesperson_id / collected_by: 2990s staff(id) uuid -> Houzs
       users.id INTEGER soft-ref (rule #4). No FK (cross-domain).
     - so_doc_no -> real FK mfg_sales_orders(doc_no); delivery_order_id /
       so_item_id / do_item_id / sales_invoice_id -> real FKs to the cloned
       tables; warehouse_id -> real FK mfg_warehouses(id) (nullable soft).
     - driver_id / venue_id -> nullable uuid columns, FK DROPPED (Houzs has no
       drivers / venues master); money kept centi-internal (rule #5).
   ════════════════════════════════════════════════════════════════════════ */

// DO header status (2990s doStatus, schema.ts:1201).
export const doStatus = pgEnum('do_status', [
  'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED',
  'DELIVERED', 'INVOICED', 'CANCELLED',
]);

// SI header status (2990s salesInvoiceStatus, schema.ts:1206).
export const salesInvoiceStatus = pgEnum('sales_invoice_status', [
  'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED',
]);

// DR header status (2990s deliveryReturnStatus, schema.ts:1714).
export const deliveryReturnStatus = pgEnum('delivery_return_status', [
  'PENDING', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CREDIT_NOTED', 'REJECTED', 'CANCELLED',
]);

/* Delivery Order — goods sent to the customer. */
export const deliveryOrders = pgTable('delivery_orders', {
  id:                uuid('id').primaryKey().defaultRandom(),
  doNumber:          text('do_number').notNull().unique(),           // 'DO-2605-001'
  soDocNo:           text('so_doc_no').references(() => mfgSalesOrders.docNo, { onDelete: 'set null' }),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name').notNull(),
  doDate:            date('do_date').notNull().defaultNow(),
  expectedDeliveryAt: date('expected_delivery_at'),
  customerDeliveryDate: date('customer_delivery_date'),
  signedAt:          timestamp('signed_at', { withTimezone: true }),
  deliveredAt:       timestamp('delivered_at', { withTimezone: true }),
  dispatchedAt:      timestamp('dispatched_at', { withTimezone: true }),

  // SEAM: drivers master not cloned -> nullable column, FK dropped.
  driverId:          uuid('driver_id'),
  driverName:        text('driver_name'),                            // snapshot
  vehicle:           text('vehicle'),
  m3Total:           integer('m3_total_milli').notNull().default(0), // × 1000

  // Address snapshot.
  address1:          text('address1'),
  address2:          text('address2'),
  city:              text('city'),
  state:             text('state'),
  postcode:          text('postcode'),
  phone:             text('phone'),

  // SO-clone header fields (migration 0100).
  salespersonId:     integer('salesperson_id'),                      // SEAM: users.id soft-ref
  agent:             text('agent'),
  email:             text('email'),
  customerType:      text('customer_type'),
  buildingType:      text('building_type'),
  branding:          text('branding'),
  venue:             text('venue'),
  venueId:           uuid('venue_id'),                               // SEAM: venues master not cloned
  ref:               text('ref'),
  customerSoNo:      text('customer_so_no'),
  poDocNo:           text('po_doc_no'),
  salesLocation:     text('sales_location'),
  customerState:     text('customer_state'),
  customerCountry:   text('customer_country'),
  note:              text('note'),
  emergencyContactName:         text('emergency_contact_name'),
  emergencyContactPhone:        text('emergency_contact_phone'),
  emergencyContactRelationship: text('emergency_contact_relationship'),

  // Per-category revenue + cost totals (migration 0100; recomputeTotals).
  mattressSofaCenti:     integer('mattress_sofa_centi').notNull().default(0),
  bedframeCenti:         integer('bedframe_centi').notNull().default(0),
  accessoriesCenti:      integer('accessories_centi').notNull().default(0),
  othersCenti:           integer('others_centi').notNull().default(0),
  serviceCenti:          integer('service_centi').notNull().default(0),
  mattressSofaCostCenti: integer('mattress_sofa_cost_centi').notNull().default(0),
  bedframeCostCenti:     integer('bedframe_cost_centi').notNull().default(0),
  accessoriesCostCenti:  integer('accessories_cost_centi').notNull().default(0),
  othersCostCenti:       integer('others_cost_centi').notNull().default(0),
  serviceCostCenti:      integer('service_cost_centi').notNull().default(0),
  localTotalCenti:       integer('local_total_centi').notNull().default(0),
  totalCostCenti:        integer('total_cost_centi').notNull().default(0),
  totalMarginCenti:      integer('total_margin_centi').notNull().default(0),
  marginPctBasis:        integer('margin_pct_basis').notNull().default(0),
  lineCount:             integer('line_count').notNull().default(0),

  currency:          currencyCode('currency').notNull().default('MYR'),
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  podR2Key:          text('pod_r2_key'),                             // proof of delivery photo
  signatureData:     text('signature_data'),                         // base64 png
  status:            doStatus('status').notNull().default('LOADED'),
  notes:             text('notes'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                          // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSo:     index('idx_do_so').on(t.soDocNo),
  idxStatus: index('idx_do_status').on(t.status),
  idxDate:   index('idx_do_date').on(t.doDate),
}));

export const deliveryOrderItems = pgTable('delivery_order_items', {
  id:                uuid('id').primaryKey().defaultRandom(),
  deliveryOrderId:   uuid('delivery_order_id').notNull().references(() => deliveryOrders.id, { onDelete: 'cascade' }),
  soItemId:          uuid('so_item_id').references(() => mfgSalesOrderItems.id, { onDelete: 'set null' }),
  itemCode:          text('item_code').notNull(),
  itemGroup:         text('item_group'),
  description:       text('description'),
  description2:      text('description2'),
  uom:               text('uom').notNull().default('UNIT'),
  qty:               integer('qty').notNull(),
  m3Milli:           integer('m3_milli').notNull().default(0),
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),
  discountCenti:     integer('discount_centi').notNull().default(0),
  lineTotalCenti:    integer('line_total_centi').notNull().default(0),
  unitCostCenti:     integer('unit_cost_centi').notNull().default(0),
  lineCostCenti:     integer('line_cost_centi').notNull().default(0),
  lineMarginCenti:   integer('line_margin_centi').notNull().default(0),
  notes:             text('notes'),
  // Variant columns (furniture; KEPT nullable for fidelity, no configurator UI).
  gapInches:             integer('gap_inches'),
  divanHeightInches:     integer('divan_height_inches'),
  divanPriceSen:         integer('divan_price_sen').notNull().default(0),
  legHeightInches:       integer('leg_height_inches'),
  legPriceSen:           integer('leg_price_sen').notNull().default(0),
  customSpecials:        jsonb('custom_specials'),
  lineSuffix:            text('line_suffix'),
  specialOrderPriceSen:  integer('special_order_price_sen').notNull().default(0),
  variants:              jsonb('variants'),
  lineDeliveryDate:            date('line_delivery_date'),
  lineDeliveryDateOverridden:  boolean('line_delivery_date_overridden').notNull().default(false),
  lineNo:            integer('line_no'),                             // migration 0165 — listing order
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDo:     index('idx_do_items_do').on(t.deliveryOrderId),
  idxSoItem: index('idx_do_items_so_item').on(t.soItemId),
}));

/* DO payment ledger (migration 0100 — mirrors mfg_sales_order_payments). */
export const deliveryOrderPayments = pgTable('delivery_order_payments', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  deliveryOrderId:    uuid('delivery_order_id').notNull().references(() => deliveryOrders.id, { onDelete: 'cascade' }),
  paidAt:             date('paid_at').notNull().defaultNow(),
  method:             text('method').notNull(),                      // merchant | transfer | cash | installment
  merchantProvider:   text('merchant_provider'),
  installmentMonths:  integer('installment_months'),
  onlineType:         text('online_type'),
  approvalCode:       text('approval_code'),
  amountCenti:        integer('amount_centi').notNull(),
  accountSheet:       text('account_sheet'),
  collectedBy:        integer('collected_by'),                       // SEAM: users.id soft-ref
  note:               text('note'),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:          integer('created_by'),                         // SEAM: users.id soft-ref
}, (t) => ({
  idxDo: index('idx_dop_do').on(t.deliveryOrderId),
}));

/* Sales Invoice — we bill the customer. */
export const salesInvoices = pgTable('sales_invoices', {
  id:                uuid('id').primaryKey().defaultRandom(),
  invoiceNumber:     text('invoice_number').notNull().unique(),      // 'SI-2605-001'
  soDocNo:           text('so_doc_no').references(() => mfgSalesOrders.docNo, { onDelete: 'set null' }),
  deliveryOrderId:   uuid('delivery_order_id').references(() => deliveryOrders.id, { onDelete: 'set null' }),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name').notNull(),
  invoiceDate:       date('invoice_date').notNull().defaultNow(),
  dueDate:           date('due_date'),
  customerDeliveryDate: date('customer_delivery_date'),
  currency:          currencyCode('currency').notNull().default('MYR'),
  subtotalCenti:     integer('subtotal_centi').notNull().default(0),
  discountCenti:     integer('discount_centi').notNull().default(0),
  taxCenti:          integer('tax_centi').notNull().default(0),
  totalCenti:        integer('total_centi').notNull().default(0),
  paidCenti:         integer('paid_centi').notNull().default(0),

  // SO/DO-clone header fields (migration 0101).
  salespersonId:     integer('salesperson_id'),                      // SEAM: users.id soft-ref
  agent:             text('agent'),
  email:             text('email'),
  customerType:      text('customer_type'),
  buildingType:      text('building_type'),
  branding:          text('branding'),
  venue:             text('venue'),
  venueId:           uuid('venue_id'),
  ref:               text('ref'),
  customerSoNo:      text('customer_so_no'),
  poDocNo:           text('po_doc_no'),
  salesLocation:     text('sales_location'),
  customerState:     text('customer_state'),
  customerCountry:   text('customer_country'),
  note:              text('note'),
  address1:          text('address1'),
  address2:          text('address2'),
  city:              text('city'),
  state:             text('state'),
  postcode:          text('postcode'),
  phone:             text('phone'),
  emergencyContactName:         text('emergency_contact_name'),
  emergencyContactPhone:        text('emergency_contact_phone'),
  emergencyContactRelationship: text('emergency_contact_relationship'),

  // Per-category revenue + cost totals (migration 0101; recomputeTotals).
  mattressSofaCenti:     integer('mattress_sofa_centi').notNull().default(0),
  bedframeCenti:         integer('bedframe_centi').notNull().default(0),
  accessoriesCenti:      integer('accessories_centi').notNull().default(0),
  othersCenti:           integer('others_centi').notNull().default(0),
  serviceCenti:          integer('service_centi').notNull().default(0),
  mattressSofaCostCenti: integer('mattress_sofa_cost_centi').notNull().default(0),
  bedframeCostCenti:     integer('bedframe_cost_centi').notNull().default(0),
  accessoriesCostCenti:  integer('accessories_cost_centi').notNull().default(0),
  othersCostCenti:       integer('others_cost_centi').notNull().default(0),
  serviceCostCenti:      integer('service_cost_centi').notNull().default(0),
  localTotalCenti:       integer('local_total_centi').notNull().default(0),
  totalCostCenti:        integer('total_cost_centi').notNull().default(0),
  totalMarginCenti:      integer('total_margin_centi').notNull().default(0),
  marginPctBasis:        integer('margin_pct_basis').notNull().default(0),
  lineCount:             integer('line_count').notNull().default(0),

  status:            salesInvoiceStatus('status').notNull().default('SENT'),
  notes:             text('notes'),
  sentAt:            timestamp('sent_at', { withTimezone: true }),
  paidAt:            timestamp('paid_at', { withTimezone: true }),
  confirmedAt:       timestamp('confirmed_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                          // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSo:      index('idx_si_so').on(t.soDocNo),
  idxDo:      index('idx_si_do').on(t.deliveryOrderId),
  idxDebtor:  index('idx_si_debtor').on(t.debtorCode),
  idxStatus:  index('idx_si_status').on(t.status),
  idxDueDate: index('idx_si_due_date').on(t.dueDate),
}));

export const salesInvoiceItems = pgTable('sales_invoice_items', {
  id:                uuid('id').primaryKey().defaultRandom(),
  salesInvoiceId:    uuid('sales_invoice_id').notNull().references(() => salesInvoices.id, { onDelete: 'cascade' }),
  soItemId:          uuid('so_item_id').references(() => mfgSalesOrderItems.id, { onDelete: 'set null' }),
  doItemId:          uuid('do_item_id').references(() => deliveryOrderItems.id, { onDelete: 'set null' }),
  itemCode:          text('item_code').notNull(),
  itemGroup:         text('item_group'),
  description:       text('description'),
  description2:      text('description2'),
  uom:               text('uom').notNull().default('UNIT'),
  qty:               integer('qty').notNull(),
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),
  discountCenti:     integer('discount_centi').notNull().default(0),
  taxCenti:          integer('tax_centi').notNull().default(0),
  lineTotalCenti:    integer('line_total_centi').notNull().default(0),
  unitCostCenti:     integer('unit_cost_centi').notNull().default(0),
  lineCostCenti:     integer('line_cost_centi').notNull().default(0),
  lineMarginCenti:   integer('line_margin_centi').notNull().default(0),
  notes:             text('notes'),
  // Variant columns (furniture; KEPT nullable for fidelity).
  gapInches:             integer('gap_inches'),
  divanHeightInches:     integer('divan_height_inches'),
  divanPriceSen:         integer('divan_price_sen').notNull().default(0),
  legHeightInches:       integer('leg_height_inches'),
  legPriceSen:           integer('leg_price_sen').notNull().default(0),
  customSpecials:        jsonb('custom_specials'),
  lineSuffix:            text('line_suffix'),
  specialOrderPriceSen:  integer('special_order_price_sen').notNull().default(0),
  variants:              jsonb('variants'),
  lineNo:            integer('line_no'),                             // migration 0165 — listing order
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSi:     index('idx_si_items_si').on(t.salesInvoiceId),
  idxDoItem: index('idx_si_items_do_item').on(t.doItemId),
}));

/* SI payment ledger (migration 0101 — mirrors mfg_sales_order_payments). */
export const salesInvoicePayments = pgTable('sales_invoice_payments', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  salesInvoiceId:     uuid('sales_invoice_id').notNull().references(() => salesInvoices.id, { onDelete: 'cascade' }),
  paidAt:             date('paid_at').notNull().defaultNow(),
  method:             text('method').notNull(),                      // merchant | transfer | cash | installment
  merchantProvider:   text('merchant_provider'),
  installmentMonths:  integer('installment_months'),
  onlineType:         text('online_type'),
  approvalCode:       text('approval_code'),
  amountCenti:        integer('amount_centi').notNull(),
  accountSheet:       text('account_sheet'),
  collectedBy:        integer('collected_by'),                       // SEAM: users.id soft-ref
  note:               text('note'),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:          integer('created_by'),                         // SEAM: users.id soft-ref
}, (t) => ({
  idxSi: index('idx_sip_si').on(t.salesInvoiceId),
}));

/* Delivery Return — customer returning previously-delivered goods. */
export const deliveryReturns = pgTable('delivery_returns', {
  id:                uuid('id').primaryKey().defaultRandom(),
  returnNumber:      text('return_number').notNull().unique(),       // 'DR-2605-001'
  doDocNo:           text('do_doc_no'),                              // snapshot of the source DO number
  deliveryOrderId:   uuid('delivery_order_id').references(() => deliveryOrders.id, { onDelete: 'set null' }),
  salesInvoiceId:    uuid('sales_invoice_id').references(() => salesInvoices.id, { onDelete: 'set null' }),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name').notNull(),
  returnDate:        date('return_date').notNull().defaultNow(),
  reason:            text('reason'),
  status:            deliveryReturnStatus('status').notNull().default('PENDING'),
  receivedAt:        timestamp('received_at', { withTimezone: true }),
  inspectedAt:       timestamp('inspected_at', { withTimezone: true }),
  refundedAt:        timestamp('refunded_at', { withTimezone: true }),
  refundCenti:       integer('refund_centi').notNull().default(0),
  inspectionNotes:   text('inspection_notes'),

  // DO-clone header fields (migration 0102).
  salespersonId:     integer('salesperson_id'),                      // SEAM: users.id soft-ref
  agent:             text('agent'),
  email:             text('email'),
  customerType:      text('customer_type'),
  buildingType:      text('building_type'),
  branding:          text('branding'),
  venue:             text('venue'),
  venueId:           uuid('venue_id'),
  ref:               text('ref'),
  customerSoNo:      text('customer_so_no'),
  salesLocation:     text('sales_location'),
  customerState:     text('customer_state'),
  customerCountry:   text('customer_country'),
  note:              text('note'),
  address1:          text('address1'),
  address2:          text('address2'),
  city:              text('city'),
  state:             text('state'),
  postcode:          text('postcode'),
  phone:             text('phone'),
  emergencyContactName:         text('emergency_contact_name'),
  emergencyContactPhone:        text('emergency_contact_phone'),
  emergencyContactRelationship: text('emergency_contact_relationship'),

  // Per-category revenue + cost totals (migration 0102; recomputeTotals).
  mattressSofaCenti:     integer('mattress_sofa_centi').notNull().default(0),
  bedframeCenti:         integer('bedframe_centi').notNull().default(0),
  accessoriesCenti:      integer('accessories_centi').notNull().default(0),
  othersCenti:           integer('others_centi').notNull().default(0),
  mattressSofaCostCenti: integer('mattress_sofa_cost_centi').notNull().default(0),
  bedframeCostCenti:     integer('bedframe_cost_centi').notNull().default(0),
  accessoriesCostCenti:  integer('accessories_cost_centi').notNull().default(0),
  othersCostCenti:       integer('others_cost_centi').notNull().default(0),
  localTotalCenti:       integer('local_total_centi').notNull().default(0),
  totalCostCenti:        integer('total_cost_centi').notNull().default(0),
  totalMarginCenti:      integer('total_margin_centi').notNull().default(0),
  marginPctBasis:        integer('margin_pct_basis').notNull().default(0),
  lineCount:             integer('line_count').notNull().default(0),

  currency:          currencyCode('currency').notNull().default('MYR'),
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  notes:             text('notes'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                          // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDo:     index('idx_dr_do').on(t.deliveryOrderId),
  idxStatus: index('idx_dr_status').on(t.status),
  idxDebtor: index('idx_dr_debtor').on(t.debtorCode),
}));

export const deliveryReturnItems = pgTable('delivery_return_items', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  deliveryReturnId:    uuid('delivery_return_id').notNull().references(() => deliveryReturns.id, { onDelete: 'cascade' }),
  doItemId:            uuid('do_item_id').references(() => deliveryOrderItems.id, { onDelete: 'set null' }),
  itemCode:            text('item_code').notNull(),
  itemGroup:           text('item_group'),
  description:         text('description'),
  description2:        text('description2'),
  uom:                 text('uom').notNull().default('UNIT'),
  qtyReturned:         integer('qty_returned').notNull(),
  condition:           text('condition'),                            // 'NEW' | 'DAMAGED' | 'DEFECT'
  unitPriceCenti:      integer('unit_price_centi').notNull().default(0),
  discountCenti:       integer('discount_centi').notNull().default(0),
  lineTotalCenti:      integer('line_total_centi').notNull().default(0),
  unitCostCenti:       integer('unit_cost_centi').notNull().default(0),
  lineCostCenti:       integer('line_cost_centi').notNull().default(0),
  lineMarginCenti:     integer('line_margin_centi').notNull().default(0),
  refundCenti:         integer('refund_centi').notNull().default(0),
  variants:            jsonb('variants'),
  notes:               text('notes'),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDr:     index('idx_dr_items_dr').on(t.deliveryReturnId),
  idxDoItem: index('idx_dr_items_do_item').on(t.doItemId),
}));

/* ════════════════════════════════════════════════════════════════════════
   CONSIGNMENT slice (SCM #67 — the last document-flow group). 1:1 clone of
   2990s's two consignment pipelines:

     SALES consignment (goods OUT to a consignee / showroom, settled later):
       consignment_sales_orders / _items / _payments   (clone mfg_sales_orders)
       consignment_delivery_orders / _items / _payments (Consignment Note —
                                                          clone delivery_orders)
       consignment_delivery_returns / _items            (Consignment Return —
                                                          clone delivery_returns)

     PURCHASE consignment (supplier's goods held on consignment at MY warehouse):
       purchase_consignment_orders / _items     (clone mfg_purchase_orders)
       purchase_consignment_receives / _items   (clone grns)
       purchase_consignment_returns / _items    (clone purchase_returns)

   BARE names — Houzs has none of these tables, so no collision. 2990s's
   schema.ts is STALE for these (the consignment tables have almost no rows in
   schema.ts — only comment lines); the COLUMN SETS below are reconstructed from
   the LIVE ROUTES (apps/api/src/routes/consignment-*.ts +
   purchase-consignment-*.ts — migrations 0153/0154/0056/0057 folded in), which
   are the source of truth (the documented "ledger != schema.ts" gap, same as
   the DO/SI/DR slice). Variant columns (gap/divan/leg/customSpecials/variants
   jsonb) are KEPT nullable for fidelity (no configurator UI per Strategy-2).

   Seams (docs/scm-clone/PLAN.md, identical to prior slices):
     - created_by / salesperson_id / collected_by / actor_id: 2990s staff(id)
       uuid -> Houzs users.id INTEGER soft-ref (rule #4). No FK (cross-domain).
     - customer_id -> real FK customers(id); supplier_id -> real FK suppliers(id);
       warehouse_id / purchase_location_id -> real FK mfg_warehouses(id)
       (nullable soft). consignment_so_doc_no -> real FK
       consignment_sales_orders(doc_no). All intra-consignment parent links
       (consignment_so_item_id / consignment_delivery_order_id / pc_order_id /
       pc_receive_id / etc.) -> real FKs to the cloned tables.
     - venue_id / hub_id / customer_po_id / driver_id -> nullable columns, FK
       DROPPED (no venues / delivery_hubs / drivers masters). Money kept
       centi-internal (rule #5). rack_id -> real FK warehouse_racks(id).
     - GL/accounting (AP/AR posting) is OUT OF SCOPE — the consignment routes do
       not post to a GL (none of the 2990s consignment routes do either).
   ════════════════════════════════════════════════════════════════════════ */

// ── SALES consignment ───────────────────────────────────────────────────────

// CO header status (2990s consignment-orders.ts VALID set: CONFIRMED..CANCELLED;
// mirrors mfg_so_status but consignment-only).
export const consignmentSoStatus = pgEnum('consignment_so_status', [
  'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED',
  'DELIVERED', 'INVOICED', 'CLOSED', 'ON_HOLD', 'CANCELLED',
]);

// Consignment Note (delivery-order) status — clone of doStatus.
export const consignmentDoStatus = pgEnum('consignment_do_status', [
  'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED',
  'DELIVERED', 'INVOICED', 'CANCELLED',
]);

// Consignment Return (delivery-return) status — clone of deliveryReturnStatus.
export const consignmentDrStatus = pgEnum('consignment_dr_status', [
  'PENDING', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CREDIT_NOTED', 'REJECTED', 'CANCELLED',
]);

/* Consignment Order (CO) — B2B consignment order. Clone of mfg_sales_orders. */
export const consignmentSalesOrders = pgTable('consignment_sales_orders', {
  docNo:             text('doc_no').primaryKey(),                    // 'CS-2606-001'
  transferTo:        text('transfer_to'),
  soDate:            date('so_date').notNull().defaultNow(),
  branding:          text('branding'),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name').notNull(),
  agent:             text('agent'),
  salesLocation:     text('sales_location'),
  ref:               text('ref'),
  poDocNo:           text('po_doc_no'),
  venue:             text('venue'),
  venueId:           uuid('venue_id'),                               // SEAM: venues master not cloned
  address1:          text('address1'),
  address2:          text('address2'),
  address3:          text('address3'),
  address4:          text('address4'),
  phone:             text('phone'),

  mattressSofaCenti: integer('mattress_sofa_centi').notNull().default(0),
  bedframeCenti:     integer('bedframe_centi').notNull().default(0),
  accessoriesCenti:  integer('accessories_centi').notNull().default(0),
  othersCenti:       integer('others_centi').notNull().default(0),
  mattressSofaCostCenti: integer('mattress_sofa_cost_centi').notNull().default(0),
  bedframeCostCenti:     integer('bedframe_cost_centi').notNull().default(0),
  accessoriesCostCenti:  integer('accessories_cost_centi').notNull().default(0),
  othersCostCenti:       integer('others_cost_centi').notNull().default(0),
  localTotalCenti:   integer('local_total_centi').notNull().default(0),
  balanceCenti:      integer('balance_centi').notNull().default(0),
  totalCostCenti:    integer('total_cost_centi').notNull().default(0),
  totalRevenueCenti: integer('total_revenue_centi').notNull().default(0),
  totalMarginCenti:  integer('total_margin_centi').notNull().default(0),
  marginPctBasis:    integer('margin_pct_basis').notNull().default(0),
  lineCount:         integer('line_count').notNull().default(0),
  subtotalSen:       integer('subtotal_sen'),
  overdue:           text('overdue'),

  currency:          currencyCode('currency').notNull().default('MYR'),
  status:            consignmentSoStatus('status').notNull().default('CONFIRMED'),
  remark2:           text('remark2'),
  remark3:           text('remark3'),
  remark4:           text('remark4'),
  note:              text('note'),
  processingDate:    date('processing_date'),
  salesExemptionExpiry: date('sales_exemption_expiry'),

  customerId:        uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  customerState:     text('customer_state'),
  customerCountry:   text('customer_country'),
  customerPo:        text('customer_po'),
  customerPoId:      text('customer_po_id'),
  customerPoDate:    date('customer_po_date'),
  customerPoImageB64: text('customer_po_image_b64'),
  customerSoNo:      text('customer_so_no'),
  hubId:             uuid('hub_id'),                                 // SEAM: hubs master not cloned
  hubName:           text('hub_name'),
  customerDeliveryDate: date('customer_delivery_date'),
  internalExpectedDd: date('internal_expected_dd'),
  linkedDoDocNo:     text('linked_do_doc_no'),
  shipToAddress:     text('ship_to_address'),
  billToAddress:     text('bill_to_address'),
  installToAddress:  text('install_to_address'),

  email:             text('email'),
  customerType:      text('customer_type'),
  salespersonId:     integer('salesperson_id'),                     // SEAM: users.id soft-ref
  city:              text('city'),
  postcode:          text('postcode'),
  buildingType:      text('building_type'),
  emergencyContactName:         text('emergency_contact_name'),
  emergencyContactPhone:        text('emergency_contact_phone'),
  emergencyContactRelationship: text('emergency_contact_relationship'),
  targetDate:        date('target_date'),
  signatureB64:      text('signature_b64'),

  paymentMethod:     text('payment_method'),
  installmentMonths: integer('installment_months'),
  merchantProvider:  text('merchant_provider'),
  approvalCode:      text('approval_code'),
  paymentDate:       date('payment_date'),
  depositCenti:      integer('deposit_centi').notNull().default(0),
  paidCenti:         integer('paid_centi').notNull().default(0),

  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                         // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDate:     index('idx_cso_date').on(t.soDate),
  idxStatus:   index('idx_cso_status').on(t.status),
  idxCustomer: index('idx_cso_customer').on(t.customerId),
}));

export const consignmentSalesOrderItems = pgTable('consignment_sales_order_items', {
  id:                uuid('id').primaryKey().defaultRandom(),
  docNo:             text('doc_no').notNull().references(() => consignmentSalesOrders.docNo, { onDelete: 'cascade' }),
  lineDate:          date('line_date').notNull().defaultNow(),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name'),
  agent:             text('agent'),
  itemGroup:         text('item_group'),
  itemCode:          text('item_code').notNull(),
  description:       text('description'),
  description2:      text('description2'),
  uom:               text('uom').notNull().default('UNIT'),
  location:          text('location'),
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  qty:               integer('qty').notNull().default(1),
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),
  discountCenti:     integer('discount_centi').notNull().default(0),
  totalCenti:        integer('total_centi').notNull().default(0),
  taxCenti:          integer('tax_centi').notNull().default(0),
  totalIncCenti:     integer('total_inc_centi').notNull().default(0),
  balanceCenti:      integer('balance_centi').notNull().default(0),
  paymentStatus:     text('payment_status').notNull().default('Unchecked'),
  venue:             text('venue'),
  branding:          text('branding'),
  remark:            text('remark'),
  cancelled:         boolean('cancelled').notNull().default(false),
  variants:          jsonb('variants'),
  unitCostCenti:     integer('unit_cost_centi').notNull().default(0),
  lineCostCenti:     integer('line_cost_centi').notNull().default(0),
  lineMarginCenti:   integer('line_margin_centi').notNull().default(0),
  divanPriceSen:     integer('divan_price_sen').notNull().default(0),
  legPriceSen:       integer('leg_price_sen').notNull().default(0),
  specialOrderPriceSen: integer('special_order_price_sen').notNull().default(0),
  customSpecials:    jsonb('custom_specials'),
  lineDeliveryDate:           date('line_delivery_date'),
  lineDeliveryDateOverridden: boolean('line_delivery_date_overridden').notNull().default(false),
  photoUrls:         text('photo_urls').array().notNull().default([]),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDoc:      index('idx_cso_items_doc').on(t.docNo),
  idxItemCode: index('idx_cso_items_item').on(t.itemCode),
}));

/* CO payments ledger (clone mfg_sales_order_payments; FK so_doc_no -> CO). */
export const consignmentSalesOrderPayments = pgTable('consignment_sales_order_payments', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  soDocNo:            text('so_doc_no').notNull().references(() => consignmentSalesOrders.docNo, { onDelete: 'cascade' }),
  paidAt:             date('paid_at').notNull().defaultNow(),
  method:             text('method').notNull(),
  merchantProvider:   text('merchant_provider'),
  installmentMonths:  integer('installment_months'),
  onlineType:         text('online_type'),
  approvalCode:       text('approval_code'),
  amountCenti:        integer('amount_centi').notNull(),
  accountSheet:       text('account_sheet'),
  collectedBy:        integer('collected_by'),                      // SEAM: users.id soft-ref
  note:               text('note'),
  isDeposit:          boolean('is_deposit').notNull().default(false),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:          integer('created_by'),                        // SEAM: users.id soft-ref
}, (t) => ({
  idxDoc: index('idx_csop_doc').on(t.soDocNo),
}));

/* Unified CO audit trail — clone of mfg_so_audit_log, but FK so_doc_no points at
   the consignment_sales_orders table (CS- doc numbers are not in mfg_sales_orders). */
export const consignmentSoAuditLog = pgTable('consignment_so_audit_log', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  soDocNo:            text('so_doc_no').notNull().references(() => consignmentSalesOrders.docNo, { onDelete: 'cascade' }),
  action:             text('action').notNull(),
  actorId:            integer('actor_id'),                          // SEAM: users.id soft-ref
  actorNameSnapshot:  text('actor_name_snapshot'),
  fieldChanges:       jsonb('field_changes').notNull().default([]),
  statusSnapshot:     text('status_snapshot'),
  source:             text('source').default('web'),
  note:               text('note'),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDoc:   index('idx_csoaudit_doc').on(t.soDocNo),
  idxDocAt: index('idx_csoaudit_doc_at').on(t.soDocNo, t.createdAt),
}));

/* Consignment Note (CN) — ships consignment goods OUT to a consignee. Clone of
   delivery_orders (the DO's so_doc_no/so_item_id become consignment_so_doc_no/
   consignment_so_item_id -> consignment_sales_orders/_items). */
export const consignmentDeliveryOrders = pgTable('consignment_delivery_orders', {
  id:                uuid('id').primaryKey().defaultRandom(),
  doNumber:          text('do_number').notNull().unique(),          // 'CN-2606-001'
  consignmentSoDocNo: text('consignment_so_doc_no').references(() => consignmentSalesOrders.docNo, { onDelete: 'set null' }),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name').notNull(),
  doDate:            date('do_date').notNull().defaultNow(),
  expectedDeliveryAt: date('expected_delivery_at'),
  customerDeliveryDate: date('customer_delivery_date'),
  signedAt:          timestamp('signed_at', { withTimezone: true }),
  deliveredAt:       timestamp('delivered_at', { withTimezone: true }),
  dispatchedAt:      timestamp('dispatched_at', { withTimezone: true }),

  driverId:          uuid('driver_id'),                             // SEAM: drivers master not cloned
  driverName:        text('driver_name'),
  vehicle:           text('vehicle'),
  m3Total:           integer('m3_total_milli').notNull().default(0),

  address1:          text('address1'),
  address2:          text('address2'),
  city:              text('city'),
  state:             text('state'),
  postcode:          text('postcode'),
  phone:             text('phone'),

  salespersonId:     integer('salesperson_id'),                     // SEAM: users.id soft-ref
  agent:             text('agent'),
  email:             text('email'),
  customerType:      text('customer_type'),
  buildingType:      text('building_type'),
  branding:          text('branding'),
  venue:             text('venue'),
  venueId:           uuid('venue_id'),                              // SEAM: venues master not cloned
  ref:               text('ref'),
  customerSoNo:      text('customer_so_no'),
  poDocNo:           text('po_doc_no'),
  salesLocation:     text('sales_location'),
  customerState:     text('customer_state'),
  customerCountry:   text('customer_country'),
  note:              text('note'),
  emergencyContactName:         text('emergency_contact_name'),
  emergencyContactPhone:        text('emergency_contact_phone'),
  emergencyContactRelationship: text('emergency_contact_relationship'),

  mattressSofaCenti: integer('mattress_sofa_centi').notNull().default(0),
  bedframeCenti:     integer('bedframe_centi').notNull().default(0),
  accessoriesCenti:  integer('accessories_centi').notNull().default(0),
  othersCenti:       integer('others_centi').notNull().default(0),
  mattressSofaCostCenti: integer('mattress_sofa_cost_centi').notNull().default(0),
  bedframeCostCenti:     integer('bedframe_cost_centi').notNull().default(0),
  accessoriesCostCenti:  integer('accessories_cost_centi').notNull().default(0),
  othersCostCenti:       integer('others_cost_centi').notNull().default(0),
  localTotalCenti:   integer('local_total_centi').notNull().default(0),
  totalCostCenti:    integer('total_cost_centi').notNull().default(0),
  totalMarginCenti:  integer('total_margin_centi').notNull().default(0),
  marginPctBasis:    integer('margin_pct_basis').notNull().default(0),
  lineCount:         integer('line_count').notNull().default(0),

  currency:          currencyCode('currency').notNull().default('MYR'),
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  podR2Key:          text('pod_r2_key'),
  signatureData:     text('signature_data'),
  status:            consignmentDoStatus('status').notNull().default('LOADED'),
  notes:             text('notes'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                         // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSo:     index('idx_cdo_so').on(t.consignmentSoDocNo),
  idxStatus: index('idx_cdo_status').on(t.status),
  idxDate:   index('idx_cdo_date').on(t.doDate),
}));

export const consignmentDeliveryOrderItems = pgTable('consignment_delivery_order_items', {
  id:                uuid('id').primaryKey().defaultRandom(),
  consignmentDeliveryOrderId: uuid('consignment_delivery_order_id').notNull().references(() => consignmentDeliveryOrders.id, { onDelete: 'cascade' }),
  consignmentSoItemId: uuid('consignment_so_item_id').references(() => consignmentSalesOrderItems.id, { onDelete: 'set null' }),
  itemCode:          text('item_code').notNull(),
  itemGroup:         text('item_group'),
  description:       text('description'),
  description2:      text('description2'),
  uom:               text('uom').notNull().default('UNIT'),
  qty:               integer('qty').notNull(),
  m3Milli:           integer('m3_milli').notNull().default(0),
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),
  discountCenti:     integer('discount_centi').notNull().default(0),
  lineTotalCenti:    integer('line_total_centi').notNull().default(0),
  unitCostCenti:     integer('unit_cost_centi').notNull().default(0),
  lineCostCenti:     integer('line_cost_centi').notNull().default(0),
  lineMarginCenti:   integer('line_margin_centi').notNull().default(0),
  variants:          jsonb('variants'),
  notes:             text('notes'),
  lineDeliveryDate:           date('line_delivery_date'),
  lineDeliveryDateOverridden: boolean('line_delivery_date_overridden').notNull().default(false),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDo:     index('idx_cdo_items_do').on(t.consignmentDeliveryOrderId),
  idxSoItem: index('idx_cdo_items_so_item').on(t.consignmentSoItemId),
}));

/* CN payment ledger (clone delivery_order_payments). */
export const consignmentDeliveryOrderPayments = pgTable('consignment_delivery_order_payments', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  consignmentDeliveryOrderId: uuid('consignment_delivery_order_id').notNull().references(() => consignmentDeliveryOrders.id, { onDelete: 'cascade' }),
  paidAt:             date('paid_at').notNull().defaultNow(),
  method:             text('method').notNull(),
  merchantProvider:   text('merchant_provider'),
  installmentMonths:  integer('installment_months'),
  onlineType:         text('online_type'),
  approvalCode:       text('approval_code'),
  amountCenti:        integer('amount_centi').notNull(),
  accountSheet:       text('account_sheet'),
  collectedBy:        integer('collected_by'),                      // SEAM: users.id soft-ref
  note:               text('note'),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:          integer('created_by'),                        // SEAM: users.id soft-ref
}, (t) => ({
  idxDo: index('idx_cdop_do').on(t.consignmentDeliveryOrderId),
}));

/* Consignment Return (CR) — consignee returns previously-shipped consignment
   goods. Clone of delivery_returns; FK consignment_do_id -> consignment_delivery_orders. */
export const consignmentDeliveryReturns = pgTable('consignment_delivery_returns', {
  id:                uuid('id').primaryKey().defaultRandom(),
  returnNumber:      text('return_number').notNull().unique(),      // 'CR-2606-001'
  doNumber:          text('do_number'),                            // snapshot of the source CN number
  consignmentDoId:   uuid('consignment_do_id').references(() => consignmentDeliveryOrders.id, { onDelete: 'set null' }),
  debtorCode:        text('debtor_code'),
  debtorName:        text('debtor_name').notNull(),
  returnDate:        date('return_date').notNull().defaultNow(),
  reason:            text('reason'),
  status:            consignmentDrStatus('status').notNull().default('PENDING'),
  receivedAt:        timestamp('received_at', { withTimezone: true }),
  inspectedAt:       timestamp('inspected_at', { withTimezone: true }),
  refundedAt:        timestamp('refunded_at', { withTimezone: true }),
  refundCenti:       integer('refund_centi').notNull().default(0),
  inspectionNotes:   text('inspection_notes'),

  salespersonId:     integer('salesperson_id'),                     // SEAM: users.id soft-ref
  agent:             text('agent'),
  email:             text('email'),
  customerType:      text('customer_type'),
  buildingType:      text('building_type'),
  branding:          text('branding'),
  venue:             text('venue'),
  venueId:           uuid('venue_id'),                              // SEAM: venues master not cloned
  ref:               text('ref'),
  customerSoNo:      text('customer_so_no'),
  salesLocation:     text('sales_location'),
  customerState:     text('customer_state'),
  customerCountry:   text('customer_country'),
  note:              text('note'),
  address1:          text('address1'),
  address2:          text('address2'),
  city:              text('city'),
  state:             text('state'),
  postcode:          text('postcode'),
  phone:             text('phone'),
  emergencyContactName:         text('emergency_contact_name'),
  emergencyContactPhone:        text('emergency_contact_phone'),
  emergencyContactRelationship: text('emergency_contact_relationship'),

  mattressSofaCenti: integer('mattress_sofa_centi').notNull().default(0),
  bedframeCenti:     integer('bedframe_centi').notNull().default(0),
  accessoriesCenti:  integer('accessories_centi').notNull().default(0),
  othersCenti:       integer('others_centi').notNull().default(0),
  mattressSofaCostCenti: integer('mattress_sofa_cost_centi').notNull().default(0),
  bedframeCostCenti:     integer('bedframe_cost_centi').notNull().default(0),
  accessoriesCostCenti:  integer('accessories_cost_centi').notNull().default(0),
  othersCostCenti:       integer('others_cost_centi').notNull().default(0),
  localTotalCenti:   integer('local_total_centi').notNull().default(0),
  totalCostCenti:    integer('total_cost_centi').notNull().default(0),
  totalMarginCenti:  integer('total_margin_centi').notNull().default(0),
  marginPctBasis:    integer('margin_pct_basis').notNull().default(0),
  lineCount:         integer('line_count').notNull().default(0),

  currency:          currencyCode('currency').notNull().default('MYR'),
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  notes:             text('notes'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                         // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDo:     index('idx_cdr_do').on(t.consignmentDoId),
  idxStatus: index('idx_cdr_status').on(t.status),
  idxDebtor: index('idx_cdr_debtor').on(t.debtorCode),
}));

export const consignmentDeliveryReturnItems = pgTable('consignment_delivery_return_items', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  consignmentDeliveryReturnId: uuid('consignment_delivery_return_id').notNull().references(() => consignmentDeliveryReturns.id, { onDelete: 'cascade' }),
  consignmentDoItemId: uuid('consignment_do_item_id').references(() => consignmentDeliveryOrderItems.id, { onDelete: 'set null' }),
  itemCode:            text('item_code').notNull(),
  itemGroup:           text('item_group'),
  description:         text('description'),
  description2:        text('description2'),
  uom:                 text('uom').notNull().default('UNIT'),
  qtyReturned:         integer('qty_returned').notNull(),
  condition:           text('condition'),
  unitPriceCenti:      integer('unit_price_centi').notNull().default(0),
  discountCenti:       integer('discount_centi').notNull().default(0),
  lineTotalCenti:      integer('line_total_centi').notNull().default(0),
  unitCostCenti:       integer('unit_cost_centi').notNull().default(0),
  lineCostCenti:       integer('line_cost_centi').notNull().default(0),
  lineMarginCenti:     integer('line_margin_centi').notNull().default(0),
  refundCenti:         integer('refund_centi').notNull().default(0),
  variants:            jsonb('variants'),
  notes:               text('notes'),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxDr:     index('idx_cdr_items_dr').on(t.consignmentDeliveryReturnId),
  idxDoItem: index('idx_cdr_items_do_item').on(t.consignmentDoItemId),
}));

// ── PURCHASE consignment ─────────────────────────────────────────────────────

// PC Order status — clone of po_status (VALID set in the route).
export const purchaseConsignmentOrderStatus = pgEnum('purchase_consignment_order_status', [
  'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED',
]);

// PC Receive status — clone of grn_status.
export const purchaseConsignmentReceiveStatus = pgEnum('purchase_consignment_receive_status', [
  'POSTED', 'CLOSED', 'CANCELLED',
]);

// PC Return status — clone of purchase_return_status.
export const purchaseConsignmentReturnStatus = pgEnum('purchase_consignment_return_status', [
  'POSTED', 'COMPLETED', 'CANCELLED',
]);

/* PC Order (PCO) — order to a supplier for goods held on consignment. Clone of
   mfg_purchase_orders (no inventory; order only). */
export const purchaseConsignmentOrders = pgTable('purchase_consignment_orders', {
  id:                uuid('id').primaryKey().defaultRandom(),
  pcNumber:          text('pc_number').notNull().unique(),          // 'PCO-2606-001'
  supplierId:        uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  status:            purchaseConsignmentOrderStatus('status').notNull().default('SUBMITTED'),
  poDate:            date('po_date').notNull().defaultNow(),
  expectedAt:        date('expected_at'),
  currency:          currencyCode('currency').notNull().default('MYR'),
  subtotalCenti:     integer('subtotal_centi').notNull().default(0),
  taxCenti:          integer('tax_centi').notNull().default(0),
  totalCenti:        integer('total_centi').notNull().default(0),
  notes:             text('notes'),
  // SEAM: -> mfg_warehouses (nullable soft binding; same as PO slice).
  purchaseLocationId: uuid('purchase_location_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  submittedAt:       timestamp('submitted_at', { withTimezone: true }),
  receivedAt:        timestamp('received_at', { withTimezone: true }),
  cancelledAt:       timestamp('cancelled_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                         // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSupplier: index('idx_pco_supplier').on(t.supplierId),
  idxStatus:   index('idx_pco_status').on(t.status),
  idxDate:     index('idx_pco_date').on(t.poDate),
}));

export const purchaseConsignmentOrderItems = pgTable('purchase_consignment_order_items', {
  id:                uuid('id').primaryKey().defaultRandom(),
  purchaseConsignmentOrderId: uuid('purchase_consignment_order_id').notNull().references(() => purchaseConsignmentOrders.id, { onDelete: 'cascade' }),
  bindingId:         uuid('binding_id'),                            // soft ref to supplier_material_bindings
  materialKind:      materialKind('material_kind').notNull(),
  materialCode:      text('material_code').notNull(),
  materialName:      text('material_name').notNull(),
  supplierSku:       text('supplier_sku'),
  qty:               integer('qty').notNull().default(0),
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),
  lineTotalCenti:    integer('line_total_centi').notNull().default(0),
  receivedQty:       integer('received_qty').notNull().default(0),
  notes:             text('notes'),
  // Variant + line fields (migration 0056).
  itemGroup:         text('item_group'),
  description:       text('description'),
  description2:      text('description2'),
  uom:               text('uom').notNull().default('UNIT'),
  discountCenti:     integer('discount_centi').notNull().default(0),
  unitCostCenti:     integer('unit_cost_centi').notNull().default(0),
  gapInches:         integer('gap_inches'),
  divanHeightInches: integer('divan_height_inches'),
  divanPriceSen:     integer('divan_price_sen').notNull().default(0),
  legHeightInches:   integer('leg_height_inches'),
  legPriceSen:       integer('leg_price_sen').notNull().default(0),
  customSpecials:    jsonb('custom_specials'),
  lineSuffix:        text('line_suffix'),
  specialOrderPriceSen: integer('special_order_price_sen').notNull().default(0),
  variants:          jsonb('variants'),
  deliveryDate:      date('delivery_date'),
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPco: index('idx_pco_items_pco').on(t.purchaseConsignmentOrderId),
}));

/* PC Receive (PCR) — supplier's consignment goods arrive at MY warehouse. Clone
   of grns; books an inventory IN. */
export const purchaseConsignmentReceives = pgTable('purchase_consignment_receives', {
  id:                uuid('id').primaryKey().defaultRandom(),
  receiveNumber:     text('receive_number').notNull().unique(),     // 'PCR-2606-001'
  purchaseConsignmentOrderId: uuid('purchase_consignment_order_id').references(() => purchaseConsignmentOrders.id, { onDelete: 'set null' }),
  pcOrderNo:         text('pc_order_no'),                           // snapshot of source PCO number
  supplierId:        uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  receivedAt:        date('received_at').notNull().defaultNow(),
  deliveryNoteRef:   text('delivery_note_ref'),
  status:            purchaseConsignmentReceiveStatus('status').notNull().default('POSTED'),
  notes:             text('notes'),
  warehouseId:       uuid('warehouse_id').references(() => mfgWarehouses.id, { onDelete: 'set null' }),
  currency:          currencyCode('currency').notNull().default('MYR'),
  subtotalCenti:     integer('subtotal_centi').notNull().default(0),
  taxCenti:          integer('tax_centi').notNull().default(0),
  totalCenti:        integer('total_centi').notNull().default(0),
  postedAt:          timestamp('posted_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                         // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPco:      index('idx_pcr_pco').on(t.purchaseConsignmentOrderId),
  idxSupplier: index('idx_pcr_supplier').on(t.supplierId),
  idxStatus:   index('idx_pcr_status').on(t.status),
}));

export const purchaseConsignmentReceiveItems = pgTable('purchase_consignment_receive_items', {
  id:                uuid('id').primaryKey().defaultRandom(),
  pcReceiveId:       uuid('pc_receive_id').notNull().references(() => purchaseConsignmentReceives.id, { onDelete: 'cascade' }),
  pcOrderItemId:     uuid('pc_order_item_id').references(() => purchaseConsignmentOrderItems.id, { onDelete: 'set null' }),
  materialKind:      materialKind('material_kind').notNull(),
  materialCode:      text('material_code').notNull(),
  materialName:      text('material_name').notNull(),
  supplierSku:       text('supplier_sku'),
  qtyReceived:       integer('qty_received').notNull(),
  qtyAccepted:       integer('qty_accepted').notNull(),
  qtyRejected:       integer('qty_rejected').notNull().default(0),
  rejectionReason:   text('rejection_reason'),
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),
  notes:             text('notes'),
  // Variant + line fields (migration 0057).
  itemGroup:         text('item_group'),
  description:       text('description'),
  description2:      text('description2'),
  uom:               text('uom').notNull().default('UNIT'),
  discountCenti:     integer('discount_centi').notNull().default(0),
  variants:          jsonb('variants'),
  gapInches:         integer('gap_inches'),
  divanHeightInches: integer('divan_height_inches'),
  divanPriceSen:     integer('divan_price_sen').notNull().default(0),
  legHeightInches:   integer('leg_height_inches'),
  legPriceSen:       integer('leg_price_sen').notNull().default(0),
  customSpecials:    jsonb('custom_specials'),
  lineSuffix:        text('line_suffix'),
  specialOrderPriceSen: integer('special_order_price_sen').notNull().default(0),
  lineTotalCenti:    integer('line_total_centi').notNull().default(0),
  deliveryDate:      date('delivery_date'),
  unitCostCenti:     integer('unit_cost_centi').notNull().default(0),
  // Consumption tracking (downstream PR draw).
  invoicedQty:       integer('invoiced_qty').notNull().default(0),
  returnedQty:       integer('returned_qty').notNull().default(0),
  rackId:            uuid('rack_id').references(() => warehouseRacks.id, { onDelete: 'set null' }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxReceive: index('idx_pcr_items_receive').on(t.pcReceiveId),
}));

/* PC Return (PCT) — return supplier's consignment goods back. Clone of
   purchase_returns; books an inventory OUT. */
export const purchaseConsignmentReturns = pgTable('purchase_consignment_returns', {
  id:                uuid('id').primaryKey().defaultRandom(),
  returnNumber:      text('return_number').notNull().unique(),      // 'PCT-2606-001'
  pcOrderId:         uuid('pc_order_id').references(() => purchaseConsignmentOrders.id, { onDelete: 'set null' }),
  pcReceiveId:       uuid('pc_receive_id').references(() => purchaseConsignmentReceives.id, { onDelete: 'set null' }),
  supplierId:        uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  returnDate:        date('return_date').notNull().defaultNow(),
  reason:            text('reason'),
  status:            purchaseConsignmentReturnStatus('status').notNull().default('POSTED'),
  postedAt:          timestamp('posted_at', { withTimezone: true }),
  completedAt:       timestamp('completed_at', { withTimezone: true }),
  creditNoteRef:     text('credit_note_ref'),
  refundCenti:       integer('refund_centi').notNull().default(0),
  notes:             text('notes'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:         integer('created_by'),                         // SEAM: users.id soft-ref
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPco:      index('idx_pct_pco').on(t.pcOrderId),
  idxReceive:  index('idx_pct_receive').on(t.pcReceiveId),
  idxSupplier: index('idx_pct_supplier').on(t.supplierId),
  idxStatus:   index('idx_pct_status').on(t.status),
}));

export const purchaseConsignmentReturnItems = pgTable('purchase_consignment_return_items', {
  id:                uuid('id').primaryKey().defaultRandom(),
  purchaseConsignmentReturnId: uuid('purchase_consignment_return_id').notNull().references(() => purchaseConsignmentReturns.id, { onDelete: 'cascade' }),
  pcReceiveItemId:   uuid('pc_receive_item_id').references(() => purchaseConsignmentReceiveItems.id, { onDelete: 'set null' }),
  materialKind:      materialKind('material_kind').notNull(),
  materialCode:      text('material_code').notNull(),
  materialName:      text('material_name').notNull(),
  qtyReturned:       integer('qty_returned').notNull(),
  unitPriceCenti:    integer('unit_price_centi').notNull().default(0),
  lineRefundCenti:   integer('line_refund_centi').notNull().default(0),
  reason:            text('reason'),
  notes:             text('notes'),
  // Variant + line fields (kept for fidelity; the add/edit-line paths carry them).
  itemGroup:         text('item_group'),
  description:       text('description'),
  description2:      text('description2'),
  uom:               text('uom').notNull().default('UNIT'),
  gapInches:         integer('gap_inches'),
  divanHeightInches: integer('divan_height_inches'),
  divanPriceSen:     integer('divan_price_sen').notNull().default(0),
  legHeightInches:   integer('leg_height_inches'),
  legPriceSen:       integer('leg_price_sen').notNull().default(0),
  customSpecials:    jsonb('custom_specials'),
  lineSuffix:        text('line_suffix'),
  specialOrderPriceSen: integer('special_order_price_sen').notNull().default(0),
  variants:          jsonb('variants'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxReturn: index('idx_pct_items_return').on(t.purchaseConsignmentReturnId),
}));

// ────────────────────────────────────────────────────────────────────────────
// MRP · Stock Status (slice #64). 1:1 clone of 2990s — the planner (routes/mrp.ts)
// is a PURE CALCULATOR (demand = open SO lines, supply = inventory_balances +
// open PO lines, greedy allocation by delivery date per warehouse+product+variant)
// with NO persistence; recomputed on every GET. The ONE persisted MRP table is
// the per-category lead-times config below (clone of 2990s mrp_category_lead_times
// / migration 0099 -> Houzs migration 0032). It backs the order-by-date calc
// (order-by = delivery date - lead_days[category]). BARE name (no Houzs collision).
// ────────────────────────────────────────────────────────────────────────────
export const mrpCategoryLeadTimes = pgTable('mrp_category_lead_times', {
  // 'sofa' | 'bedframe' | 'mattress' | 'accessory' | 'service' (lowercase, matches
  // mfg_sales_order_items.item_group; the MRP server uppercase-normalises on lookup).
  category:   text('category').primaryKey(),
  leadDays:   integer('lead_days').notNull().default(0),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
