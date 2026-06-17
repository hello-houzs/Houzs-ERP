-- 0031_consignment.sql
--
-- SCM 1:1 clone slice 11 (#67): CONSIGNMENT — the last document-flow group.
-- Verbatim clone of 2990s's two consignment pipelines:
--
--   SALES consignment (goods OUT to a consignee/showroom, settled later):
--     consignment_sales_orders / _items / _payments      (clone mfg_sales_orders)
--     consignment_delivery_orders / _items / _payments   (Consignment Note,
--                                                          clone delivery_orders)
--     consignment_delivery_returns / _items              (Consignment Return,
--                                                          clone delivery_returns)
--     consignment_so_audit_log                           (clone mfg_so_audit_log)
--
--   PURCHASE consignment (supplier's goods held on consignment at MY warehouse):
--     purchase_consignment_orders / _items     (clone mfg_purchase_orders)
--     purchase_consignment_receives / _items   (clone grns)
--     purchase_consignment_returns / _items    (clone purchase_returns)
--
-- NO TABLE-NAME COLLISION (Houzs has none of these) -> BARE physical names
-- (PLAN.md collision map). 2990s's schema.ts is STALE for these tables — the
-- column sets below come from the LIVE ROUTES (consignment-*.ts +
-- purchase-consignment-*.ts, migrations 0153/0154/0056/0057 folded in), the
-- documented "ledger != schema.ts" gap (same as the DO/SI/DR slice).
--
-- Real FKs (the seams):
--   consignment_sales_orders.customer_id              -> customers(id)            SET NULL
--   consignment_sales_order_items.doc_no              -> consignment_sales_orders(doc_no) CASCADE
--   consignment_sales_order_items.warehouse_id        -> mfg_warehouses(id)       SET NULL
--   consignment_sales_order_payments.so_doc_no        -> consignment_sales_orders(doc_no) CASCADE
--   consignment_so_audit_log.so_doc_no                -> consignment_sales_orders(doc_no) CASCADE
--   consignment_delivery_orders.consignment_so_doc_no -> consignment_sales_orders(doc_no) SET NULL
--   consignment_delivery_orders.warehouse_id          -> mfg_warehouses(id)       SET NULL
--   consignment_delivery_order_items.consignment_delivery_order_id -> consignment_delivery_orders(id) CASCADE
--   consignment_delivery_order_items.consignment_so_item_id        -> consignment_sales_order_items(id) SET NULL
--   consignment_delivery_order_payments.consignment_delivery_order_id -> consignment_delivery_orders(id) CASCADE
--   consignment_delivery_returns.consignment_do_id    -> consignment_delivery_orders(id) SET NULL
--   consignment_delivery_returns.warehouse_id         -> mfg_warehouses(id)       SET NULL
--   consignment_delivery_return_items.consignment_delivery_return_id -> consignment_delivery_returns(id) CASCADE
--   consignment_delivery_return_items.consignment_do_item_id         -> consignment_delivery_order_items(id) SET NULL
--   purchase_consignment_orders.supplier_id           -> suppliers(id)            RESTRICT
--   purchase_consignment_orders.purchase_location_id  -> mfg_warehouses(id)       SET NULL
--   purchase_consignment_order_items.purchase_consignment_order_id -> purchase_consignment_orders(id) CASCADE
--   purchase_consignment_order_items.warehouse_id     -> mfg_warehouses(id)       SET NULL
--   purchase_consignment_receives.purchase_consignment_order_id -> purchase_consignment_orders(id) SET NULL
--   purchase_consignment_receives.supplier_id         -> suppliers(id)            RESTRICT
--   purchase_consignment_receives.warehouse_id        -> mfg_warehouses(id)       SET NULL
--   purchase_consignment_receive_items.pc_receive_id  -> purchase_consignment_receives(id) CASCADE
--   purchase_consignment_receive_items.pc_order_item_id -> purchase_consignment_order_items(id) SET NULL
--   purchase_consignment_receive_items.rack_id        -> warehouse_racks(id)      SET NULL
--   purchase_consignment_returns.pc_order_id          -> purchase_consignment_orders(id) SET NULL
--   purchase_consignment_returns.pc_receive_id        -> purchase_consignment_receives(id) SET NULL
--   purchase_consignment_returns.supplier_id          -> suppliers(id)            RESTRICT
--   purchase_consignment_return_items.purchase_consignment_return_id -> purchase_consignment_returns(id) CASCADE
--   purchase_consignment_return_items.pc_receive_item_id -> purchase_consignment_receive_items(id) SET NULL
--
-- SEAM deviations (documented in schema.pg.ts on these tables):
--   - staff.id (uuid) refs (created_by / salesperson_id / collected_by /
--     actor_id) -> rule #4 -> Houzs users.id is a serial INTEGER; SOFT ref (no FK).
--   - venue_id / hub_id / customer_po_id / driver_id: 2990s FK -> venues /
--     delivery_hubs / drivers. Houzs has no such masters -> nullable uuid, NO FK.
--   - Inventory wiring lives in the routes via lib/inventory-movements
--     (source_doc_types CS_DO/CS_DR/PC_RECEIVE/PC_RETURN + STOCK_TRANSFER deltas);
--     no DB objects needed here (the FIFO trigger + ledger exist from 0026).
--   - GL/accounting (AP/AR posting) is OUT OF SCOPE (no 2990s consignment route
--     posts to a GL).
--
-- Runner contract (backend/scripts/pg-migrate.mjs): file split on /;\s*\n/, each
-- statement runs via tx.unsafe(...) inside ONE transaction. So: NO BEGIN/COMMIT;
-- every statement idempotent (IF NOT EXISTS); each enum guarded with a SINGLE
-- physical-line DO block. currency_code enum + material_kind enum already exist
-- (migrations 0024 / 0025).

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consignment_so_status') THEN CREATE TYPE consignment_so_status AS ENUM ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED','INVOICED','CLOSED','ON_HOLD','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consignment_do_status') THEN CREATE TYPE consignment_do_status AS ENUM ('LOADED','DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consignment_dr_status') THEN CREATE TYPE consignment_dr_status AS ENUM ('PENDING','RECEIVED','INSPECTED','REFUNDED','CREDIT_NOTED','REJECTED','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_consignment_order_status') THEN CREATE TYPE purchase_consignment_order_status AS ENUM ('SUBMITTED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_consignment_receive_status') THEN CREATE TYPE purchase_consignment_receive_status AS ENUM ('POSTED','CLOSED','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_consignment_return_status') THEN CREATE TYPE purchase_consignment_return_status AS ENUM ('POSTED','COMPLETED','CANCELLED'); END IF; END $$;

-- ── SALES consignment ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS consignment_sales_orders (
  doc_no                text PRIMARY KEY,
  transfer_to           text,
  so_date               date NOT NULL DEFAULT now(),
  branding              text,
  debtor_code           text,
  debtor_name           text NOT NULL,
  agent                 text,
  sales_location        text,
  ref                   text,
  po_doc_no             text,
  venue                 text,
  venue_id              uuid,
  address1              text,
  address2              text,
  address3              text,
  address4              text,
  phone                 text,
  mattress_sofa_centi   integer NOT NULL DEFAULT 0,
  bedframe_centi        integer NOT NULL DEFAULT 0,
  accessories_centi     integer NOT NULL DEFAULT 0,
  others_centi          integer NOT NULL DEFAULT 0,
  mattress_sofa_cost_centi integer NOT NULL DEFAULT 0,
  bedframe_cost_centi   integer NOT NULL DEFAULT 0,
  accessories_cost_centi integer NOT NULL DEFAULT 0,
  others_cost_centi     integer NOT NULL DEFAULT 0,
  local_total_centi     integer NOT NULL DEFAULT 0,
  balance_centi         integer NOT NULL DEFAULT 0,
  total_cost_centi      integer NOT NULL DEFAULT 0,
  total_revenue_centi   integer NOT NULL DEFAULT 0,
  total_margin_centi    integer NOT NULL DEFAULT 0,
  margin_pct_basis      integer NOT NULL DEFAULT 0,
  line_count            integer NOT NULL DEFAULT 0,
  subtotal_sen          integer,
  overdue               text,
  currency              currency_code NOT NULL DEFAULT 'MYR',
  status                consignment_so_status NOT NULL DEFAULT 'CONFIRMED',
  remark2               text,
  remark3               text,
  remark4               text,
  note                  text,
  processing_date       date,
  sales_exemption_expiry date,
  customer_id           uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_state        text,
  customer_country      text,
  customer_po           text,
  customer_po_id        text,
  customer_po_date      date,
  customer_po_image_b64 text,
  customer_so_no        text,
  hub_id                uuid,
  hub_name              text,
  customer_delivery_date date,
  internal_expected_dd  date,
  linked_do_doc_no      text,
  ship_to_address       text,
  bill_to_address       text,
  install_to_address    text,
  email                 text,
  customer_type         text,
  salesperson_id        integer,
  city                  text,
  postcode              text,
  building_type         text,
  emergency_contact_name text,
  emergency_contact_phone text,
  emergency_contact_relationship text,
  target_date           date,
  signature_b64         text,
  payment_method        text,
  installment_months    integer,
  merchant_provider     text,
  approval_code         text,
  payment_date          date,
  deposit_centi         integer NOT NULL DEFAULT 0,
  paid_centi            integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cso_date ON consignment_sales_orders (so_date);
CREATE INDEX IF NOT EXISTS idx_cso_status ON consignment_sales_orders (status);
CREATE INDEX IF NOT EXISTS idx_cso_customer ON consignment_sales_orders (customer_id);

CREATE TABLE IF NOT EXISTS consignment_sales_order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no                text NOT NULL REFERENCES consignment_sales_orders(doc_no) ON DELETE CASCADE,
  line_date             date NOT NULL DEFAULT now(),
  debtor_code           text,
  debtor_name           text,
  agent                 text,
  item_group            text,
  item_code             text NOT NULL,
  description           text,
  description2          text,
  uom                   text NOT NULL DEFAULT 'UNIT',
  location              text,
  warehouse_id          uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  qty                   integer NOT NULL DEFAULT 1,
  unit_price_centi      integer NOT NULL DEFAULT 0,
  discount_centi        integer NOT NULL DEFAULT 0,
  total_centi           integer NOT NULL DEFAULT 0,
  tax_centi             integer NOT NULL DEFAULT 0,
  total_inc_centi       integer NOT NULL DEFAULT 0,
  balance_centi         integer NOT NULL DEFAULT 0,
  payment_status        text NOT NULL DEFAULT 'Unchecked',
  venue                 text,
  branding              text,
  remark                text,
  cancelled             boolean NOT NULL DEFAULT false,
  variants              jsonb,
  unit_cost_centi       integer NOT NULL DEFAULT 0,
  line_cost_centi       integer NOT NULL DEFAULT 0,
  line_margin_centi     integer NOT NULL DEFAULT 0,
  divan_price_sen       integer NOT NULL DEFAULT 0,
  leg_price_sen         integer NOT NULL DEFAULT 0,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  custom_specials       jsonb,
  line_delivery_date    date,
  line_delivery_date_overridden boolean NOT NULL DEFAULT false,
  photo_urls            text[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cso_items_doc ON consignment_sales_order_items (doc_no);
CREATE INDEX IF NOT EXISTS idx_cso_items_item ON consignment_sales_order_items (item_code);

CREATE TABLE IF NOT EXISTS consignment_sales_order_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_doc_no             text NOT NULL REFERENCES consignment_sales_orders(doc_no) ON DELETE CASCADE,
  paid_at               date NOT NULL DEFAULT now(),
  method                text NOT NULL,
  merchant_provider     text,
  installment_months    integer,
  online_type           text,
  approval_code         text,
  amount_centi          integer NOT NULL,
  account_sheet         text,
  collected_by          integer,
  note                  text,
  is_deposit            boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer
);

CREATE INDEX IF NOT EXISTS idx_csop_doc ON consignment_sales_order_payments (so_doc_no);

CREATE TABLE IF NOT EXISTS consignment_so_audit_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_doc_no             text NOT NULL REFERENCES consignment_sales_orders(doc_no) ON DELETE CASCADE,
  action                text NOT NULL,
  actor_id              integer,
  actor_name_snapshot   text,
  field_changes         jsonb NOT NULL DEFAULT '[]',
  status_snapshot       text,
  source                text DEFAULT 'web',
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_csoaudit_doc ON consignment_so_audit_log (so_doc_no);
CREATE INDEX IF NOT EXISTS idx_csoaudit_doc_at ON consignment_so_audit_log (so_doc_no, created_at);

CREATE TABLE IF NOT EXISTS consignment_delivery_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  do_number             text NOT NULL UNIQUE,
  consignment_so_doc_no text REFERENCES consignment_sales_orders(doc_no) ON DELETE SET NULL,
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
  emergency_contact_name text,
  emergency_contact_phone text,
  emergency_contact_relationship text,
  mattress_sofa_centi   integer NOT NULL DEFAULT 0,
  bedframe_centi        integer NOT NULL DEFAULT 0,
  accessories_centi     integer NOT NULL DEFAULT 0,
  others_centi          integer NOT NULL DEFAULT 0,
  mattress_sofa_cost_centi integer NOT NULL DEFAULT 0,
  bedframe_cost_centi   integer NOT NULL DEFAULT 0,
  accessories_cost_centi integer NOT NULL DEFAULT 0,
  others_cost_centi     integer NOT NULL DEFAULT 0,
  local_total_centi     integer NOT NULL DEFAULT 0,
  total_cost_centi      integer NOT NULL DEFAULT 0,
  total_margin_centi    integer NOT NULL DEFAULT 0,
  margin_pct_basis      integer NOT NULL DEFAULT 0,
  line_count            integer NOT NULL DEFAULT 0,
  currency              currency_code NOT NULL DEFAULT 'MYR',
  warehouse_id          uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  pod_r2_key            text,
  signature_data        text,
  status                consignment_do_status NOT NULL DEFAULT 'LOADED',
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cdo_so ON consignment_delivery_orders (consignment_so_doc_no);
CREATE INDEX IF NOT EXISTS idx_cdo_status ON consignment_delivery_orders (status);
CREATE INDEX IF NOT EXISTS idx_cdo_date ON consignment_delivery_orders (do_date);

CREATE TABLE IF NOT EXISTS consignment_delivery_order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_delivery_order_id uuid NOT NULL REFERENCES consignment_delivery_orders(id) ON DELETE CASCADE,
  consignment_so_item_id uuid REFERENCES consignment_sales_order_items(id) ON DELETE SET NULL,
  item_code             text NOT NULL,
  item_group            text,
  description           text,
  description2          text,
  uom                   text NOT NULL DEFAULT 'UNIT',
  qty                   integer NOT NULL,
  m3_milli              integer NOT NULL DEFAULT 0,
  unit_price_centi      integer NOT NULL DEFAULT 0,
  discount_centi        integer NOT NULL DEFAULT 0,
  line_total_centi      integer NOT NULL DEFAULT 0,
  unit_cost_centi       integer NOT NULL DEFAULT 0,
  line_cost_centi       integer NOT NULL DEFAULT 0,
  line_margin_centi     integer NOT NULL DEFAULT 0,
  variants              jsonb,
  notes                 text,
  line_delivery_date    date,
  line_delivery_date_overridden boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cdo_items_do ON consignment_delivery_order_items (consignment_delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_cdo_items_so_item ON consignment_delivery_order_items (consignment_so_item_id);

CREATE TABLE IF NOT EXISTS consignment_delivery_order_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_delivery_order_id uuid NOT NULL REFERENCES consignment_delivery_orders(id) ON DELETE CASCADE,
  paid_at               date NOT NULL DEFAULT now(),
  method                text NOT NULL,
  merchant_provider     text,
  installment_months    integer,
  online_type           text,
  approval_code         text,
  amount_centi          integer NOT NULL,
  account_sheet         text,
  collected_by          integer,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer
);

CREATE INDEX IF NOT EXISTS idx_cdop_do ON consignment_delivery_order_payments (consignment_delivery_order_id);

CREATE TABLE IF NOT EXISTS consignment_delivery_returns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number         text NOT NULL UNIQUE,
  do_number             text,
  consignment_do_id     uuid REFERENCES consignment_delivery_orders(id) ON DELETE SET NULL,
  debtor_code           text,
  debtor_name           text NOT NULL,
  return_date           date NOT NULL DEFAULT now(),
  reason                text,
  status                consignment_dr_status NOT NULL DEFAULT 'PENDING',
  received_at           timestamptz,
  inspected_at          timestamptz,
  refunded_at           timestamptz,
  refund_centi          integer NOT NULL DEFAULT 0,
  inspection_notes      text,
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
  sales_location        text,
  customer_state        text,
  customer_country      text,
  note                  text,
  address1              text,
  address2              text,
  city                  text,
  state                 text,
  postcode              text,
  phone                 text,
  emergency_contact_name text,
  emergency_contact_phone text,
  emergency_contact_relationship text,
  mattress_sofa_centi   integer NOT NULL DEFAULT 0,
  bedframe_centi        integer NOT NULL DEFAULT 0,
  accessories_centi     integer NOT NULL DEFAULT 0,
  others_centi          integer NOT NULL DEFAULT 0,
  mattress_sofa_cost_centi integer NOT NULL DEFAULT 0,
  bedframe_cost_centi   integer NOT NULL DEFAULT 0,
  accessories_cost_centi integer NOT NULL DEFAULT 0,
  others_cost_centi     integer NOT NULL DEFAULT 0,
  local_total_centi     integer NOT NULL DEFAULT 0,
  total_cost_centi      integer NOT NULL DEFAULT 0,
  total_margin_centi    integer NOT NULL DEFAULT 0,
  margin_pct_basis      integer NOT NULL DEFAULT 0,
  line_count            integer NOT NULL DEFAULT 0,
  currency              currency_code NOT NULL DEFAULT 'MYR',
  warehouse_id          uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cdr_do ON consignment_delivery_returns (consignment_do_id);
CREATE INDEX IF NOT EXISTS idx_cdr_status ON consignment_delivery_returns (status);
CREATE INDEX IF NOT EXISTS idx_cdr_debtor ON consignment_delivery_returns (debtor_code);

CREATE TABLE IF NOT EXISTS consignment_delivery_return_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_delivery_return_id uuid NOT NULL REFERENCES consignment_delivery_returns(id) ON DELETE CASCADE,
  consignment_do_item_id uuid REFERENCES consignment_delivery_order_items(id) ON DELETE SET NULL,
  item_code             text NOT NULL,
  item_group            text,
  description           text,
  description2          text,
  uom                   text NOT NULL DEFAULT 'UNIT',
  qty_returned          integer NOT NULL,
  condition             text,
  unit_price_centi      integer NOT NULL DEFAULT 0,
  discount_centi        integer NOT NULL DEFAULT 0,
  line_total_centi      integer NOT NULL DEFAULT 0,
  unit_cost_centi       integer NOT NULL DEFAULT 0,
  line_cost_centi       integer NOT NULL DEFAULT 0,
  line_margin_centi     integer NOT NULL DEFAULT 0,
  refund_centi          integer NOT NULL DEFAULT 0,
  variants              jsonb,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cdr_items_dr ON consignment_delivery_return_items (consignment_delivery_return_id);
CREATE INDEX IF NOT EXISTS idx_cdr_items_do_item ON consignment_delivery_return_items (consignment_do_item_id);

-- ── PURCHASE consignment ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS purchase_consignment_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_number             text NOT NULL UNIQUE,
  supplier_id           uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status                purchase_consignment_order_status NOT NULL DEFAULT 'SUBMITTED',
  po_date               date NOT NULL DEFAULT now(),
  expected_at           date,
  currency              currency_code NOT NULL DEFAULT 'MYR',
  subtotal_centi        integer NOT NULL DEFAULT 0,
  tax_centi             integer NOT NULL DEFAULT 0,
  total_centi           integer NOT NULL DEFAULT 0,
  notes                 text,
  purchase_location_id  uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  submitted_at          timestamptz,
  received_at           timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pco_supplier ON purchase_consignment_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pco_status ON purchase_consignment_orders (status);
CREATE INDEX IF NOT EXISTS idx_pco_date ON purchase_consignment_orders (po_date);

CREATE TABLE IF NOT EXISTS purchase_consignment_order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_consignment_order_id uuid NOT NULL REFERENCES purchase_consignment_orders(id) ON DELETE CASCADE,
  binding_id            uuid,
  material_kind         material_kind NOT NULL,
  material_code         text NOT NULL,
  material_name         text NOT NULL,
  supplier_sku          text,
  qty                   integer NOT NULL DEFAULT 0,
  unit_price_centi      integer NOT NULL DEFAULT 0,
  line_total_centi      integer NOT NULL DEFAULT 0,
  received_qty          integer NOT NULL DEFAULT 0,
  notes                 text,
  item_group            text,
  description           text,
  description2          text,
  uom                   text NOT NULL DEFAULT 'UNIT',
  discount_centi        integer NOT NULL DEFAULT 0,
  unit_cost_centi       integer NOT NULL DEFAULT 0,
  gap_inches            integer,
  divan_height_inches   integer,
  divan_price_sen       integer NOT NULL DEFAULT 0,
  leg_height_inches     integer,
  leg_price_sen         integer NOT NULL DEFAULT 0,
  custom_specials       jsonb,
  line_suffix           text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants              jsonb,
  delivery_date         date,
  warehouse_id          uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pco_items_pco ON purchase_consignment_order_items (purchase_consignment_order_id);

CREATE TABLE IF NOT EXISTS purchase_consignment_receives (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receive_number        text NOT NULL UNIQUE,
  purchase_consignment_order_id uuid REFERENCES purchase_consignment_orders(id) ON DELETE SET NULL,
  pc_order_no           text,
  supplier_id           uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  received_at           date NOT NULL DEFAULT now(),
  delivery_note_ref     text,
  status                purchase_consignment_receive_status NOT NULL DEFAULT 'POSTED',
  notes                 text,
  warehouse_id          uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  currency              currency_code NOT NULL DEFAULT 'MYR',
  subtotal_centi        integer NOT NULL DEFAULT 0,
  tax_centi             integer NOT NULL DEFAULT 0,
  total_centi           integer NOT NULL DEFAULT 0,
  posted_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcr_pco ON purchase_consignment_receives (purchase_consignment_order_id);
CREATE INDEX IF NOT EXISTS idx_pcr_supplier ON purchase_consignment_receives (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pcr_status ON purchase_consignment_receives (status);

CREATE TABLE IF NOT EXISTS purchase_consignment_receive_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_receive_id         uuid NOT NULL REFERENCES purchase_consignment_receives(id) ON DELETE CASCADE,
  pc_order_item_id      uuid REFERENCES purchase_consignment_order_items(id) ON DELETE SET NULL,
  material_kind         material_kind NOT NULL,
  material_code         text NOT NULL,
  material_name         text NOT NULL,
  supplier_sku          text,
  qty_received          integer NOT NULL,
  qty_accepted          integer NOT NULL,
  qty_rejected          integer NOT NULL DEFAULT 0,
  rejection_reason      text,
  unit_price_centi      integer NOT NULL DEFAULT 0,
  notes                 text,
  item_group            text,
  description           text,
  description2          text,
  uom                   text NOT NULL DEFAULT 'UNIT',
  discount_centi        integer NOT NULL DEFAULT 0,
  variants              jsonb,
  gap_inches            integer,
  divan_height_inches   integer,
  divan_price_sen       integer NOT NULL DEFAULT 0,
  leg_height_inches     integer,
  leg_price_sen         integer NOT NULL DEFAULT 0,
  custom_specials       jsonb,
  line_suffix           text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  line_total_centi      integer NOT NULL DEFAULT 0,
  delivery_date         date,
  unit_cost_centi       integer NOT NULL DEFAULT 0,
  invoiced_qty          integer NOT NULL DEFAULT 0,
  returned_qty          integer NOT NULL DEFAULT 0,
  rack_id               uuid REFERENCES warehouse_racks(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcr_items_receive ON purchase_consignment_receive_items (pc_receive_id);

CREATE TABLE IF NOT EXISTS purchase_consignment_returns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number         text NOT NULL UNIQUE,
  pc_order_id           uuid REFERENCES purchase_consignment_orders(id) ON DELETE SET NULL,
  pc_receive_id         uuid REFERENCES purchase_consignment_receives(id) ON DELETE SET NULL,
  supplier_id           uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  return_date           date NOT NULL DEFAULT now(),
  reason                text,
  status                purchase_consignment_return_status NOT NULL DEFAULT 'POSTED',
  posted_at             timestamptz,
  completed_at          timestamptz,
  credit_note_ref       text,
  refund_centi          integer NOT NULL DEFAULT 0,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pct_pco ON purchase_consignment_returns (pc_order_id);
CREATE INDEX IF NOT EXISTS idx_pct_receive ON purchase_consignment_returns (pc_receive_id);
CREATE INDEX IF NOT EXISTS idx_pct_supplier ON purchase_consignment_returns (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pct_status ON purchase_consignment_returns (status);

CREATE TABLE IF NOT EXISTS purchase_consignment_return_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_consignment_return_id uuid NOT NULL REFERENCES purchase_consignment_returns(id) ON DELETE CASCADE,
  pc_receive_item_id    uuid REFERENCES purchase_consignment_receive_items(id) ON DELETE SET NULL,
  material_kind         material_kind NOT NULL,
  material_code         text NOT NULL,
  material_name         text NOT NULL,
  qty_returned          integer NOT NULL,
  unit_price_centi      integer NOT NULL DEFAULT 0,
  line_refund_centi     integer NOT NULL DEFAULT 0,
  reason                text,
  notes                 text,
  item_group            text,
  description           text,
  description2          text,
  uom                   text NOT NULL DEFAULT 'UNIT',
  gap_inches            integer,
  divan_height_inches   integer,
  divan_price_sen       integer NOT NULL DEFAULT 0,
  leg_height_inches     integer,
  leg_price_sen         integer NOT NULL DEFAULT 0,
  custom_specials       jsonb,
  line_suffix           text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants              jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pct_items_return ON purchase_consignment_return_items (purchase_consignment_return_id);
