CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,                        -- JSON-encoded value
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by INTEGER
);

CREATE TABLE assr_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  note TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')), customer_id INTEGER, source TEXT DEFAULT 'staff'
  CHECK(source IN ('staff','customer','system')), archived_at TEXT, archived_by INTEGER, category TEXT DEFAULT 'system'
  CHECK (category IN ('purchasing','customer','system')), stage_elapsed_days REAL, stage_target_days REAL, source_channel TEXT, references_entry_id INTEGER, is_correction INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);

CREATE TABLE assr_alert_acks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL REFERENCES assr_cases(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  event TEXT NOT NULL,          -- 'stage_entered' | 'half_time' | 'approaching_breach' | 'breach' | 'manager_override'
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT,                    -- optional, <= 200 chars enforced at route layer
  snoozed_until TEXT,           -- when set, alerts of this stage/event are suppressed until this time
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assr_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  file_name TEXT,
  content_type TEXT,
  category TEXT DEFAULT 'complaint'
    CHECK(category IN ('complaint','evidence','completion','signature')),
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')), customer_id INTEGER, source TEXT DEFAULT 'staff'
  CHECK(source IN ('staff','customer','system')), visible_to_customer INTEGER DEFAULT 1, archived_at TEXT, archived_by INTEGER,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);

CREATE TABLE "assr_cases" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_no TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'Open',
  doc_no TEXT NOT NULL,
  complained_date TEXT,
  customer_name TEXT,
  phone TEXT,
  location TEXT,
  sales_agent TEXT,
  item_code TEXT,
  complaint_issue TEXT,
  action_remark TEXT,
  service_category TEXT,
  completion_date TEXT,
  po_no TEXT,
  addr1 TEXT,
  addr2 TEXT,
  addr3 TEXT,
  addr4 TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  stage TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (stage IN (
      'pending_review',
      'under_verification',
      'pending_solution',
      'pending_inspection',
      'pending_item_pickup',
      'pending_supplier_pickup',
      'pending_item_ready',
      'pending_delivery_service',
      'completed'
    )),
  resolution_method TEXT
    CHECK (resolution_method IS NULL OR resolution_method IN (
      'replace_unit','supplier_repair','field_service_own','field_service_supplier','return_visit'
    )),
  issue_category TEXT,
  priority TEXT DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to INTEGER,
  ref_no TEXT,
  delivery_order TEXT,
  do_date TEXT,
  closed_at TEXT,
  created_by INTEGER,
  satisfaction_rating INTEGER,
  satisfaction_notes TEXT,
  approved_by INTEGER,
  approved_at TEXT,
  quality_review_passed INTEGER,
  ncr_category TEXT,
  po_amount REAL,
  supplier_invoice_ref TEXT,
  cost_notes TEXT,
  sla_hours INTEGER,
  deadline_at TEXT,
  escalated_at TEXT,
  customer_id INTEGER,
  archived_at TEXT,
  archived_by INTEGER,
  customer_email TEXT,
  creditor_code TEXT,
  customer_amount REAL,
  supplier_pickup_at TEXT,
  items_ready_at TEXT,
  stage_changed_at TEXT,
  stage_entered_at TEXT,
  stage_target_days REAL,
  inspection_result TEXT
    CHECK (inspection_result IS NULL OR inspection_result IN ('pass','fail','na')),
  email_for_survey TEXT,
  lead_time_profile_id INTEGER
, verification_outcome  TEXT
  CHECK (verification_outcome IN ('accepted','rejected','needs_more_info')), verified_root_cause   TEXT, verified_by           INTEGER REFERENCES users(id), verified_at           TEXT);

CREATE TABLE assr_issue_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE assr_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  item_code TEXT NOT NULL,
  item_description TEXT,
  qty INTEGER DEFAULT 1,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);

CREATE TABLE assr_lead_time_activations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id             INTEGER NOT NULL REFERENCES assr_lead_time_profiles(id),
  source                 TEXT NOT NULL
                            CHECK (source IN ('manual','scheduled')),
  scheduled_id           INTEGER REFERENCES assr_lead_time_scheduled_activations(id),
  user_id                INTEGER REFERENCES users(id),
  previous_profile_id    INTEGER,
  activated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assr_lead_time_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES assr_lead_time_profiles(id),
  stage TEXT NOT NULL,
  before_days REAL,
  after_days REAL NOT NULL,
  reason TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assr_lead_time_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assr_lead_time_scheduled_activations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id      INTEGER NOT NULL REFERENCES assr_lead_time_profiles(id) ON DELETE CASCADE,
  scheduled_for   TEXT NOT NULL,
  scheduled_by    INTEGER REFERENCES users(id),
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','fired','cancelled')),
  fired_at        TEXT,
  cancelled_at    TEXT,
  cancelled_by    INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assr_logistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('pickup','delivery')),
  scheduled_date TEXT,
  scheduled_time_range TEXT,
  assigned_to INTEGER,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','scheduled','completed','cancelled')),
  notes TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), archived_at TEXT, archived_by INTEGER,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);

