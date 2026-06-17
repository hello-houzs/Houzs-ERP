-- 0030_delivery_billing.sql
--
-- SCM 1:1 clone slice 10: DELIVERY ORDERS + SALES INVOICES + DELIVERY RETURNS
-- (order-to-cash downstream). Verbatim clone of 2990s delivery_orders /
-- delivery_order_items / sales_invoices / sales_invoice_items / delivery_returns
-- / delivery_return_items + the DO/SI payment ledgers. Columns reflect the LIVE
-- 2990s schema (the route field-set with migrations 0100/0101/0102/0165 folded
-- in — packages/db/src/schema.ts is the PRE-rebuild version and is NOT the source
-- of truth; the routes are). Money is the integer *_centi column, verbatim. The
-- do_status / sales_invoice_status / delivery_return_status enums are EXACTLY
-- 2990s's names + values (schema.ts L1201 / L1206 / L1714).
--
-- NO TABLE-NAME COLLISION: Houzs has no delivery_orders / sales_invoices /
-- delivery_returns (the existing AutoCount logistics route is /api/delivery, a
-- DIFFERENT table) -> BARE physical names (PLAN.md collision map). Real FKs:
--   delivery_orders.so_doc_no            -> mfg_sales_orders(doc_no)    ON DELETE SET NULL
--   delivery_orders.warehouse_id         -> mfg_warehouses(id)          ON DELETE SET NULL
--   delivery_order_items.delivery_order_id -> delivery_orders(id)       ON DELETE CASCADE
--   delivery_order_items.so_item_id      -> mfg_sales_order_items(id)   ON DELETE SET NULL
--   delivery_order_payments.delivery_order_id -> delivery_orders(id)    ON DELETE CASCADE
--   sales_invoices.so_doc_no             -> mfg_sales_orders(doc_no)    ON DELETE SET NULL
--   sales_invoices.delivery_order_id     -> delivery_orders(id)         ON DELETE SET NULL
--   sales_invoice_items.sales_invoice_id -> sales_invoices(id)          ON DELETE CASCADE
--   sales_invoice_items.so_item_id       -> mfg_sales_order_items(id)   ON DELETE SET NULL
--   sales_invoice_items.do_item_id       -> delivery_order_items(id)    ON DELETE SET NULL
--   sales_invoice_payments.sales_invoice_id -> sales_invoices(id)       ON DELETE CASCADE
--   delivery_returns.delivery_order_id   -> delivery_orders(id)         ON DELETE SET NULL
--   delivery_returns.sales_invoice_id    -> sales_invoices(id)          ON DELETE SET NULL
--   delivery_returns.warehouse_id        -> mfg_warehouses(id)          ON DELETE SET NULL
--   delivery_return_items.delivery_return_id -> delivery_returns(id)    ON DELETE CASCADE
--   delivery_return_items.do_item_id     -> delivery_order_items(id)    ON DELETE SET NULL
--
-- SEAM deviations vs 2990s (documented in schema.pg.ts on these tables):
--   - staff.id (uuid) refs (created_by / salesperson_id / collected_by) ->
--     rule #4 -> Houzs users.id is a serial INTEGER; SOFT ref (no FK), matching
--     every prior slice.
--   - driver_id / venue_id: 2990s FK -> drivers / venues. Houzs has no such
--     masters -> nullable uuid column, NO FK (kept for fidelity).
--   - warehouse_id -> mfg_warehouses (the cloned inventory table), SET NULL.
--   - All furniture variant columns are KEPT (nullable) for fidelity; the Houzs
--     UI uses plain qty/price inputs (no configurator) per Strategy-2.
--   - GL/AR posting on the SI is OUT OF SCM-clone scope (Houzs GL differs); the
--     SI doc + payment-status are functional, no journal_entries written.
--
-- Runner contract (backend/scripts/pg-migrate.mjs): the file is split on /;\s*\n/
-- and each statement runs via tx.unsafe(...) inside ONE transaction. So:
--   - NO BEGIN; / COMMIT; (the runner already wraps in a transaction).
--   - every statement is idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
--   - each enum is guarded with a SINGLE-PHYSICAL-LINE DO block (no internal ;\n).
--   - currency_code enum already exists (migration 0024).

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'do_status') THEN CREATE TYPE do_status AS ENUM ('LOADED','DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sales_invoice_status') THEN CREATE TYPE sales_invoice_status AS ENUM ('SENT','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'delivery_return_status') THEN CREATE TYPE delivery_return_status AS ENUM ('PENDING','RECEIVED','INSPECTED','REFUNDED','CREDIT_NOTED','REJECTED','CANCELLED'); END IF; END $$;

CREATE TABLE IF NOT EXISTS delivery_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  do_number             text NOT NULL UNIQUE,
  so_doc_no             text REFERENCES mfg_sales_orders(doc_no) ON DELETE SET NULL,
  debtor_code           text,
  debtor_name           text NOT NULL,
  do_date               date NOT NULL DEFAULT now(),
  expected_delivery_at  date,
  customer_delivery_date date,
  signed_at             timestamptz,
  delivered_at          timestamptz,
  dispatched_at         timestamptz,
  driver_id             uuid,
  driver_name           text,
  vehicle               text,
  m3_total_milli        integer NOT NULL DEFAULT 0,
  address1              text,
  address2              text,
  city                  text,
  state                 text,
  postcode              text,
  phone                 text,
  salesperson_id        integer,
  agent                 text,
  email                 text,
  customer_type         text,
  building_type         text,
  branding              text,
  venue                 text,
  venue_id              uuid,
  ref                   text,
  customer_so_no        text,
  po_doc_no             text,
  sales_location        text,
  customer_state        text,
  customer_country      text,
  note                  text,
  emergency_contact_name         text,
  emergency_contact_phone        text,
  emergency_contact_relationship text,
  mattress_sofa_centi        integer NOT NULL DEFAULT 0,
  bedframe_centi             integer NOT NULL DEFAULT 0,
  accessories_centi          integer NOT NULL DEFAULT 0,
  others_centi               integer NOT NULL DEFAULT 0,
  service_centi              integer NOT NULL DEFAULT 0,
  mattress_sofa_cost_centi   integer NOT NULL DEFAULT 0,
  bedframe_cost_centi        integer NOT NULL DEFAULT 0,
  accessories_cost_centi     integer NOT NULL DEFAULT 0,
  others_cost_centi          integer NOT NULL DEFAULT 0,
  service_cost_centi         integer NOT NULL DEFAULT 0,
  local_total_centi          integer NOT NULL DEFAULT 0,
  total_cost_centi           integer NOT NULL DEFAULT 0,
  total_margin_centi         integer NOT NULL DEFAULT 0,
  margin_pct_basis           integer NOT NULL DEFAULT 0,
  line_count                 integer NOT NULL DEFAULT 0,
  currency              currency_code NOT NULL DEFAULT 'MYR',
  warehouse_id          uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  pod_r2_key            text,
  signature_data        text,
  status                do_status NOT NULL DEFAULT 'LOADED',
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_do_so ON delivery_orders(so_doc_no);

CREATE INDEX IF NOT EXISTS idx_do_status ON delivery_orders(status);

CREATE INDEX IF NOT EXISTS idx_do_date ON delivery_orders(do_date);

CREATE TABLE IF NOT EXISTS delivery_order_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_order_id    uuid NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  so_item_id           uuid REFERENCES mfg_sales_order_items(id) ON DELETE SET NULL,
  item_code            text NOT NULL,
  item_group           text,
  description          text,
  description2         text,
  uom                  text NOT NULL DEFAULT 'UNIT',
  qty                  integer NOT NULL,
  m3_milli             integer NOT NULL DEFAULT 0,
  unit_price_centi     integer NOT NULL DEFAULT 0,
  discount_centi       integer NOT NULL DEFAULT 0,
  line_total_centi     integer NOT NULL DEFAULT 0,
  unit_cost_centi      integer NOT NULL DEFAULT 0,
  line_cost_centi      integer NOT NULL DEFAULT 0,
  line_margin_centi    integer NOT NULL DEFAULT 0,
  notes                text,
  gap_inches              integer,
  divan_height_inches     integer,
  divan_price_sen         integer NOT NULL DEFAULT 0,
  leg_height_inches       integer,
  leg_price_sen           integer NOT NULL DEFAULT 0,
  custom_specials         jsonb,
  line_suffix             text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants                jsonb,
  line_delivery_date            date,
  line_delivery_date_overridden boolean NOT NULL DEFAULT false,
  line_no              integer,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_do_items_do ON delivery_order_items(delivery_order_id);

CREATE INDEX IF NOT EXISTS idx_do_items_so_item ON delivery_order_items(so_item_id);

CREATE TABLE IF NOT EXISTS delivery_order_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_order_id   uuid NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  paid_at             date NOT NULL DEFAULT now(),
  method              text NOT NULL,
  merchant_provider   text,
  installment_months  integer,
  online_type         text,
  approval_code       text,
  amount_centi        integer NOT NULL,
  account_sheet       text,
  collected_by        integer,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          integer
);

