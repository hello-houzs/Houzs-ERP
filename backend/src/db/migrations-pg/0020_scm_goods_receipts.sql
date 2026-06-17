-- 0020_scm_goods_receipts.sql
--
-- SCM Phase 3: Goods Receipts (GRN). A GRN records the physical arrival of PO
-- lines into a warehouse. Posting a GRN is the ONLY way scm_purchase_order_items
-- .received_qty advances and the ONLY purchasing path that writes GRN_IN rows
-- into the scm_stock_moves ledger (see 0019_scm_inventory.sql) — on-hand qty and
-- FIFO valuation are then DERIVED from those moves, no snapshot table.
--
-- Lifecycle: DRAFT (editable, no stock impact) -> POSTED (immutable, stock in,
-- received_qty advanced, parent PO status recomputed) or -> CANCELLED (no stock
-- impact). Posted GRNs cannot be cancelled in v1 (reversal is out of scope).
--
-- scm_ namespace (isolated from AutoCount), Postgres-native types. supplier_id
-- and purchase_order_id are kept soft (no hard FK) only loosely — supplier_id is
-- always required; purchase_order_id is nullable to allow a future direct-receipt
-- flow. created_by is a SOFT reference to users.id (integer), matching the rest of
-- the scm_ island.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS scm_goods_receipt_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_number        text NOT NULL UNIQUE,                    -- 'GRN-2026-0001'
  supplier_id       uuid NOT NULL,
  purchase_order_id uuid,                                    -- nullable: direct receipt allowed
  warehouse_code    text NOT NULL,                           -- soft ref warehouses.code
  status            text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  received_date     date NOT NULL DEFAULT now(),
  notes             text,
  posted_at         timestamptz,
  cancelled_at      timestamptz,
  created_by        integer,                                 -- users.id (soft ref, set from auth)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_grn_po     ON scm_goods_receipt_notes (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_scm_grn_status ON scm_goods_receipt_notes (status);

CREATE TABLE IF NOT EXISTS scm_goods_receipt_note_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id          uuid NOT NULL REFERENCES scm_goods_receipt_notes(id) ON DELETE CASCADE,
  -- optional link to the PO line this receipt fulfils (advances its received_qty)
  po_item_id      uuid,
  material_kind   text NOT NULL DEFAULT 'mfg_product'
                    CHECK (material_kind IN ('mfg_product','fabric','raw')),
  material_code   text NOT NULL,
  material_name   text,
  qty_received    integer NOT NULL DEFAULT 0,
  unit_cost_centi integer NOT NULL DEFAULT 0,                -- cost/unit, becomes the FIFO inbound layer cost
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_grn_items_grn ON scm_goods_receipt_note_items (grn_id);