CREATE TABLE assr_ncr_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE assr_priorities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  sla_hours INTEGER,                          -- optional override of slaHoursFor()
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE assr_priority_stage_targets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  priority_id   INTEGER NOT NULL REFERENCES assr_priorities(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  target_days   REAL NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(priority_id, stage)
);

CREATE TABLE assr_resolution_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE assr_stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL REFERENCES assr_cases(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  entered_at TEXT NOT NULL DEFAULT (datetime('now')),
  exited_at TEXT,
  target_days REAL,
  status TEXT,            -- 'green' | 'amber' | 'red' — computed by alert engine
  skipped INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  alerts_fired INTEGER NOT NULL DEFAULT 0,
  snoozes_applied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE assr_stage_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES assr_lead_time_profiles(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  target_days REAL NOT NULL,
  UNIQUE(profile_id, stage)
);

CREATE TABLE assr_supplier_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  assr_id INTEGER NOT NULL REFERENCES assr_cases(id) ON DELETE CASCADE,
  creditor_code TEXT,                 -- scopes the token to a specific supplier; NULL = any supplier
  expires_at TEXT,                    -- ISO timestamp; NULL = no expiry
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE assr_survey_tokens (
  token TEXT PRIMARY KEY,             -- random string in the URL
  assr_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,                    -- nullable; null = never expires
  submitted_at TEXT,                  -- filled on submission
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);

CREATE TABLE award_redemptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  award_id      INTEGER NOT NULL REFERENCES awards(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  cost_points   INTEGER NOT NULL,        -- snapshot at time of redeem
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','shipped','delivered','cancelled')),
  shipping_addr TEXT,
  admin_note    TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  shipped_at    TEXT,
  delivered_at  TEXT,
  cancelled_at  TEXT,
  cancelled_by  INTEGER REFERENCES users(id),
  ledger_tx_id  INTEGER REFERENCES point_transactions(id)
);

CREATE TABLE awards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  cost_points  INTEGER NOT NULL,
  stock        INTEGER,                  -- NULL = unlimited
  image_r2_key TEXT,                     -- key in POD_BUCKET; NULL = no image yet
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE case_track_tokens (
  token TEXT PRIMARY KEY,
  assr_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'customer'
    CHECK(source IN ('customer','staff')),
  verified_phone TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);

CREATE TABLE creditors (
  creditor_code              TEXT PRIMARY KEY,
  company_name               TEXT,    -- CreditorCompanyName (display name)
  desc2                      TEXT,    -- CreditorDesc2 (alt name)

  address1                   TEXT,
  address2                   TEXT,
  address3                   TEXT,
  address4                   TEXT,
  post_code                  TEXT,

  deliver_address1           TEXT,
  deliver_address2           TEXT,
  deliver_address3           TEXT,
  deliver_address4           TEXT,
  deliver_post_code          TEXT,

  attention                  TEXT,
  phone1                     TEXT,
  phone2                     TEXT,
  mobile                     TEXT,
  fax1                       TEXT,
  fax2                       TEXT,
  email                      TEXT,
  web_url                    TEXT,
  contact_info               TEXT,    -- CreditorContactInfo
  nature_of_business         TEXT,

  currency_code              TEXT,
  display_term               TEXT,
  rounding_method            TEXT,
  inclusive_tax              INTEGER,
  price_category             TEXT,
  statement_type             TEXT,
  aging_on                   TEXT,
  credit_limit               REAL,
  overdue_limit              REAL,

  tax_code                   TEXT,
  tax_register_no            TEXT,
  gst_register_no            TEXT,
  sst_register_no            TEXT,
  self_billed_approval_no    TEXT,
  exempt_no                  TEXT,
  exempt_expiry_date         TEXT,
  register_no                TEXT,
  gst_status_verified_date   TEXT,

  area_code                  TEXT,
  area_description           TEXT,
  area_desc2                 TEXT,
  type                       TEXT,
  type_description           TEXT,
  type_desc2                 TEXT,
  purchase_agent             TEXT,
  purchase_agent_description TEXT,
  parent_acc_no              TEXT,

  note                       TEXT,

  last_modified              TEXT,
  last_modified_user_id      TEXT,
  created_timestamp          TEXT,
  created_user_id            TEXT,

  is_active                  INTEGER DEFAULT 1,
  raw                        TEXT,
  created_at                 TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE daily_inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL,
  driver_user_id INTEGER NOT NULL,
  inspection_date TEXT NOT NULL,
  checklist_json TEXT NOT NULL DEFAULT '{}',
  passed INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  photo_r2_keys TEXT DEFAULT '[]',
  submitted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(lorry_id, inspection_date),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id),
  FOREIGN KEY (driver_user_id) REFERENCES users(id)
);

