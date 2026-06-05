/**
 * Drizzle schema definitions.
 *
 * Mirrors what's actually in D1 today — these aren't migration sources
 * (raw .sql files in `migrations/` remain authoritative for shape
 * changes), they're TypeScript reflections so Drizzle's query builder
 * has typed column refs.
 *
 * Initial drop covers the tables touched by the brand-scoping rework.
 * Every other table still goes through raw SQL; add it here when its
 * route is converted.
 */

import { sqliteTable, integer, text, real, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── users ──────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name"),
  password_hash: text("password_hash"),
  role_id: integer("role_id").notNull(),
  status: text("status").notNull().default("invited"),
  invited_by: integer("invited_by"),
  invited_at: text("invited_at"),
  joined_at: text("joined_at"),
  last_login_at: text("last_login_at"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  manager_id: integer("manager_id"),
  department_id: integer("department_id"),
  // Houzs Points (mig 055)
  points_balance: integer("points_balance").notNull().default(0),
  gifting_balance: integer("gifting_balance").notNull().default(0),
  gifting_reset_at: text("gifting_reset_at"),
  current_streak: integer("current_streak").notNull().default(0),
  // Profile picture (mig 058) — R2 key inside POD_BUCKET.
  profile_pic_r2_key: text("profile_pic_r2_key"),
});

// ── roles ──────────────────────────────────────────────────
export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  permissions: text("permissions").notNull().default("[]"),
  is_system: integer("is_system").notNull().default(0),
  scope_to_pic: integer("scope_to_pic").notNull().default(0),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── role_page_access (mig 073) ─────────────────────────────
// Per-page access matrix. One row per (role, page); level is one of
// 'none' / 'partial' / 'full'. Backfilled from existing role JSON;
// the `*` wildcard on a role short-circuits the matrix lookup so
// Owner / IT Admin don't depend on these rows being present.
export const role_page_access = sqliteTable(
  "role_page_access",
  {
    role_id: integer("role_id").notNull(),
    page_key: text("page_key").notNull(),
    level: text("level").notNull(),
    created_at: text("created_at").default(sql`(datetime('now'))`),
    updated_at: text("updated_at").default(sql`(datetime('now'))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.role_id, t.page_key] }),
  })
);

// ── departments ────────────────────────────────────────────
export const departments = sqliteTable("departments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  color: text("color").notNull().default("64748b"),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── projects (subset; rest of columns added as routes are converted) ──
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").unique(),
  name: text("name").notNull(),
  stage: text("stage").notNull().default("draft"),
  // mig 088 — boss-facing lifecycle: confirmed | pending | cancelled.
  status: text("status").notNull().default("pending"),
  start_date: text("start_date"),
  end_date: text("end_date"),
  venue: text("venue"),
  venue_address: text("venue_address"),
  brand: text("brand"),
  pic_id: integer("pic_id"),
  created_by: integer("created_by"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
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

// ── project_phase_photos — crew-uploaded evidence for setup/dismantle
// phases. Separate from legacy project_attachments because the access
// model is "crew member on this phase may upload", not "manager only".
export const project_phase_photos = sqliteTable("project_phase_photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull(),
  phase: text("phase").notNull(),
  r2_key: text("r2_key").notNull(),
  content_type: text("content_type"),
  caption: text("caption"),
  uploaded_by: integer("uploaded_by"),
  uploaded_at: text("uploaded_at").notNull().default(sql`(datetime('now'))`),
});

// ── project_brands lookup ─────────────────────────────────
export const project_brands = sqliteTable("project_brands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("64748b"),
  sort_order: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── user_brands junction (mig 049) ────────────────────────
// Person-level brand allow-list. Drives sales-dept project visibility:
// scoped users see projects whose `brand` is in this set, AND-ed with
// the existing PIC one-hop rule.
export const user_brands = sqliteTable(
  "user_brands",
  {
    user_id: integer("user_id").notNull(),
    brand: text("brand").notNull(),
    created_at: text("created_at").default(sql`(datetime('now'))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.user_id, t.brand] }),
  })
);