CREATE INDEX IF NOT EXISTS idx_dop_do ON delivery_order_payments(delivery_order_id);

CREATE TABLE IF NOT EXISTS sales_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number       text NOT NULL UNIQUE,
  so_doc_no            text REFERENCES mfg_sales_orders(doc_no) ON DELETE SET NULL,
  delivery_order_id    uuid REFERENCES delivery_orders(id) ON DELETE SET NULL,
  debtor_code          text,
  debtor_name          text NOT NULL,
  invoice_date         date NOT NULL DEFAULT now(),
  due_date             date,
  customer_delivery_date date,
  currency             currency_code NOT NULL DEFAULT 'MYR',
  subtotal_centi       integer NOT NULL DEFAULT 0,
  discount_centi       integer NOT NULL DEFAULT 0,
  tax_centi            integer NOT NULL DEFAULT 0,
  total_centi          integer NOT NULL DEFAULT 0,
  paid_centi           integer NOT NULL DEFAULT 0,
  salesperson_id       integer,
  agent                text,
  email                text,
  customer_type        text,
  building_type        text,
  branding             text,
  venue                text,
  venue_id             uuid,
  ref                  text,
  customer_so_no       text,
  po_doc_no            text,
  sales_location       text,
  customer_state       text,
  customer_country     text,
  note                 text,
  address1             text,
  address2             text,
  city                 text,
  state                text,
  postcode             text,
  phone                text,
  emergency_contact_name         text,
  emergency_contact_phone        text,
  emergency_contact_relationship text,
  mattress_sofa_centi        integer NOT NULL DEFAULT 0,
  bedframe_centi             integer NOT NULL DEFAULT 0,
  accessories_centi          integer NOT NULL DEFAULT 0,
  others_centi               integer NOT NULL DEFAULT 0,
  service_centi              integer NOT NULL DEFAULT 0,
  mattress_sofa_cost_centi   integer NOT NULL DEFAULT 0,
  bedframe_cost_centi        integer NOT NULL DEFAULT 0,
  accessories_cost_centi     integer NOT NULL DEFAULT 0,
  others_cost_centi          integer NOT NULL DEFAULT 0,
  service_cost_centi         integer NOT NULL DEFAULT 0,
  local_total_centi          integer NOT NULL DEFAULT 0,
  total_cost_centi           integer NOT NULL DEFAULT 0,
  total_margin_centi         integer NOT NULL DEFAULT 0,
  margin_pct_basis           integer NOT NULL DEFAULT 0,
  line_count                 integer NOT NULL DEFAULT 0,
  status               sales_invoice_status NOT NULL DEFAULT 'SENT',
  notes                text,
  sent_at              timestamptz,
  paid_at              timestamptz,
  confirmed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           integer,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_si_so ON sales_invoices(so_doc_no);