CREATE TABLE delivery_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (doc_no) REFERENCES delivery_tracking(doc_no),
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE delivery_tracking (
  doc_no TEXT PRIMARY KEY,

  region TEXT NOT NULL CHECK(region IN ('WEST','EAST','SG')),

  status TEXT NOT NULL DEFAULT 'do_ready'
    CHECK(status IN (
      'do_ready',
      'pending_shipout',
      'shipped',
      'in_transit',
      'at_warehouse',
      'out_for_delivery',
      'delivered',
      'failed'
    )),

  do_ready_at TEXT,               -- when goods were marked ready
  shipout_date TEXT,              -- planned shipout (SG/EM)
  pickup_confirmed_at TEXT,       -- verified pickup occurred (SG/EM step 3)
  est_arrival_date TEXT,          -- estimated arrival at EM warehouse (EM step 4)
  arrived_warehouse_at TEXT,      -- confirmed arrival at SBH/SRW (EM step 5)
  est_delivery_date TEXT,         -- estimated final delivery (all regions)
  out_for_delivery_at TEXT,       -- dispatched for last mile
  delivered_at TEXT,              -- actual delivery confirmed
  failed_at TEXT,
  failure_reason TEXT,

  order_revenue REAL DEFAULT 0,   -- copied from sales_orders.local_total
  budget_pct REAL DEFAULT 3,      -- from system_settings at creation time
  budget_amount REAL DEFAULT 0,   -- revenue × pct / 100

  freight_cost REAL DEFAULT 0,    -- EM: sea freight / SG: SST
  last_mile_cost REAL DEFAULT 0,  -- all regions
  total_cost REAL DEFAULT 0,      -- freight + last_mile (auto-computed)

  customer_transport_fee REAL DEFAULT 0,  -- what customer was charged (SG/EM)
  delivery_method TEXT DEFAULT 'self'
    CHECK(delivery_method IN ('self','outsource')),

  trip_id INTEGER,                -- FK to trips (WEST/SG drop-off trip)
  vendor_id INTEGER,              -- FK to vendors (future, nullable)
  em_warehouse TEXT,              -- SBH / SRW for EM orders
  vendor_name TEXT,               -- outsource vendor name (until vendor table)

  notes TEXT,

  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (doc_no) REFERENCES sales_orders(doc_no),
  FOREIGN KEY (trip_id) REFERENCES trips(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT NOT NULL DEFAULT '64748b',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE driver_clock_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  clock_date TEXT NOT NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  total_hours REAL,
  rest_minutes REAL DEFAULT 0,
  is_overtime INTEGER DEFAULT 0,
  fatigue_alert INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, clock_date),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  ref_type TEXT,                     -- 'assr' | 'supplier' | 'project' | ...
  ref_id   INTEGER,
  to_addr TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL,
  provider_id TEXT,                  -- Resend message id when available
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('setup','dismantle')),
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,           -- YYYY-MM-DD
  address TEXT,
  status TEXT,                         -- free text for now (lifecycle TBD)
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE gamify_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE idea_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT NOT NULL CHECK (target_type IN ('innovation','suggestion')),
  target_id     INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    INTEGER,
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT DEFAULT (datetime('now')),
  archived_at   TEXT
);

CREATE TABLE idea_comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT NOT NULL CHECK (target_type IN ('innovation','suggestion')),
  target_id     INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  edited_at     TEXT,
  archived_at   TEXT
);

CREATE TABLE innovations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  tags           TEXT,
  status         TEXT NOT NULL DEFAULT 'review'
                 CHECK (status IN ('review','accepted','in_progress','shipped','declined')),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TEXT,
  decline_reason TEXT,
  awarded_at     TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
