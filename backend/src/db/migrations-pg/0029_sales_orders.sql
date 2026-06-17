-- 0029_sales_orders.sql
--
-- SCM 1:1 clone slice 9: SALES ORDERS (the biggest slice). Verbatim clone of
-- 2990s's customers + mfg_sales_orders + mfg_sales_order_items + the SO audit /
-- payment tables (packages/db/src/schema.ts L513 / L1210 / L1379 / L1483-1572),
-- consolidated to their FINAL shape. Money is the integer *_centi column,
-- verbatim. The mfg_so_status enum (CONFIRMED..CANCELLED) + slip_state enum are
-- EXACTLY 2990s's names + values.
--
-- NO TABLE-NAME COLLISION: Houzs has `sales_orders` (AutoCount, DIFFERENT name)
-- and no `customers` / `mfg_sales_orders` / `mfg_sales_order_items` -> BARE
-- physical names (PLAN.md collision map). Real FKs:
--   mfg_sales_orders.customer_id        -> customers(id)              ON DELETE SET NULL
--   mfg_sales_order_items.doc_no        -> mfg_sales_orders(doc_no)   ON DELETE CASCADE
--   mfg_sales_order_items.warehouse_id  -> mfg_warehouses(id)         ON DELETE SET NULL
--   mfg_so_status_changes.doc_no        -> mfg_sales_orders(doc_no)   ON DELETE CASCADE
--   mfg_so_price_overrides.doc_no       -> mfg_sales_orders(doc_no)   ON DELETE CASCADE
--   mfg_so_price_overrides.item_id      -> mfg_sales_order_items(id)  ON DELETE CASCADE
--   mfg_so_audit_log.so_doc_no          -> mfg_sales_orders(doc_no)   ON DELETE CASCADE
--   mfg_sales_order_payments.so_doc_no  -> mfg_sales_orders(doc_no)   ON DELETE CASCADE
--
-- SEAM deviations vs 2990s (documented in schema.pg.ts on these tables):
--   - staff.id (uuid) refs (created_by / salesperson_id / changed_by /
--     approved_by / actor_id / collected_by) -> rule #4 -> Houzs users.id is a
--     serial INTEGER; SOFT ref (no FK), matching every prior slice.
--   - venue_id / hub_id / customer_po_id: 2990s FK -> venues / delivery_hubs.
--     Houzs has no such masters -> nullable column, NO FK (kept for fidelity).
--   - warehouse_id (per-line) -> mfg_warehouses (the cloned inventory table),
--     kept loose (SET NULL) so deleting a warehouse never blocks SO history.
--   - customer_id -> the cloned `customers` table (real FK).
--   - All furniture variant/pricing columns are KEPT (nullable) for fidelity;
--     the Houzs UI uses plain qty/price inputs (no configurator) per Strategy-2.
--
-- Runner contract (backend/scripts/pg-migrate.mjs): the file is split on /;\s*\n/
-- and each statement runs via tx.unsafe(...) inside ONE transaction. So:
--   - NO BEGIN; / COMMIT; (the runner already wraps in a transaction).
--   - every statement is idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
--   - each enum is guarded with a SINGLE-PHYSICAL-LINE DO block (no internal ;\n).
--   - currency_code enum already exists (migration 0024); mfg_so_status +
--     slip_state are new here.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mfg_so_status') THEN CREATE TYPE mfg_so_status AS ENUM ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED','INVOICED','CLOSED','ON_HOLD','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'slip_state') THEN CREATE TYPE slip_state AS ENUM ('none','pending','verified','flagged'); END IF; END $$;

CREATE TABLE IF NOT EXISTS customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  phone         text,
  email         text,
  customer_code text,
  address       text,
  address_line2 text,
  postcode      text,
  city          text,
  state         text,
  notes         text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);