// ── project_activity ──────────────────────────────────────
// Append-only audit + chat trail for projects. Drives the notifications
// feed and the in-project chat. `action` carries the kind ("note",
// "stage_change", etc.); `note` is the chat body; `from_value`/`to_value`
// describe a field change.
export const project_activity = sqliteTable("project_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull(),
  user_id: integer("user_id"),
  action: text("action").notNull(),
  from_value: text("from_value"),
  to_value: text("to_value"),
  note: text("note"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  archived_at: text("archived_at"),
});

// ── project_reads (mig 045) ───────────────────────────────
// Per-user × per-project last-read timestamp. Anything in
// project_activity newer than `last_read_at` counts as unread for
// the bell + per-project dot.
export const project_reads = sqliteTable(
  "project_reads",
  {
    project_id: integer("project_id").notNull(),
    user_id: integer("user_id").notNull(),
    last_read_at: text("last_read_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.project_id, t.user_id] }),
  })
);

// ── sessions ──────────────────────────────────────────────
// Bearer tokens. AuthMiddleware walks this on every request.
export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  user_id: integer("user_id").notNull(),
  expires_at: text("expires_at").notNull(),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── invitations ───────────────────────────────────────────
// Email + role + one-shot token. Consumed when the user accepts.
export const invitations = sqliteTable("invitations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  role_id: integer("role_id").notNull(),
  token: text("token").notNull().unique(),
  invited_by: integer("invited_by").notNull(),
  expires_at: text("expires_at").notNull(),
  accepted_at: text("accepted_at"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── password_resets ───────────────────────────────────────
// Admin-triggered one-hour reset tokens (mig 027).
export const password_resets = sqliteTable("password_resets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id").notNull(),
  token: text("token").notNull().unique(),
  requested_by: integer("requested_by"),
  expires_at: text("expires_at").notNull(),
  consumed_at: text("consumed_at"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── events ────────────────────────────────────────────────
// Manual setup / dismantle calendar entries (not tied to sales orders).
// The dispatcher creates them; status is intentionally free-text.
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  event_date: text("event_date").notNull(),
  address: text("address"),
  status: text("status"),
  notes: text("notes"),
  created_by: integer("created_by"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
});

// ── lorries ───────────────────────────────────────────────
// Fleet vehicles. Subset; expand as fleet routes get converted.
export const lorries = sqliteTable("lorries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  plate: text("plate").notNull(),
  size: text("size"),
  default_driver_user_id: integer("default_driver_user_id"),
});

// ── warehouses ────────────────────────────────────────────
export const warehouses = sqliteTable("warehouses", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
});

// ── trips ─────────────────────────────────────────────────
// Subset for trip read paths in the route file. The bulk of trip
// logic lives in services/trips.ts and stays raw until that service
// is converted in a later batch.
export const trips = sqliteTable("trips", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  driver_user_id: integer("driver_user_id"),
  lorry_id: integer("lorry_id"),
  warehouse: text("warehouse"),
  trip_date: text("trip_date").notNull(),
  status: text("status").notNull(),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
});

// ── trip_stops ────────────────────────────────────────────
export const trip_stops = sqliteTable("trip_stops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trip_id: integer("trip_id").notNull(),
  sequence: integer("sequence").notNull(),
  status: text("status").notNull(),
  pod_photo_r2_key: text("pod_photo_r2_key"),
  signature_r2_key: text("signature_r2_key"),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
});

// ── trip_locations ────────────────────────────────────────
// GPS pings for in-progress trips.
export const trip_locations = sqliteTable("trip_locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trip_id: integer("trip_id").notNull(),
  lat: integer("lat").notNull(),
  lng: integer("lng").notNull(),
  accuracy: integer("accuracy"),
  recorded_at: text("recorded_at").notNull(),
});

// ── lorry_incidents ───────────────────────────────────────
// trip_id is nullable so a hard-deleted trip can null it out
// instead of cascading.
export const lorry_incidents = sqliteTable("lorry_incidents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trip_id: integer("trip_id"),
});