, archived_at TEXT);

CREATE TABLE invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  role_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  invited_by INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (invited_by) REFERENCES users(id)
);

CREATE TABLE leaderboard_cache (
  scope        TEXT NOT NULL,
  period       TEXT NOT NULL,
  computed_at  TEXT NOT NULL,
  rows_json    TEXT NOT NULL,
  PRIMARY KEY (scope, period)
);

CREATE TABLE lorries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate TEXT UNIQUE NOT NULL,
  size TEXT,                                  -- 17ft / 21ft / outsource
  warehouse TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 1,
  default_driver_user_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), model TEXT, purchase_date TEXT, capacity_m3 REAL, capacity_kg REAL, road_tax_expiry TEXT, insurance_expiry TEXT, puspakom_expiry TEXT, status TEXT DEFAULT 'active'
  CHECK(status IN ('active','maintenance','retired')),
  FOREIGN KEY (warehouse) REFERENCES warehouses(code),
  FOREIGN KEY (default_driver_user_id) REFERENCES users(id)
);

CREATE TABLE lorry_compliance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('puspakom','road_tax','insurance')),
  expiry_date TEXT NOT NULL,
  renewal_date TEXT,
  document_r2_key TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id)
);

CREATE TABLE lorry_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL,
  trip_id INTEGER,
  incident_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('damage','accident','claim','other')),
  description TEXT,
  cost_estimate REAL DEFAULT 0,
  photo_r2_keys TEXT DEFAULT '[]',
  insurance_claim_ref TEXT,
  claim_status TEXT DEFAULT 'none'
    CHECK(claim_status IN ('none','filed','approved','rejected','settled')),
  liability TEXT DEFAULT 'houzs'
    CHECK(liability IN ('houzs','vendor','driver','shared')),
  resolved_at TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id),
  FOREIGN KEY (trip_id) REFERENCES trips(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE lorry_maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('service','repair','inspection','other')),
  description TEXT,
  cost REAL DEFAULT 0,
  vendor_name TEXT,
  invoice_r2_key TEXT,
  maintenance_date TEXT NOT NULL,
  unavailable_from TEXT,
  unavailable_to TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  requested_by INTEGER,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE petty_cash_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  category        TEXT,
  counterparty    TEXT,
  note            TEXT,
  receipt_r2_key  TEXT,
  posted_by       INTEGER NOT NULL REFERENCES users(id),
  occurred_on     TEXT NOT NULL,
  archived_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE point_transactions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  pool                 TEXT NOT NULL CHECK (pool IN ('earned','gifting')),
  delta                INTEGER NOT NULL,
  reason               TEXT NOT NULL,
  ref_type             TEXT,
  ref_id               INTEGER,
  counterparty_user_id INTEGER REFERENCES users(id),
  note                 TEXT,
  created_at           TEXT DEFAULT (datetime('now'))
);

CREATE TABLE project_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  action TEXT NOT NULL,                  -- 'stage_change' | 'checklist_done' | 'finance_edit' | ...
  from_value TEXT,
  to_value TEXT,
  note TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  category TEXT,
  r2_key TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT, uploaded_by_role TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_brands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '64748b',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE project_checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  required_perm TEXT,                    -- same semantics as template
  due_date TEXT,                         -- resolved date (YYYY-MM-DD)
  owner_user_id INTEGER,                 -- users.id (assignee)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','done','na','blocked')),
  evidence_r2_key TEXT,                  -- optional file evidence (e.g. permit PDF)
  completed_by INTEGER,                  -- users.id who marked done
  completed_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), review_status TEXT, rejection_reason TEXT, section_id INTEGER
  REFERENCES project_checklist_sections(id) ON DELETE SET NULL, due_offset_days INTEGER, role_label TEXT, crew_visible INTEGER NOT NULL DEFAULT 0, pill_kind TEXT, pill_value TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_checklist_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    INTEGER,
  uploaded_by   INTEGER,
  uploaded_at   TEXT DEFAULT (datetime('now')),
  archived_at   TEXT,
  FOREIGN KEY (item_id) REFERENCES project_checklist(id) ON DELETE CASCADE
);

CREATE TABLE project_checklist_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note','submit','reject','amend','approve')),
  body TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES project_checklist(id) ON DELETE CASCADE
);

