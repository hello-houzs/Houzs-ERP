-- 0018_scm_purchase_orders.sql
--
-- SCM Phase 2: Purchase Orders (header + line items). Ported from the 2990s
-- ERP, TRIMMED to generic purchasing fields — the 2990s sofa/bedframe variant
-- columns (gap / divan / leg / specials / line_suffix / sofa colour, …) are
-- intentionally dropped because Houzs purchasing isn't a furniture
-- configurator. A generic `variants` jsonb is kept for any per-line
-- attributes Houzs needs later.
--
-- scm_ namespace (isolated from AutoCount's purchase_orders), Postgres-native
-- types. created_by is a SOFT reference to users.id (integer) — not a hard FK,
-- to keep the scm_ island decoupled from the legacy serial-id tables.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS scm_purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number       text NOT NULL UNIQUE,                    -- 'PO-2026-001'
  supplier_id     uuid NOT NULL REFERENCES scm_suppliers(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'SUBMITTED'
                    CHECK (status IN ('SUBMITTED','SCHEDULED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  po_date         date NOT NULL DEFAULT now(),
  expected_at     date,                                    -- delivery ETA
  currency        text NOT NULL DEFAULT 'MYR',
  subtotal_centi  integer NOT NULL DEFAULT 0,
  tax_centi       integer NOT NULL DEFAULT 0,
  total_centi     integer NOT NULL DEFAULT 0,
  notes           text,
  submitted_at    timestamptz,
  received_at     timestamptz,
  cancelled_at    timestamptz,
  created_by      integer,                                 -- users.id (soft ref, set from auth)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_po_supplier ON scm_purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_scm_po_status   ON scm_purchase_orders (status);

CREATE TABLE IF NOT EXISTS scm_purchase_order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES scm_purchase_orders(id) ON DELETE CASCADE,
  -- optional link to the binding that priced this line (price-change traceability)
  binding_id        uuid REFERENCES scm_supplier_material_bindings(id) ON DELETE SET NULL,
  material_kind     text NOT NULL DEFAULT 'mfg_product'
                      CHECK (material_kind IN ('mfg_product','fabric','raw')),
  material_code     text NOT NULL,
  material_name     text NOT NULL,
  supplier_sku      text,                                  -- snapshot at PO time
  qty               integer NOT NULL DEFAULT 0,
  unit_price_centi  integer NOT NULL DEFAULT 0,
  discount_centi    integer NOT NULL DEFAULT 0,
  line_total_centi  integer NOT NULL DEFAULT 0,            -- qty * unit_price - discount
  received_qty      integer NOT NULL DEFAULT 0,            -- updated by GRN (Phase 3)
  uom               text NOT NULL DEFAULT 'UNIT',
  variants          jsonb,                                 -- generic per-line attributes
  notes             text,
  delivery_date     date,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_po_items_po ON scm_purchase_order_items (purchase_order_id);