CREATE UNIQUE INDEX IF NOT EXISTS customers_name_phone_unique ON customers (lower(trim(name)), phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_customer_code_unique ON customers (customer_code) WHERE customer_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS mfg_sales_orders (
  doc_no                          text PRIMARY KEY,
  transfer_to                     text,
  so_date                         date NOT NULL DEFAULT now(),
  branding                        text,
  debtor_code                     text,
  debtor_name                     text NOT NULL,
  agent                           text,
  sales_location                  text,
  ref                             text,
  po_doc_no                       text,
  venue                           text,
  venue_id                        uuid,
  address1                        text,
  address2                        text,
  address3                        text,
  address4                        text,
  phone                           text,
  mattress_sofa_centi             integer NOT NULL DEFAULT 0,
  bedframe_centi                  integer NOT NULL DEFAULT 0,
  accessories_centi               integer NOT NULL DEFAULT 0,
  others_centi                    integer NOT NULL DEFAULT 0,
  mattress_sofa_cost_centi        integer NOT NULL DEFAULT 0,
  bedframe_cost_centi             integer NOT NULL DEFAULT 0,
  accessories_cost_centi          integer NOT NULL DEFAULT 0,
  others_cost_centi               integer NOT NULL DEFAULT 0,
  service_centi                   integer NOT NULL DEFAULT 0,
  service_cost_centi              integer NOT NULL DEFAULT 0,
  local_total_centi               integer NOT NULL DEFAULT 0,
  balance_centi                   integer NOT NULL DEFAULT 0,
  total_cost_centi                integer NOT NULL DEFAULT 0,
  total_revenue_centi             integer NOT NULL DEFAULT 0,
  total_margin_centi              integer NOT NULL DEFAULT 0,
  margin_pct_basis                integer NOT NULL DEFAULT 0,
  line_count                      integer NOT NULL DEFAULT 0,
  fabric_tier_addon_centi         integer NOT NULL DEFAULT 0,
  delivery_fee_centi              integer NOT NULL DEFAULT 0,
  cross_category_source_doc_no    text,
  currency                        currency_code NOT NULL DEFAULT 'MYR',
  status                          mfg_so_status NOT NULL DEFAULT 'CONFIRMED',
  remark2                         text,
  remark3                         text,
  remark4                         text,
  note                            text,
  processing_date                 date,
  proceeded_at                    timestamptz,
  sales_exemption_expiry          date,
  customer_id                     uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_state                  text,
  customer_country                text,
  customer_po                     text,
  customer_po_id                  text,
  customer_po_date                date,
  customer_po_image_b64           text,
  customer_so_no                  text,
  hub_id                          uuid,
  hub_name                        text,
  customer_delivery_date          date,
  internal_expected_dd            date,
  linked_do_doc_no                text,
  ship_to_address                 text,
  bill_to_address                 text,
  install_to_address              text,
  subtotal_sen                    integer,
  overdue                         text,
  email                           text,
  customer_type                   text,
  salesperson_id                  integer,
  city                            text,
  postcode                        text,
  building_type                   text,
  emergency_contact_name          text,
  emergency_contact_phone         text,
  emergency_contact_relationship  text,
  target_date                     date,
  signature_b64                   text,
  slip_key                        text,
  slip_state                      slip_state NOT NULL DEFAULT 'none',
  payment_method                  text,
  installment_months              integer,
  merchant_provider               text,
  approval_code                   text,
  payment_date                    date,
  deposit_centi                   integer NOT NULL DEFAULT 0,
  paid_centi                      integer NOT NULL DEFAULT 0,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      integer,
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mso_date ON mfg_sales_orders (so_date);
CREATE INDEX IF NOT EXISTS idx_mso_debtor ON mfg_sales_orders (debtor_code);
CREATE INDEX IF NOT EXISTS idx_mso_status ON mfg_sales_orders (status);
CREATE INDEX IF NOT EXISTS idx_mso_branding ON mfg_sales_orders (branding);
CREATE INDEX IF NOT EXISTS idx_mso_customer ON mfg_sales_orders (customer_id);

CREATE TABLE IF NOT EXISTS mfg_sales_order_items (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no                         text NOT NULL REFERENCES mfg_sales_orders(doc_no) ON DELETE CASCADE,
  line_date                      date NOT NULL DEFAULT now(),
  debtor_code                    text,
  debtor_name                    text,
  agent                          text,
  item_group                     text NOT NULL,
  item_code                      text NOT NULL,
  description                    text,
  description2                   text,
  uom                            text NOT NULL DEFAULT 'UNIT',
  location                       text,
  warehouse_id                   uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  qty                            integer NOT NULL DEFAULT 1,
  unit_price_centi               integer NOT NULL DEFAULT 0,
  discount_centi                 integer NOT NULL DEFAULT 0,
  total_centi                    integer NOT NULL DEFAULT 0,
  tax_centi                      integer NOT NULL DEFAULT 0,
  total_inc_centi                integer NOT NULL DEFAULT 0,
  balance_centi                  integer NOT NULL DEFAULT 0,
  payment_status                 text NOT NULL DEFAULT 'Unchecked',
  venue                          text,
  branding                       text,
  remark                         text,
  cancelled                      boolean NOT NULL DEFAULT false,
  variants                       jsonb,
  unit_cost_centi                integer NOT NULL DEFAULT 0,
  line_cost_centi                integer NOT NULL DEFAULT 0,
  line_margin_centi              integer NOT NULL DEFAULT 0,
  gap_inches                     integer,
  divan_height_inches            integer,
  divan_price_sen                integer NOT NULL DEFAULT 0,
  leg_height_inches              integer,
  leg_price_sen                  integer NOT NULL DEFAULT 0,
  custom_specials                jsonb,
  line_suffix                    text,
  special_order_price_sen        integer NOT NULL DEFAULT 0,
  po_qty_picked                  integer NOT NULL DEFAULT 0,
  line_delivery_date             date,
  line_delivery_date_overridden  boolean NOT NULL DEFAULT false,
  photo_urls                     text[] NOT NULL DEFAULT '{}',
  stock_status                   text NOT NULL DEFAULT 'PENDING',
  stock_qty_ready                integer NOT NULL DEFAULT 0,
  allocated_batch_no             text,
  line_no                        integer,
  created_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mso_items_doc ON mfg_sales_order_items (doc_no);
CREATE INDEX IF NOT EXISTS idx_mso_items_item ON mfg_sales_order_items (item_code);
CREATE INDEX IF NOT EXISTS idx_mso_items_group ON mfg_sales_order_items (item_group);

CREATE TABLE IF NOT EXISTS mfg_so_status_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no       text NOT NULL REFERENCES mfg_sales_orders(doc_no) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  changed_by   integer,
  notes        text,
  auto_actions jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_so_status_changes_doc ON mfg_so_status_changes (doc_no);
CREATE INDEX IF NOT EXISTS idx_so_status_changes_at ON mfg_so_status_changes (created_at);

CREATE TABLE IF NOT EXISTS mfg_so_price_overrides (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no             text NOT NULL REFERENCES mfg_sales_orders(doc_no) ON DELETE CASCADE,
  item_id            uuid NOT NULL REFERENCES mfg_sales_order_items(id) ON DELETE CASCADE,
  item_code          text NOT NULL,
  original_price_sen integer NOT NULL,
  override_price_sen integer NOT NULL,
  reason             text,
  approved_by        integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_so_overrides_doc ON mfg_so_price_overrides (doc_no);
CREATE INDEX IF NOT EXISTS idx_so_overrides_item ON mfg_so_price_overrides (item_id);

CREATE TABLE IF NOT EXISTS mfg_so_audit_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_doc_no            text NOT NULL REFERENCES mfg_sales_orders(doc_no) ON DELETE CASCADE,
  action               text NOT NULL,
  actor_id             integer,
  actor_name_snapshot  text,
  field_changes        jsonb NOT NULL DEFAULT '[]',
  status_snapshot      text,
  source               text DEFAULT 'web',
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msoaudit_doc ON mfg_so_audit_log (so_doc_no);
CREATE INDEX IF NOT EXISTS idx_msoaudit_doc_at ON mfg_so_audit_log (so_doc_no, created_at);
CREATE INDEX IF NOT EXISTS idx_msoaudit_actor ON mfg_so_audit_log (actor_id);

CREATE TABLE IF NOT EXISTS mfg_sales_order_payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_doc_no          text NOT NULL REFERENCES mfg_sales_orders(doc_no) ON DELETE CASCADE,
  paid_at            date NOT NULL DEFAULT now(),
  method             text NOT NULL,
  merchant_provider  text,
  installment_months integer,
  online_type        text,
  approval_code      text,
  amount_centi       integer NOT NULL,
  account_sheet      text,
  slip_key           text,
  collected_by       integer,
  note               text,
  is_deposit         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         integer
);

CREATE INDEX IF NOT EXISTS idx_msop_doc ON mfg_sales_order_payments (so_doc_no);
CREATE INDEX IF NOT EXISTS idx_msop_paid_at ON mfg_sales_order_payments (paid_at);