CREATE TABLE project_checklist_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')), display_mode TEXT NOT NULL DEFAULT 'list',
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_checklist_template_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,                  -- display order
  title TEXT NOT NULL,
  description TEXT,
  required_perm TEXT,
  due_offset_days INTEGER, section_id INTEGER
  REFERENCES project_checklist_template_sections(id) ON DELETE SET NULL, requires_review INTEGER NOT NULL DEFAULT 0, role_label TEXT, crew_visible INTEGER NOT NULL DEFAULT 0, pill_kind TEXT, pill_value TEXT,
  FOREIGN KEY (template_id) REFERENCES project_checklist_templates(id) ON DELETE CASCADE
);

CREATE TABLE project_checklist_template_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')), display_mode TEXT NOT NULL DEFAULT 'list',
  FOREIGN KEY (template_id) REFERENCES project_checklist_templates(id) ON DELETE CASCADE
);

CREATE TABLE project_checklist_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE project_cost_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL UNIQUE,
  transport_pct REAL NOT NULL DEFAULT 0,
  merchandise_pct REAL NOT NULL DEFAULT 0,
  commission_normal_pct REAL NOT NULL DEFAULT 0,
  commission_boost_pct REAL,
  boost_min_gp_pct REAL,         -- NULL = no GP gate; just sales
  boost_min_sales REAL,          -- NULL = no sales gate; just GP
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by INTEGER
);

CREATE TABLE project_defects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('setup', 'dismantle')),
  reported_by_role TEXT NOT NULL CHECK (reported_by_role IN ('sales', 'logistic')),
  item_code TEXT,
  item_description TEXT,
  size TEXT,
  quantity INTEGER DEFAULT 1,
  reason TEXT,
  photo_r2_key TEXT,                 -- optional single photo; richer media goes to attachments
  reported_by INTEGER,               -- users.id
  reported_at TEXT DEFAULT (datetime('now')),
  resolved INTEGER DEFAULT 0,
  resolved_notes TEXT,
  linked_assr_id INTEGER,            -- optional ASSR case link
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_assr_id) REFERENCES assr_cases(id) ON DELETE SET NULL
);

CREATE TABLE project_event_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,             -- 'solo' | 'exhibition'
  name TEXT NOT NULL,                    -- display label
  default_template_id INTEGER,           -- → project_checklist_templates.id
  sort_order INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE project_finance (
  project_id INTEGER PRIMARY KEY,
  rental REAL,
  contractor_cost REAL,
  license_fee REAL,
  deposit_paid REAL,
  deposit_refund REAL,
  misc_cost REAL,
  total_sales REAL,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_finance_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'cost')),
  category TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  occurred_at TEXT,
  r2_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT, auto_source TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_organizers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE project_phase_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase         TEXT    NOT NULL CHECK (phase IN ('setup','dismantle')),
  r2_key        TEXT    NOT NULL,
  content_type  TEXT,
  caption       TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_reads (
  user_id       INTEGER NOT NULL,
  project_id    INTEGER NOT NULL,
  last_read_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_sales_attendees (
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sales_rep_id INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   INTEGER,
  PRIMARY KEY (project_id, sales_rep_id)
);

CREATE TABLE project_sales_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT,                         -- "Day 1", "Final", etc.
  sales_amount REAL,                  -- RM
  period_start TEXT,                  -- optional date
  period_end   TEXT,
  r2_key TEXT,                        -- optional attached report image/PDF
  file_name TEXT,
  mime_type TEXT,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('out', 'return')),
  transferred_at TEXT,                   -- ISO datetime when the move happened
  record_r2_key TEXT,                    -- optional photo/PDF of the transfer sheet
  file_name TEXT,
  mime_type TEXT,
  notes TEXT,
  confirmed_at TEXT,
  confirmed_by INTEGER,                  -- users.id
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE project_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT,                             -- 'designer' | 'manager' | 'sales' | 'onsite' | ...
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, user_id, role)
);

