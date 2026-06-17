-- 0022_scm_transfers_stocktake.sql
--
-- SCM Phase 5: Stock Transfers (warehouse-to-warehouse) + Stocktakes (count
-- reconciliation). Both are DRAFT -> POSTED docs that write into the existing
-- scm_stock_moves ledger (see 0019_scm_inventory.sql — TRANSFER_OUT,
-- TRANSFER_IN and STOCKTAKE_ADJ are already in that table's move_type CHECK).
--
-- Stock Transfers relocate on-hand stock between two warehouses WITHOUT changing
-- total value: posting writes a matched pair per line — a NEGATIVE-qty
-- TRANSFER_OUT at the source warehouse and a POSITIVE-qty TRANSFER_IN at the
-- destination, both at the source warehouse's current FIFO average cost. The
-- from/to warehouses must differ (enforced in the shared Zod schema + handler).
--
-- Stocktakes reconcile derived on-hand to a physical count: at create time we
-- snapshot system_qty (current on-hand) per line; at post time, for each line
-- with counted_qty != system_qty we write ONE signed STOCKTAKE_ADJ move of
-- (counted_qty - system_qty) so the ledger reconciles to the counted figure.
--
-- scm_ namespace (isolated from AutoCount), Postgres-native types. created_by is
-- a SOFT reference to users.id (integer), matching the rest of the scm_ island.
-- Lifecycle for both: DRAFT (editable, no stock impact) -> POSTED (immutable,
-- ledger written) or -> CANCELLED. Posted docs are final in v1 (no reversal).
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS scm_stock_transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_number     text NOT NULL UNIQUE,                    -- 'TRF-2026-0001'
  from_warehouse_code text NOT NULL,                           -- soft ref warehouses.code
  to_warehouse_code   text NOT NULL,                           -- soft ref warehouses.code
  status              text NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  notes               text,
  posted_at           timestamptz,
  cancelled_at        timestamptz,
  created_by          integer,                                 -- users.id (soft ref, set from auth)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_trf_status ON scm_stock_transfers (status);

CREATE TABLE IF NOT EXISTS scm_stock_transfer_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   uuid NOT NULL REFERENCES scm_stock_transfers(id) ON DELETE CASCADE,
  material_kind text NOT NULL DEFAULT 'mfg_product'
                  CHECK (material_kind IN ('mfg_product','fabric','raw')),
  material_code text NOT NULL,
  material_name text,
  qty           integer NOT NULL DEFAULT 0,                    -- positive here; written as -qty OUT / +qty IN on post
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_trf_items_transfer ON scm_stock_transfer_items (transfer_id);

CREATE TABLE IF NOT EXISTS scm_stocktakes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_number text NOT NULL UNIQUE,                       -- 'STK-2026-0001'
  warehouse_code   text NOT NULL,                              -- soft ref warehouses.code
  status           text NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  notes            text,
  posted_at        timestamptz,
  cancelled_at     timestamptz,
  created_by       integer,                                    -- users.id (soft ref, set from auth)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_stk_warehouse ON scm_stocktakes (warehouse_code);
CREATE INDEX IF NOT EXISTS idx_scm_stk_status    ON scm_stocktakes (status);

CREATE TABLE IF NOT EXISTS scm_stocktake_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id  uuid NOT NULL REFERENCES scm_stocktakes(id) ON DELETE CASCADE,
  material_kind text NOT NULL DEFAULT 'mfg_product'
                  CHECK (material_kind IN ('mfg_product','fabric','raw')),
  material_code text NOT NULL,
  material_name text,
  system_qty    integer NOT NULL DEFAULT 0,                    -- snapshot of derived on-hand at create time
  counted_qty   integer NOT NULL DEFAULT 0,                    -- physical count entered by the user
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scm_stk_items_stocktake ON scm_stocktake_items (stocktake_id);
