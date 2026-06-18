-- 0027_grns.sql
--
-- SCM 1:1 clone slice 4: GOODS RECEIPT (GRN). Verbatim clone of 2990s's grns +
-- grn_items (packages/db/src/schema.ts ~L1057/L1083) consolidated to their FINAL
-- shape (2990s migrations 0042 base + 0057 variant fields + 0101 money parity +
-- 0106 invoiced/returned qty + 0151 rack_id). Money is the integer *_centi
-- column, verbatim. The grn_status enum (POSTED/CLOSED/CANCELLED) is EXACTLY
-- 2990s's name + values.
--
-- NO TABLE-NAME COLLISION: Houzs has no `grns` / `grn_items` -> BARE physical
-- names (PLAN.md collision map). Real FKs as 2990s does:
--   purchase_order_id      -> mfg_purchase_orders(id)        (NULLABLE — see below)
--   supplier_id            -> suppliers(id)
--   warehouse_id           -> mfg_warehouses(id)             (Inventory slice, mig 0026)
--   grn_items.grn_id       -> grns(id)                       ON DELETE CASCADE
--   grn_items.po_item_id   -> mfg_purchase_order_items(id)   ON DELETE SET NULL
--   grn_items.rack_id      -> warehouse_racks(id)            ON DELETE SET NULL
--
-- SEAM deviations vs 2990s (documented in schema.pg.ts header on `grns`):
--   - purchase_order_id: 2990s declares it NOT NULL, but the route inserts NULL
--     for MANUAL/blank GRNs (no parent PO — Commander 2026-05-29). To keep that
--     route path faithful the FK is REAL but NULLABLE (ON DELETE SET NULL).
--     Documented necessary deviation (2990s's own schema/route already disagree).
--   - created_by: 2990s uuid -> staff.id. rule #4 -> Houzs users.id is serial
--     INTEGER; SOFT ref (no FK), matching the PO + inventory slices.
--   - warehouse_id: 2990s -> warehouses.id; here -> mfg_warehouses (the cloned
--     inventory warehouse table). Kept loose (SET NULL) so deleting a warehouse
--     never blocks GRN history.
--
-- Runner contract (backend/scripts/pg-migrate.mjs): the file is split on /;\s*\n/
-- and each statement runs via tx.unsafe(...) inside ONE transaction. So:
--   - NO BEGIN; / COMMIT; (the runner already wraps in a transaction).
--   - every statement is idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
--   - the enum is guarded with a SINGLE-PHYSICAL-LINE DO block (no internal ;\n).
--   - currency_code + material_kind enums already exist (migration 0024); only
--     grn_status is new here.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grn_status') THEN CREATE TYPE grn_status AS ENUM ('POSTED','CLOSED','CANCELLED'); END IF; END $$;

CREATE TABLE IF NOT EXISTS grns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_number         text NOT NULL UNIQUE,
  purchase_order_id  uuid REFERENCES mfg_purchase_orders(id) ON DELETE SET NULL,
  supplier_id        uuid NOT NULL REFERENCES mfg_suppliers(id) ON DELETE RESTRICT,
  warehouse_id       uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  received_at        date NOT NULL DEFAULT now(),
  delivery_note_ref  text,
  status             grn_status NOT NULL DEFAULT 'POSTED',
  notes              text,
  currency           currency_code NOT NULL DEFAULT 'MYR',
  subtotal_centi     integer NOT NULL DEFAULT 0,
  tax_centi          integer NOT NULL DEFAULT 0,
  total_centi        integer NOT NULL DEFAULT 0,
  posted_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         integer NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grn_po ON grns (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_grn_supplier ON grns (supplier_id);
CREATE INDEX IF NOT EXISTS idx_grn_status ON grns (status);

CREATE TABLE IF NOT EXISTS grn_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id                  uuid NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
  purchase_order_item_id  uuid REFERENCES mfg_purchase_order_items(id) ON DELETE SET NULL,
  material_kind           material_kind NOT NULL,
  material_code           text NOT NULL,
  material_name           text NOT NULL,
  qty_received            integer NOT NULL,
  qty_accepted            integer NOT NULL,
  qty_rejected            integer NOT NULL DEFAULT 0,
  rejection_reason        text,
  unit_price_centi        integer NOT NULL,
  notes                   text,
  gap_inches              integer,
  divan_height_inches     integer,
  divan_price_sen         integer NOT NULL DEFAULT 0,
  leg_height_inches       integer,
  leg_price_sen           integer NOT NULL DEFAULT 0,
  custom_specials         jsonb,
  line_suffix             text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants                jsonb,
  item_group              text,
  description             text,
  description2            text,
  uom                     text NOT NULL DEFAULT 'UNIT',
  discount_centi          integer NOT NULL DEFAULT 0,
  line_total_centi        integer NOT NULL DEFAULT 0,
  delivery_date           date,
  unit_cost_centi         integer NOT NULL DEFAULT 0,
  supplier_sku            text,
  invoiced_qty            integer NOT NULL DEFAULT 0,
  returned_qty            integer NOT NULL DEFAULT 0,
  rack_id                 uuid REFERENCES warehouse_racks(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grn_items_grn ON grn_items (grn_id);