CREATE TABLE project_venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  state TEXT,                              -- optional: pre-fill projects.state when picked
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE "projects" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'draft'
    CHECK (stage IN ('draft','setup','live','dismantle','completed')),
  start_date TEXT,
  end_date TEXT,
  organizer TEXT,
  state TEXT,
  venue TEXT,
  venue_address TEXT,
  brand TEXT,
  event_type_id INTEGER,
  booth_no TEXT,
  size_sqm REAL,
  notion_url TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  archived_by INTEGER,
  setup_start_at TEXT,
  setup_end_at TEXT,
  dismantle_start_at TEXT,
  dismantle_end_at TEXT,
  setup_driver_user_id INTEGER,
  setup_lorry_id INTEGER,
  dismantle_driver_user_id INTEGER,
  dismantle_lorry_id INTEGER,
  banner_message TEXT,
  banner_tone TEXT,
  payment_status TEXT DEFAULT 'not_started',
  payment_proof_r2_key TEXT,
  payment_proof_file_name TEXT,
  payment_notes TEXT,
  payment_updated_at TEXT,
  payment_updated_by INTEGER,
  pic_id INTEGER, setup_helper_1_id           INTEGER REFERENCES users(id), setup_helper_2_id           INTEGER REFERENCES users(id), setup_helper_outsourced     INTEGER NOT NULL DEFAULT 0, dismantle_helper_1_id       INTEGER REFERENCES users(id), dismantle_helper_2_id       INTEGER REFERENCES users(id), dismantle_helper_outsourced INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (event_type_id) REFERENCES project_event_types(id) ON DELETE SET NULL,
  FOREIGN KEY (pic_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE purchase_order_docs (
  doc_no         TEXT PRIMARY KEY,
  doc_date       TEXT,
  ref            TEXT,
  so_doc_no      TEXT,
  creditor_code  TEXT,
  creditor_name  TEXT,
  purchase_location TEXT,
  doc_status     TEXT,
  cancelled      INTEGER DEFAULT 0,
  local_ex_tax   REAL,
  local_tax      REAL,
  local_net_total REAL,
  final_total    REAL,
  currency_code  TEXT,
  currency_rate  REAL,
  remark1        TEXT,
  remark2        TEXT,
  remark3        TEXT,
  remark4        TEXT,
  note           TEXT,
  last_modified  TEXT,
  amount_source  TEXT,    -- 'sync' or 'manual'
  amount_updated_at TEXT,
  amount_updated_by INTEGER,
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
, raw TEXT);

CREATE TABLE role_page_access (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  page_key   TEXT    NOT NULL,
  level      TEXT    NOT NULL CHECK (level IN ('none','partial','full')),
  created_at TEXT    DEFAULT (datetime('now')),
  updated_at TEXT    DEFAULT (datetime('now')),
  PRIMARY KEY (role_id, page_key)
);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
, scope_to_pic INTEGER NOT NULL DEFAULT 0);

CREATE TABLE salary_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  period TEXT NOT NULL,                -- YYYY-MM
  base_pay REAL DEFAULT 0,
  trip_count INTEGER DEFAULT 0,
  trip_allowance_total REAL DEFAULT 0,
  ot_hours REAL DEFAULT 0,
  ot_amount REAL DEFAULT 0,
  deductions_json TEXT DEFAULT '[]',
  deductions_total REAL DEFAULT 0,
  gross REAL DEFAULT 0,
  net REAL DEFAULT 0,
  status TEXT DEFAULT 'draft'
    CHECK(status IN ('draft','confirmed','paid')),
  confirmed_by INTEGER,
  confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, period),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (confirmed_by) REFERENCES users(id)
);