// ── salary_trip_lines ─────────────────────────────────────
// Driver/helper payroll lines linked to a trip. Hard-deleted on
// trip permanent-delete (acceptable for current test-data wipes).
export const salary_trip_lines = sqliteTable("salary_trip_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trip_id: integer("trip_id").notNull(),
});

// ── sales_orders ──────────────────────────────────────────
// AutoCount-mirrored sales orders. Subset — only columns referenced
// in route handlers (filters, joins, patches, sort). Broad SELECT *
// queries spread these via getTableColumns and stay typed for the
// known columns, untyped for the rest.
export const sales_orders = sqliteTable("sales_orders", {
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
});

// ── order_details ─────────────────────────────────────────
// Internal scheduling/transporter overlay on top of AutoCount sales
// orders. Same allow-list of columns as `ORDER_DETAIL_FIELDS` in
// routes/orders.ts.
export const order_details = sqliteTable("order_details", {
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

// ── purchase_orders ───────────────────────────────────────
// AutoCount-mirrored PO line items (from /getOutstanding — already
// filtered upstream to lines with Qty - TransferedQty > 0).
export const purchase_orders = sqliteTable("purchase_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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

// ── creditors (AutoCount-mirrored procurement suppliers) ──
// Read-only mirror of AutoCount's /Creditor/getAll. Distinct from
// the deprecated local "suppliers" table. Subset — only columns
// referenced in routes/creditors.ts; broad SELECT * goes through
// `sql<any>` for the wide AutoCount payload.
export const creditors = sqliteTable("creditors", {
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

// ── overdue_history ───────────────────────────────────────
// One row per overdue auto-extend run. Captures the SO at the moment
// of the pull plus what the script extended the expiry_date to.
export const overdue_history = sqliteTable("overdue_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pull_date: text("pull_date").notNull(),
  doc_no: text("doc_no").notNull(),
  debtor_name: text("debtor_name"),
  location: text("location"),
  region: text("region"),
  balance: integer("balance"),
  original_expiry_date: text("original_expiry_date"),
  extended_to: text("extended_to"),
  remark4: text("remark4"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── purchase_order_docs ───────────────────────────────────
// Header-level PO records. Joined with purchase_orders for the
// "outstanding" view (header open + at least one open line).
export const purchase_order_docs = sqliteTable("purchase_order_docs", {
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

// ── project_finance ───────────────────────────────────────
// One row per project with rental + sales + cost totals. The List
// finance tab joins this onto the project list.
export const project_finance = sqliteTable("project_finance", {
  project_id: integer("project_id").primaryKey(),
  rental: integer("rental"),
  total_sales: integer("total_sales"),
  contractor_cost: integer("contractor_cost"),
  license_fee: integer("license_fee"),
  updated_at: text("updated_at"),
});

// ── project_checklist_sections (mig 050) ──────────────────
// Per-project tasklist sections — group tasks into stages like
// "Pre-event / Setup / Live / Teardown". Section completion drives
// the new stage-chip progress UI on the project detail page.
export const project_checklist_sections = sqliteTable("project_checklist_sections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull(),
  name: text("name").notNull(),
  sort_order: integer("sort_order").notNull().default(0),
  // mig 085 — "list" (default) or "documents" (6-col table layout).
  display_mode: text("display_mode").notNull().default("list"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── project_checklist_template_sections (mig 050) ─────────
// Same shape on the template side; cloned to project sections on
// project create, then template_items.section_id is mapped to the
// new project section_id.
export const project_checklist_template_sections = sqliteTable(
  "project_checklist_template_sections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    template_id: integer("template_id").notNull(),
    name: text("name").notNull(),
    sort_order: integer("sort_order").notNull().default(0),
    display_mode: text("display_mode").notNull().default("list"),
    created_at: text("created_at").default(sql`(datetime('now'))`),
  }
);

// ── project_checklist_attachments (mig 050) ───────────────
// Per-task file attachments. Replaces the project-level Attachments
// panel — old project_attachments rows stay intact for legacy data.
export const project_checklist_attachments = sqliteTable(
  "project_checklist_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    item_id: integer("item_id").notNull(),
    r2_key: text("r2_key").notNull(),
    file_name: text("file_name").notNull(),
    content_type: text("content_type"),
    size_bytes: integer("size_bytes"),
    uploaded_by: integer("uploaded_by"),
    uploaded_at: text("uploaded_at").default(sql`(datetime('now'))`),
    archived_at: text("archived_at"),
  }
);

// ── project_checklist (existing — added section_id) ───────
// Per-project tasklist row. section_id is nullable; tasks without a
// section land in the "Uncategorised" bucket on the UI.
export const project_checklist = sqliteTable("project_checklist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull(),
  section_id: integer("section_id"),
  seq: integer("seq").notNull().default(0),
  title: text("title").notNull(),
  description: text("description"),
  required_perm: text("required_perm"),
  // mig 085 — display-only owner tag, separate from required_perm.
  role_label: text("role_label"),
  // mig 086 — opt-in flag; when 1 the row surfaces in the Driver App.
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
  created_at: text("created_at").default(sql`(datetime('now'))`),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
});

// ── project_checklist_templates ───────────────────────────
export const project_checklist_templates = sqliteTable("project_checklist_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── project_checklist_template_items (mig 050: + section_id, requires_review) ─
export const project_checklist_template_items = sqliteTable(
  "project_checklist_template_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
  }
);

// ── sales_entries (mig 041; mig 051 added payment-split columns) ─
// Rep-keyed sales transactions. `amount` is the gross; `deposit_amount`
// is what was collected on event day (balance = amount - deposit, not
// stored). `deposit_payment_type` is one of cash/card_cc/card_db/epp.
// `sales_person_id` defaults to created_by but admins can key entries
// on behalf of another rep, so it's a separate column.
export const sales_entries = sqliteTable("sales_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  created_at: text("created_at").default(sql`(datetime('now'))`),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
  archived_at: text("archived_at"),
});

// Per-line items on a sales entry. UI computes amount = qty * unit_price
// but we store it so reports don't have to recompute.
export const sales_entry_items = sqliteTable("sales_entry_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entry_id: integer("entry_id").notNull(),
  line_no: integer("line_no").notNull().default(0),
  item_code: text("item_code"),
  item_description: text("item_description"),
  remarks: text("remarks"),
  qty: real("qty").notNull().default(1),
  unit_price: real("unit_price").notNull().default(0),
  amount: real("amount").notNull().default(0),
  group_tag: text("group_tag"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// Per-payment rows on a sales entry. Replaces single-deposit semantics;
// the first payment's amount + method are mirrored into
// sales_entries.deposit_* for backward compat with the list view.
export const sales_entry_payments = sqliteTable("sales_entry_payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entry_id: integer("entry_id").notNull(),
  paid_at: text("paid_at").notNull(),
  payment_method: text("payment_method").notNull(),
  amount: real("amount").notNull(),
  account_sheet: text("account_sheet"),
  approval_code: text("approval_code"),
  collected_by: text("collected_by"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── project_finance_lines ─────────────────────────────────
// Per-line ledger of finance entries. `kind` separates revenue
// (`income`) from cost (`cost`). `category` is a free-text tag.
export const project_finance_lines = sqliteTable("project_finance_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull(),
  kind: text("kind").notNull(),
  category: text("category"),
  description: text("description"),
  amount: integer("amount"),
  occurred_at: text("occurred_at"),
  notes: text("notes"),
  r2_key: text("r2_key"),
  file_name: text("file_name"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  created_by: integer("created_by"),
  archived_at: text("archived_at"),
  // Mig 063 — non-null for rows generated by the cost-rate engine
  // (transport / merchandise / commission). UI locks edit + delete on
  // these; the recompute service is the only writer.
  auto_source: text("auto_source"),
});

// ── project_cost_rates (mig 063) ──────────────────────────
// Per-brand rate card driving the auto cost-line engine. Edited via
// Project Maintenance → Cost Rates by anyone with `projects.manage`.
export const project_cost_rates = sqliteTable("project_cost_rates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  brand: text("brand").notNull().unique(),
  transport_pct: integer("transport_pct").notNull().default(0),
  merchandise_pct: integer("merchandise_pct").notNull().default(0),
  commission_normal_pct: integer("commission_normal_pct").notNull().default(0),
  commission_boost_pct: integer("commission_boost_pct"),
  boost_min_gp_pct: integer("boost_min_gp_pct"),
  boost_min_sales: integer("boost_min_sales"),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
  updated_by: integer("updated_by"),
});

// ── point_transactions (mig 055) ──────────────────────────
// Append-only ledger. `users.points_balance` and
// `users.gifting_balance` are caches derived from this table; never
// write balances without a matching row here.
export const point_transactions = sqliteTable("point_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id").notNull(),
  pool: text("pool").notNull(), // 'earned' | 'gifting'
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  ref_type: text("ref_type"),
  ref_id: integer("ref_id"),
  counterparty_user_id: integer("counterparty_user_id"),
  note: text("note"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── user_streak_weeks (mig 055) ───────────────────────────
// One row per user × ISO-week. `qualified` flips to 1 when
// upvotes_count >= gamify_settings.streak_weekly_threshold.
export const user_streak_weeks = sqliteTable(
  "user_streak_weeks",
  {
    user_id: integer("user_id").notNull(),
    iso_week: text("iso_week").notNull(),
    upvotes_count: integer("upvotes_count").notNull().default(0),
    qualified: integer("qualified").notNull().default(0),
    computed_at: text("computed_at").default(sql`(datetime('now'))`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.user_id, t.iso_week] }),
  })
);

// ── leaderboard_cache (mig 055) ───────────────────────────
// Pre-aggregated top-N rows per (scope, period). Scope is 'company'
// or 'department:{id}'; period is 'week' | 'month' | 'all'.
export const leaderboard_cache = sqliteTable(
  "leaderboard_cache",
  {
    scope: text("scope").notNull(),
    period: text("period").notNull(),
    computed_at: text("computed_at").notNull(),
    rows_json: text("rows_json").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scope, t.period] }),
  })
);

// ── gamify_settings (mig 055) ─────────────────────────────
// Admin-tunable values: monthly_gifting_amount, streak threshold,
// per-action point values. TEXT-stored, parsed on read.
export const gamify_settings = sqliteTable("gamify_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ── awards (mig 056) ──────────────────────────────────────
// Admin-curated catalogue of redeemable items.
export const awards = sqliteTable("awards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  cost_points: integer("cost_points").notNull(),
  stock: integer("stock"),
  image_r2_key: text("image_r2_key"),
  active: integer("active").notNull().default(1),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
});

// ── award_redemptions (mig 056) ───────────────────────────
// Lifecycle: pending -> shipped -> delivered, or cancelled.
export const award_redemptions = sqliteTable("award_redemptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  award_id: integer("award_id").notNull(),
  user_id: integer("user_id").notNull(),
  cost_points: integer("cost_points").notNull(),
  status: text("status").notNull().default("pending"),
  shipping_addr: text("shipping_addr"),
  admin_note: text("admin_note"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  shipped_at: text("shipped_at"),
  delivered_at: text("delivered_at"),
  cancelled_at: text("cancelled_at"),
  cancelled_by: integer("cancelled_by"),
  ledger_tx_id: integer("ledger_tx_id"),
});

// ── innovations (mig 057) ─────────────────────────────────
// Strategic ideas: build / explore / improve. Status pipeline drives
// the point award when status reaches 'shipped'.
export const innovations = sqliteTable("innovations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  tags: text("tags"),
  status: text("status").notNull().default("review"),
  decided_by: integer("decided_by"),
  decided_at: text("decided_at"),
  decline_reason: text("decline_reason"),
  awarded_at: text("awarded_at"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  archived_at: text("archived_at"),
});

// ── suggestions (mig 057) ─────────────────────────────────
// Operational fixes. Status pipeline drives the point award when
// status reaches 'approved'.
export const suggestions = sqliteTable("suggestions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  status: text("status").notNull().default("review"),
  decided_by: integer("decided_by"),
  decided_at: text("decided_at"),
  decline_reason: text("decline_reason"),
  awarded_at: text("awarded_at"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  archived_at: text("archived_at"),
});

// ── votes (mig 057) ───────────────────────────────────────
// Polymorphic upvotes; one row per (target, voter).
export const votes = sqliteTable(
  "votes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    target_type: text("target_type").notNull(),
    target_id: integer("target_id").notNull(),
    user_id: integer("user_id").notNull(),
    created_at: text("created_at").default(sql`(datetime('now'))`),
  },
);

// ── idea_attachments (mig 059) ────────────────────────────
// Polymorphic file attachments for innovation + suggestion posts.
// Bytes live in R2 (POD_BUCKET); this table carries the key.
export const idea_attachments = sqliteTable("idea_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  target_type: text("target_type").notNull(),
  target_id: integer("target_id").notNull(),
  r2_key: text("r2_key").notNull(),
  file_name: text("file_name").notNull(),
  content_type: text("content_type"),
  size_bytes: integer("size_bytes"),
  uploaded_by: integer("uploaded_by"),
  uploaded_at: text("uploaded_at").default(sql`(datetime('now'))`),
  archived_at: text("archived_at"),
});

// ── petty_cash_entries (mig 060) ──────────────────────────
// Single global petty-cash float for v1. amount_cents is always
// positive; sign comes from `direction`.
export const petty_cash_entries = sqliteTable("petty_cash_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  direction: text("direction").notNull(),
  amount_cents: integer("amount_cents").notNull(),
  category: text("category"),
  counterparty: text("counterparty"),
  note: text("note"),
  receipt_r2_key: text("receipt_r2_key"),
  posted_by: integer("posted_by").notNull(),
  occurred_on: text("occurred_on").notNull(),
  archived_at: text("archived_at"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
});

// ── sales_positions / sales_commission_tiers / sales_reps (mig 067) ─
// Retail rep org chart, separate from the workspace `users` directory.
// See migration 067_sales_team.sql for the rationale.

export const sales_positions = sqliteTable("sales_positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  level: integer("level").notNull().default(20),
  sort_order: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

export const sales_commission_tiers = sqliteTable("sales_commission_tiers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  rate: integer("rate").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

export const sales_reps = sqliteTable("sales_reps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  // Mig 068 — NRIC for payroll, secondary upline for reps that report
  // to two seniors, personal floor rate for the per-rep tier table.
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
  created_at: text("created_at").default(sql`(datetime('now'))`),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
  archived_at: text("archived_at"),
  archived_by: integer("archived_by"),
});

export const sales_rep_commission_tiers = sqliteTable(
  "sales_rep_commission_tiers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rep_id: integer("rep_id").notNull(),
    threshold: integer("threshold").notNull().default(0),
    rate: integer("rate").notNull().default(0),
    sort_order: integer("sort_order").notNull().default(0),
    created_at: text("created_at").default(sql`(datetime('now'))`),
  },
);

export const sales_rep_brands = sqliteTable(
  "sales_rep_brands",
  {
    rep_id: integer("rep_id").notNull(),
    brand: text("brand").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.rep_id, t.brand] }),
  })
);

export const sales_team_activity = sqliteTable("sales_team_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  rep_id: integer("rep_id").notNull(),
  action: text("action").notNull(),
  from_value: text("from_value"),
  to_value: text("to_value"),
  note: text("note"),
  user_id: integer("user_id"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ── project_sales_attendees (mig 087) ─────────────────────────
// N reps attend per project (booth duty etc). Separate from pic_id
// which is one User who owns the project.
export const project_sales_attendees = sqliteTable(
  "project_sales_attendees",
  {
    project_id: integer("project_id").notNull(),
    sales_rep_id: integer("sales_rep_id").notNull(),
    created_at: text("created_at").default(sql`(datetime('now'))`),
    created_by: integer("created_by"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.project_id, t.sales_rep_id] }),
  })
);
