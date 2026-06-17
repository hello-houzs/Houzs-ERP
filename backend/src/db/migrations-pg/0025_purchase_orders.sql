-- 0025_purchase_orders.sql
--
-- SCM 1:1 clone slice 3: PURCHASE ORDERS (manufacturer-side POs to suppliers).
-- Verbatim clone of 2990s's purchase_orders + purchase_order_items +
-- purchase_order_lines tables (packages/db/src/schema.ts ~L948/979/1031) and
-- the po_status enum (~L853). Money is the integer *_centi column, verbatim.
--
-- TABLE-NAME COLLISION DEVIATION (see docs/scm-clone/PLAN.md collision map):
-- Houzs already has an AutoCount table physically named `purchase_orders`
-- (served by /api/po, ~thousands of live rows). The brief forbids touching it,
-- and two `purchase_orders` tables cannot coexist. So the clone tables take
-- 2990s's OWN mfg_* vocabulary (its route file is mfg-purchase-orders.ts and it
-- already uses mfg_sales_orders / mfg_sales_order_items) as the physical name:
--   mfg_purchase_orders / mfg_purchase_order_items / mfg_purchase_order_lines.
-- The Drizzle export keys stay purchaseOrders / purchaseOrderItems /
-- purchaseOrderLines. Renamed to the bare `purchase_orders` only at the gated
-- cutover (task #71), once the AutoCount table is removed.
--
-- SEAM deviations vs 2990s (all documented in schema.pg.ts + PLAN.md):
--   - created_by: 2990s uuid -> staff.id. Houzs users.id is serial INTEGER
--     (rule #4); SOFT ref (no FK) so the PO module isn't coupled to users.
--   - purchase_location_id / warehouse_id: 2990s FK -> warehouses.id (uuid).
--     warehouses table not cloned yet -> nullable SOFT ref (no FK).
--   - so_item_id: 2990s FK -> mfg_sales_order_items.id. SO slice not cloned
--     yet -> nullable SOFT ref (no FK).
--   - order_id (lines): 2990s FK -> orders.id (retail POS). No `orders` table
--     here -> nullable SOFT ref (no FK).
--
-- Runner contract (backend/scripts/pg-migrate.mjs): the file is split on /;\s*\n/
-- and each statement runs via tx.unsafe(...) inside ONE transaction. So:
--   - NO BEGIN; / COMMIT; (the runner already wraps in a transaction).
--   - every statement is idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
--   - the enum is guarded with a SINGLE-PHYSICAL-LINE DO block (no internal ;\n
--     so the ;\n split can't shatter it). Postgres has no CREATE TYPE IF NOT
--     EXISTS, so the guard checks pg_type first.
-- The currency_code + material_kind enums already exist (migration 0024); only
-- po_status is new. Enum name + values are EXACTLY 2990s's pgEnum(...).

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'po_status') THEN CREATE TYPE po_status AS ENUM ('SUBMITTED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED'); END IF; END $$;

CREATE TABLE IF NOT EXISTS mfg_purchase_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number             text NOT NULL UNIQUE,
  supplier_id           uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status                po_status NOT NULL DEFAULT 'SUBMITTED',
  po_date               date NOT NULL DEFAULT now(),
  expected_at           date,
  purchase_location_id  uuid,
  currency              currency_code NOT NULL DEFAULT 'MYR',
  subtotal_centi        integer NOT NULL DEFAULT 0,
  tax_centi             integer NOT NULL DEFAULT 0,
  total_centi           integer NOT NULL DEFAULT 0,
  notes                 text,
  submitted_at          timestamptz,
  received_at           timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_supplier ON mfg_purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON mfg_purchase_orders (status);

CREATE TABLE IF NOT EXISTS mfg_purchase_order_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id        uuid NOT NULL REFERENCES mfg_purchase_orders(id) ON DELETE CASCADE,
  binding_id               uuid REFERENCES supplier_material_bindings(id) ON DELETE SET NULL,
  material_kind            material_kind NOT NULL,
  material_code            text NOT NULL,
  material_name            text NOT NULL,
  supplier_sku             text,
  qty                      integer NOT NULL,
  unit_price_centi         integer NOT NULL,
  line_total_centi         integer NOT NULL,
  received_qty             integer NOT NULL DEFAULT 0,
  notes                    text,
  gap_inches               integer,
  divan_height_inches      integer,
  divan_price_sen          integer NOT NULL DEFAULT 0,
  leg_height_inches        integer,
  leg_price_sen            integer NOT NULL DEFAULT 0,
  custom_specials          jsonb,
  line_suffix              text,
  special_order_price_sen  integer NOT NULL DEFAULT 0,
  variants                 jsonb,
  item_group               text,
  description              text,
  description2             text,
  uom                      text NOT NULL DEFAULT 'UNIT',
  discount_centi           integer NOT NULL DEFAULT 0,
  unit_cost_centi          integer NOT NULL DEFAULT 0,
  delivery_date            date,
  warehouse_id             uuid,
  so_item_id               uuid,
  from_mrp                 boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_items_po ON mfg_purchase_order_items (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_po_items_warehouse ON mfg_purchase_order_items (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_po_items_so_item ON mfg_purchase_order_items (so_item_id);

CREATE TABLE IF NOT EXISTS mfg_purchase_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id  uuid NOT NULL REFERENCES mfg_purchase_orders(id) ON DELETE CASCADE,
  order_id           text NOT NULL,
  sku                text NOT NULL,
  name               text NOT NULL,
  size               text,
  colour             text,
  qty                integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