CREATE TABLE salary_trip_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salary_record_id INTEGER,
  user_id INTEGER NOT NULL,
  trip_id INTEGER NOT NULL,
  trip_date TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('driver','helper')),
  trip_allowance REAL DEFAULT 0,
  ot_hours REAL DEFAULT 0,
  ot_amount REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, trip_id),
  FOREIGN KEY (salary_record_id) REFERENCES salary_records(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE sales_commission_tiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  rate        REAL NOT NULL DEFAULT 0,        -- percent
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sales_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  customer_name    TEXT NOT NULL,
  customer_code    TEXT,                           -- AutoCount customer code
  amount           REAL NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'MYR',
  occurred_at      TEXT NOT NULL,                  -- ISO yyyy-mm-dd
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'draft',  -- draft | submitted | pushed | void
  autocount_doc_no   TEXT,
  autocount_doc_type TEXT,                         -- 'SO' | 'INV'
  pushed_at          TEXT,
  push_error         TEXT,
  created_by       INTEGER NOT NULL,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now')),
  archived_at      TEXT, ref_no TEXT, deposit_amount REAL, deposit_payment_type TEXT, sales_person_id INTEGER REFERENCES users(id), customer_address TEXT, customer_phone TEXT, sales_rep_id INTEGER
  REFERENCES sales_reps(id) ON DELETE SET NULL, doc_no TEXT, processing_date TEXT, delivery_date TEXT, status_2 TEXT, customer_address_2 TEXT, customer_postcode TEXT, customer_state TEXT, customer_phone_2 TEXT, customer_email TEXT, venue TEXT, warehouse TEXT, branding TEXT, po_doc_no TEXT, payment_status TEXT, source TEXT, remarks TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE sales_entry_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        INTEGER NOT NULL REFERENCES sales_entries(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL DEFAULT 0,
  item_code       TEXT,
  item_description TEXT,
  remarks         TEXT,
  qty             REAL    NOT NULL DEFAULT 1,
  unit_price      REAL    NOT NULL DEFAULT 0,
  amount          REAL    NOT NULL DEFAULT 0,
  group_tag       TEXT,
  created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE sales_entry_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        INTEGER NOT NULL REFERENCES sales_entries(id) ON DELETE CASCADE,
  paid_at         TEXT    NOT NULL,
  payment_method  TEXT    NOT NULL,
  amount          REAL    NOT NULL,
  account_sheet   TEXT,
  approval_code   TEXT,
  collected_by    TEXT,
  created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE sales_positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 20,    -- 10=Director, 20=Executive, 30=Sub
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sales_rep_brands (
  rep_id      INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  brand       TEXT NOT NULL,                   -- FK by name to project_brands.name
  PRIMARY KEY (rep_id, brand)
);

CREATE TABLE sales_rep_commission_tiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rep_id      INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  threshold   REAL NOT NULL DEFAULT 0,       -- sales threshold in RM (0 = floor)
  rate        REAL NOT NULL DEFAULT 0,       -- percent
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sales_reps (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL UNIQUE,    -- "SR-001" via nextSalesRepCode
  name                TEXT NOT NULL,
  phone               TEXT,
  email               TEXT,                     -- not unique; reps without logins may share / be missing
  position_id         INTEGER REFERENCES sales_positions(id) ON DELETE SET NULL,
  upline_id           INTEGER REFERENCES sales_reps(id) ON DELETE SET NULL,
  user_id             INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','inactive')),
  is_admin            INTEGER NOT NULL DEFAULT 0,
  commission_rate     REAL,                     -- per-rep override (% as 5.0 = 5%)
  commission_tier_id  INTEGER REFERENCES sales_commission_tiers(id) ON DELETE SET NULL,
  joined_on           TEXT,                     -- ISO date
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now')),
  archived_at         TEXT,
  archived_by         INTEGER
, nric TEXT, upline_secondary_id INTEGER
  REFERENCES sales_reps(id) ON DELETE SET NULL, commission_min_rate REAL NOT NULL DEFAULT 0);

CREATE TABLE sales_team_activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rep_id      INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,                   -- 'created' | 'position_change' | 'upline_change' | 'brand_change' | 'admin_toggle' | 'note' | 'status_change' | 'deleted'
  from_value  TEXT,
  to_value    TEXT,
  note        TEXT,
  user_id     INTEGER,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE state_warehouse_map (
  state TEXT PRIMARY KEY,
  warehouse TEXT NOT NULL,
  FOREIGN KEY (warehouse) REFERENCES warehouses(code)
);

CREATE TABLE stock_items (
  item_code        TEXT PRIMARY KEY,
  auto_key         TEXT,
  doc_key          TEXT,
  description      TEXT,
  desc2            TEXT,
  item_group       TEXT,
  item_type        TEXT,
  item_brand       TEXT,
  item_class       TEXT,
  item_category    TEXT,
  base_uom         TEXT,
  sales_uom        TEXT,
  purchase_uom     TEXT,
  main_supplier    TEXT,   -- creditor_code of the default/primary supplier
  is_active        INTEGER DEFAULT 1,
  is_sales_item    INTEGER,
  is_purchase_item INTEGER,
  lead_time        INTEGER,
  cost             REAL,
  price            REAL,
  tax_code         TEXT,
  purchase_tax_code TEXT,
  barcode2         TEXT,   -- UDF_Barcode2
  cost_code        TEXT,   -- UDF_CostCode
  last_modified    TEXT,
  raw              TEXT,   -- full JSON payload for forward-compat
  fetched_at       TEXT DEFAULT (datetime('now')),
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE suggestions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  body           TEXT,
  status         TEXT NOT NULL DEFAULT 'review'
                 CHECK (status IN ('review','approved','declined')),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TEXT,
  decline_reason TEXT,
  awarded_at     TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
, archived_at TEXT);

CREATE TABLE trip_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE TABLE trip_proposal_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL,
  warehouse TEXT NOT NULL,
  trip_date TEXT NOT NULL,
  suggested_lorry_id INTEGER,
  suggested_driver_user_id INTEGER,
  trip_type TEXT NOT NULL DEFAULT 'delivery',
  total_revenue REAL DEFAULT 0,
  total_distance_km REAL DEFAULT 0,
  stop_count INTEGER DEFAULT 0,
  is_outsourced INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,                  -- ordered doc_nos + reasoning
  FOREIGN KEY (proposal_id) REFERENCES trip_proposals(id) ON DELETE CASCADE
);

CREATE TABLE trip_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  generated_by INTEGER,
  horizon_days INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','confirmed','discarded')),
  summary_json TEXT,                           -- aggregate metrics
  notes TEXT,
  FOREIGN KEY (generated_by) REFERENCES users(id)
);