CREATE INDEX IF NOT EXISTS idx_si_do ON sales_invoices(delivery_order_id);

CREATE INDEX IF NOT EXISTS idx_si_debtor ON sales_invoices(debtor_code);

CREATE INDEX IF NOT EXISTS idx_si_status ON sales_invoices(status);

CREATE INDEX IF NOT EXISTS idx_si_due_date ON sales_invoices(due_date);

CREATE TABLE IF NOT EXISTS sales_invoice_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_invoice_id     uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  so_item_id           uuid REFERENCES mfg_sales_order_items(id) ON DELETE SET NULL,
  do_item_id           uuid REFERENCES delivery_order_items(id) ON DELETE SET NULL,
  item_code            text NOT NULL,
  item_group           text,
  description          text,
  description2         text,
  uom                  text NOT NULL DEFAULT 'UNIT',
  qty                  integer NOT NULL,
  unit_price_centi     integer NOT NULL DEFAULT 0,
  discount_centi       integer NOT NULL DEFAULT 0,
  tax_centi            integer NOT NULL DEFAULT 0,
  line_total_centi     integer NOT NULL DEFAULT 0,
  unit_cost_centi      integer NOT NULL DEFAULT 0,
  line_cost_centi      integer NOT NULL DEFAULT 0,
  line_margin_centi    integer NOT NULL DEFAULT 0,
  notes                text,
  gap_inches              integer,
  divan_height_inches     integer,
  divan_price_sen         integer NOT NULL DEFAULT 0,
  leg_height_inches       integer,
  leg_price_sen           integer NOT NULL DEFAULT 0,
  custom_specials         jsonb,
  line_suffix             text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants                jsonb,
  line_no              integer,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_si_items_si ON sales_invoice_items(sales_invoice_id);

