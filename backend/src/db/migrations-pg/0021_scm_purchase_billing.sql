-- 0021_scm_purchase_billing.sql
--
-- SCM Phase 4: Purchase Invoices (billing) + Purchase Returns (outbound stock).
--
-- Purchase Invoices are a FINANCE record only — they capture what a supplier
-- billed us (amounts, payment status) and carry NO stock impact. Stock always
-- arrives via a Goods Receipt (GRN); a PI may exist with or without a matching
-- GRN (PI-without-GRN is intentional, mirroring the GRN-without-PO direct path).
-- Lifecycle is driven by amount_paid_centi vs total_centi:
--   UNPAID (paid = 0) -> PARTIAL (0 < paid < total) -> PAID (paid >= total),
--   or CANCELLED (terminal, set explicitly).
--
-- Purchase Returns MIRROR the GRN doc but OUTBOUND: posting a return writes
-- NEGATIVE-qty PURCHASE_RETURN_OUT rows into the scm_stock_moves ledger (see
-- 0019_scm_inventory.sql — PURCHASE_RETURN_OUT is already in that table's
-- move_type CHECK). Lifecycle: DRAFT (editable, no stock impact) -> POSTED
-- (immutable, stock reduced) or -> CANCELLED. Posted returns are final in v1
-- (no reversal).
--
-- scm_ namespace (isolated from AutoCount), Postgres-native types. supplier_id
-- is always required; purchase_order_id is nullable (loose link). created_by is
-- a SOFT reference to users.id (integer), matching the rest of the scm_ island.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS scm_purchase_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number     text NOT NULL UNIQUE,                    -- 'PI-2026-0001'
  supplier_invoice_no text,                                   -- the supplier's own invoice ref
  supplier_id        uuid NOT NULL,
  purchase_order_id  uuid,                                    -- nullable: loose link to a PO
  invoice_date       date NOT NULL DEFAULT now(),
  due_date           date,
  currency           text NOT NULL DEFAULT 'MYR',
  subtotal_centi     integer NOT NULL DEFAULT 0,
  tax_centi          integer NOT NULL DEFAULT 0,
  total_centi        integer NOT NULL DEFAULT 0,
  amount_paid_centi  integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'UNPAID'
                       CHECK (status IN ('UNPAID','PARTIAL','PAID','CANCELLED')),
  notes              text,
  created_by         integer,                                 -- users.id (soft ref, set from auth)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_pi_supplier ON scm_purchase_invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_scm_pi_status   ON scm_purchase_invoices (status);

CREATE TABLE IF NOT EXISTS scm_purchase_invoice_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL REFERENCES scm_purchase_invoices(id) ON DELETE CASCADE,
  material_kind    text NOT NULL DEFAULT 'mfg_product'
                     CHECK (material_kind IN ('mfg_product','fabric','raw')),
  material_code    text NOT NULL,
  material_name    text,
  qty              integer NOT NULL DEFAULT 0,
  unit_price_centi integer NOT NULL DEFAULT 0,
  discount_centi   integer NOT NULL DEFAULT 0,
  line_total_centi integer NOT NULL DEFAULT 0,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_pi_items_invoice ON scm_purchase_invoice_items (invoice_id);

CREATE TABLE IF NOT EXISTS scm_purchase_returns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number     text NOT NULL UNIQUE,                     -- 'RTN-2026-0001'
  supplier_id       uuid NOT NULL,
  warehouse_code    text NOT NULL,                            -- soft ref warehouses.code
  purchase_order_id uuid,                                     -- nullable: loose link to a PO
  status            text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  reason            text,
  notes             text,
  posted_at         timestamptz,
  cancelled_at      timestamptz,
  created_by        integer,                                  -- users.id (soft ref, set from auth)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_rtn_supplier ON scm_purchase_returns (supplier_id);
CREATE INDEX IF NOT EXISTS idx_scm_rtn_status   ON scm_purchase_returns (status);

CREATE TABLE IF NOT EXISTS scm_purchase_return_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id       uuid NOT NULL REFERENCES scm_purchase_returns(id) ON DELETE CASCADE,
  material_kind   text NOT NULL DEFAULT 'mfg_product'
                    CHECK (material_kind IN ('mfg_product','fabric','raw')),
  material_code   text NOT NULL,
  material_name   text,
  qty_returned    integer NOT NULL DEFAULT 0,                 -- positive here; written NEGATIVE to the ledger on post
  unit_cost_centi integer NOT NULL DEFAULT 0,                 -- cost/unit of the outbound move
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_rtn_items_return ON scm_purchase_return_items (return_id);