CREATE TABLE trip_stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  doc_no TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  stop_type TEXT NOT NULL DEFAULT 'delivery'
    CHECK(stop_type IN ('delivery','service','pickup','setup','dismantle')),
  dismantle_session TEXT                       -- morning|night, set at scheduling
    CHECK(dismantle_session IS NULL OR dismantle_session IN ('morning','night')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','arrived','delivered','failed')),
  arrived_at TEXT,
  completed_at TEXT,
  recipient_name TEXT,
  signature_r2_key TEXT,
  pod_photo_r2_key TEXT,
  failure_reason TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(trip_id, doc_no),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE TABLE trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_no TEXT UNIQUE NOT NULL,                -- TRIP/YYMM-NNN
  warehouse TEXT NOT NULL,
  trip_date TEXT NOT NULL,
  lorry_id INTEGER,
  driver_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK(status IN ('assigned','started','in_progress','completed','cancelled')),
  trip_type TEXT NOT NULL DEFAULT 'delivery'
    CHECK(trip_type IN ('delivery','setup','dismantle','sg','mixed')),
  is_outsourced INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual'        -- manual | proposal
    CHECK(source IN ('manual','proposal')),
  proposal_id INTEGER,
  started_at TEXT,
  completed_at TEXT,
  start_odometer REAL,
  end_odometer REAL,
  fuel_litres REAL,
  fuel_cost REAL,
  total_revenue REAL DEFAULT 0,
  total_distance_km REAL DEFAULT 0,
  stop_count INTEGER DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), helper_1_id INTEGER REFERENCES users(id), helper_2_id INTEGER REFERENCES users(id), helper_outsourced INTEGER DEFAULT 0, clock_in_at TEXT, clock_out_at TEXT, project_id INTEGER,
  FOREIGN KEY (warehouse) REFERENCES warehouses(code),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id),
  FOREIGN KEY (driver_user_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE user_brands (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand      TEXT    NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, brand)
);

CREATE TABLE user_streak_weeks (
  user_id        INTEGER NOT NULL REFERENCES users(id),
  iso_week       TEXT    NOT NULL,
  upvotes_count  INTEGER NOT NULL DEFAULT 0,
  qualified      INTEGER NOT NULL DEFAULT 0,
  computed_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, iso_week)
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT,
  role_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','disabled')),
  invited_by INTEGER,
  invited_at TEXT,
  joined_at TEXT,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), last_seen_at TEXT, user_type TEXT DEFAULT 'staff'
  CHECK(user_type IN ('staff','driver','helper','dispatcher','admin')), phone TEXT, ic_number TEXT, license_no TEXT, license_expiry TEXT, emergency_contact_name TEXT, emergency_contact_phone TEXT, base_salary REAL DEFAULT 0, trip_allowance_rate REAL DEFAULT 0, ot_rate REAL DEFAULT 0, max_continuous_hours REAL DEFAULT 8, manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL, department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL, points_balance   INTEGER NOT NULL DEFAULT 0, gifting_balance  INTEGER NOT NULL DEFAULT 0, gifting_reset_at TEXT, current_streak   INTEGER NOT NULL DEFAULT 0, profile_pic_r2_key TEXT,
  FOREIGN KEY (role_id) REFERENCES roles(id)
);

CREATE TABLE votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('innovation','suggestion')),
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (target_type, target_id, user_id)
);

CREATE TABLE warehouses (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  is_active INTEGER NOT NULL DEFAULT 1
);