CREATE INDEX IF NOT EXISTS idx_si_items_do_item ON sales_invoice_items(do_item_id);

CREATE TABLE IF NOT EXISTS sales_invoice_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_invoice_id    uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  paid_at             date NOT NULL DEFAULT now(),
  method              text NOT NULL,
  merchant_provider   text,
  installment_months  integer,
  online_type         text,
  approval_code       text,
  amount_centi        integer NOT NULL,
  account_sheet       text,
  collected_by        integer,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          integer
);

CREATE INDEX IF NOT EXISTS idx_sip_si ON sales_invoice_payments(sales_invoice_id);

CREATE TABLE IF NOT EXISTS delivery_returns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number        text NOT NULL UNIQUE,
  do_doc_no            text,
  delivery_order_id    uuid REFERENCES delivery_orders(id) ON DELETE SET NULL,
  sales_invoice_id     uuid REFERENCES sales_invoices(id) ON DELETE SET NULL,
  debtor_code          text,
  debtor_name          text NOT NULL,
  return_date          date NOT NULL DEFAULT now(),
  reason               text,
  status               delivery_return_status NOT NULL DEFAULT 'PENDING',
  received_at          timestamptz,
  inspected_at         timestamptz,
  refunded_at          timestamptz,
  refund_centi         integer NOT NULL DEFAULT 0,
  inspection_notes     text,
  salesperson_id       integer,
  agent                text,
  email                text,
  customer_type        text,
  building_type        text,
  branding             text,
  venue                text,
  venue_id             uuid,
  ref                  text,
  customer_so_no       text,
  sales_location       text,
  customer_state       text,
  customer_country     text,
  note                 text,
  address1             text,
  address2             text,
  city                 text,
  state                text,
  postcode             text,
  phone                text,
  emergency_contact_name         text,
  emergency_contact_phone        text,
  emergency_contact_relationship text,
  mattress_sofa_centi        integer NOT NULL DEFAULT 0,
  bedframe_centi             integer NOT NULL DEFAULT 0,
  accessories_centi          integer NOT NULL DEFAULT 0,
  others_centi               integer NOT NULL DEFAULT 0,
  mattress_sofa_cost_centi   integer NOT NULL DEFAULT 0,
  bedframe_cost_centi        integer NOT NULL DEFAULT 0,
  accessories_cost_centi     integer NOT NULL DEFAULT 0,
  others_cost_centi          integer NOT NULL DEFAULT 0,
  local_total_centi          integer NOT NULL DEFAULT 0,
  total_cost_centi           integer NOT NULL DEFAULT 0,
  total_margin_centi         integer NOT NULL DEFAULT 0,
  margin_pct_basis           integer NOT NULL DEFAULT 0,
  line_count                 integer NOT NULL DEFAULT 0,
  currency             currency_code NOT NULL DEFAULT 'MYR',
  warehouse_id         uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           integer,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dr_do ON delivery_returns(delivery_order_id);

CREATE INDEX IF NOT EXISTS idx_dr_status ON delivery_returns(status);

CREATE INDEX IF NOT EXISTS idx_dr_debtor ON delivery_returns(debtor_code);

CREATE TABLE IF NOT EXISTS delivery_return_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_return_id   uuid NOT NULL REFERENCES delivery_returns(id) ON DELETE CASCADE,
  do_item_id           uuid REFERENCES delivery_order_items(id) ON DELETE SET NULL,
  item_code            text NOT NULL,
  item_group           text,
  description          text,
  description2         text,
  uom                  text NOT NULL DEFAULT 'UNIT',
  qty_returned         integer NOT NULL,
  condition            text,
  unit_price_centi     integer NOT NULL DEFAULT 0,
  discount_centi       integer NOT NULL DEFAULT 0,
  line_total_centi     integer NOT NULL DEFAULT 0,
  unit_cost_centi      integer NOT NULL DEFAULT 0,
  line_cost_centi      integer NOT NULL DEFAULT 0,
  line_margin_centi    integer NOT NULL DEFAULT 0,
  refund_centi         integer NOT NULL DEFAULT 0,
  variants             jsonb,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dr_items_dr ON delivery_return_items(delivery_return_id);

CREATE INDEX IF NOT EXISTS idx_dr_items_do_item ON delivery_return_items(do_item_id);
