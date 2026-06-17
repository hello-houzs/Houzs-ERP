-- 0026_inventory_warehouse.sql
--
-- SCM 1:1 clone slice 6: INVENTORY + WAREHOUSE (FIFO lots/movements/valuation +
-- warehouse rack management). Verbatim clone of 2990s's warehouses,
-- inventory_movements, inventory_lots, inventory_lot_consumptions,
-- stock_transfers(+lines), stock_takes(+lines), warehouse_racks(+items,
-- +movements) — packages/db/src/schema.ts — plus the FIFO engine
-- (fn_consume_fifo / fn_consume_fifo_batch / fn_inventory_movement_fifo +
-- trg_inventory_movement_fifo) and the inventory views, consolidated to the
-- FINAL state of 2990s migrations 0050+0053+0095+0117+0120+0121+0122+0126+0150
-- +0152. Money is the integer *_sen / *_centi column, verbatim.
--
-- TABLE-NAME COLLISION DEVIATION (see docs/scm-clone/PLAN.md collision map +
-- NAMING CONVENTION): Houzs already has an AutoCount table physically named
-- `warehouses` (schema.pg.ts ~L279, served by /api/warehouses). Two `warehouses`
-- tables cannot coexist and the brief forbids touching the AutoCount one. So the
-- clone takes 2990s's own `mfg_` vocabulary as the physical name:
-- `mfg_warehouses`. The Drizzle export key stays `warehouses`. The four
-- non-colliding tables keep bare names (warehouse_racks, inventory_movements,
-- inventory_lots, inventory_lot_consumptions). All warehouse FKs target
-- mfg_warehouses(id). Renamed to the bare `warehouses` only at the gated cutover
-- (task #71), once the AutoCount table is removed.
--
-- SEAM deviations vs 2990s (documented in schema.pg.ts + PLAN.md):
--   - performed_by / created_by: 2990s uuid -> staff.id. Houzs users.id is serial
--     INTEGER (rule #4); SOFT ref (no FK), so this slice isn't coupled to users.
--   - Strategy-2 product layer: 2990s materials/products are TEXT (product_code),
--     which transfers as-is. The two CATALOGUE-COUPLED views
--     (v_inventory_all_skus + v_inventory_product_totals) CROSS JOIN mfg_products,
--     which Houzs does NOT have — so they are NOT created here. The inventory
--     route's /products + showAll=true paths return a faithful empty shape until a
--     product layer lands (see routes/inventory.ts TODO). Every other view
--     (inventory_balances, v_inventory_lots_open, v_inventory_value,
--     v_cogs_entries) is product-table-free and IS created.
--   - variant_key: kept verbatim (generic attribute-composition bucket). Houzs
--     materials have no category, so callers pass '' and stock pools per
--     product_code. computeVariantKey is ported to shared/ for the future product
--     layer.
--
-- Runner contract (backend/scripts/pg-migrate.mjs): the file is split on
-- /;\s*\n/ and each statement runs via tx.unsafe(...) inside ONE transaction. So:
--   - NO BEGIN; / COMMIT; (the runner already wraps in a transaction).
--   - every statement is idempotent (CREATE TABLE/INDEX/VIEW IF NOT EXISTS /
--     CREATE OR REPLACE / DROP ... IF EXISTS).
--   - the enum is guarded with a SINGLE-PHYSICAL-LINE DO block (no internal ;\n).
--   - CRITICAL: each plpgsql function (which has many internal `;`) is written on
--     ONE PHYSICAL LINE with `; ` (semicolon-space) separators so the ;\n split
--     can't shatter the function body. The whole CREATE FUNCTION ... $$ ... $$
--     LANGUAGE plpgsql is one statement; it ends with `;` + newline.
--   - the currency_code + material_kind enums already exist (migration 0024); only
--     inventory_movement_type is new here. Enum name + values are EXACTLY 2990s's.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_movement_type') THEN CREATE TYPE inventory_movement_type AS ENUM ('IN','OUT','ADJUSTMENT','TRANSFER'); END IF; END $$;

CREATE TABLE IF NOT EXISTS mfg_warehouses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  location        text,
  is_active       boolean NOT NULL DEFAULT true,
  is_default      boolean NOT NULL DEFAULT false,
  is_consignment  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warehouses_active ON mfg_warehouses (is_active);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type    inventory_movement_type NOT NULL,
  warehouse_id     uuid NOT NULL REFERENCES mfg_warehouses(id) ON DELETE RESTRICT,
  product_code     text NOT NULL,
  product_name     text,
  variant_key      text NOT NULL DEFAULT '',
  qty              integer NOT NULL,
  unit_cost_sen    integer DEFAULT 0,
  total_cost_sen   integer DEFAULT 0,
  source_doc_type  text,
  source_doc_id    uuid,
  source_doc_no    text,
  batch_no         text,
  reason_code      text,
  notes            text,
  performed_by     integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_mov_warehouse_product ON inventory_movements (warehouse_id, product_code, variant_key);
CREATE INDEX IF NOT EXISTS idx_inv_mov_doc ON inventory_movements (source_doc_type, source_doc_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_created ON inventory_movements (created_at);

CREATE TABLE IF NOT EXISTS inventory_lots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id    uuid NOT NULL REFERENCES mfg_warehouses(id) ON DELETE RESTRICT,
  product_code    text NOT NULL,
  product_name    text,
  variant_key     text NOT NULL DEFAULT '',
  qty_received    integer NOT NULL CHECK (qty_received > 0),
  qty_remaining   integer NOT NULL CHECK (qty_remaining >= 0),
  unit_cost_sen   integer NOT NULL DEFAULT 0,
  received_at     timestamptz NOT NULL DEFAULT now(),
  source_doc_type text,
  source_doc_id   uuid,
  source_doc_no   text,
  movement_id     uuid,
  batch_no        text,
  notes           text,
  created_by      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_lots_wh_product ON inventory_lots (warehouse_id, product_code, variant_key, received_at);
CREATE INDEX IF NOT EXISTS idx_inv_lots_batch ON inventory_lots (warehouse_id, batch_no, product_code, variant_key) WHERE qty_remaining > 0 AND batch_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_lot_consumptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          uuid NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
  warehouse_id    uuid NOT NULL REFERENCES mfg_warehouses(id) ON DELETE RESTRICT,
  product_code    text NOT NULL,
  variant_key     text NOT NULL DEFAULT '',
  qty_consumed    integer NOT NULL CHECK (qty_consumed > 0),
  unit_cost_sen   integer NOT NULL,
  total_cost_sen  integer NOT NULL,
  consumed_at     timestamptz NOT NULL DEFAULT now(),
  source_doc_type text,
  source_doc_id   uuid,
  source_doc_no   text,
  movement_id     uuid,
  created_by      integer
);

CREATE INDEX IF NOT EXISTS idx_inv_cons_lot ON inventory_lot_consumptions (lot_id);
CREATE INDEX IF NOT EXISTS idx_inv_cons_doc ON inventory_lot_consumptions (source_doc_type, source_doc_id);
CREATE INDEX IF NOT EXISTS idx_inv_cons_consumed ON inventory_lot_consumptions (consumed_at);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no       text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'POSTED',
  from_warehouse_id uuid NOT NULL REFERENCES mfg_warehouses(id) ON DELETE RESTRICT,
  to_warehouse_id   uuid NOT NULL REFERENCES mfg_warehouses(id) ON DELETE RESTRICT,
  transfer_date     date NOT NULL DEFAULT now(),
  notes             text,
  posted_at         timestamptz,
  cancelled_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        integer,
  CONSTRAINT stock_transfers_not_same_wh CHECK (from_warehouse_id <> to_warehouse_id),
  CONSTRAINT stock_transfers_status_chk CHECK (status IN ('POSTED','CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers (status, transfer_date);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_wh ON stock_transfers (from_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_wh ON stock_transfers (to_warehouse_id);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_transfer_id uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_code      text NOT NULL,
  product_name      text,
  variant_key       text NOT NULL DEFAULT '',
  qty               integer NOT NULL CHECK (qty > 0),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_xfer ON stock_transfer_lines (stock_transfer_id);

CREATE TABLE IF NOT EXISTS stock_takes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  take_no       text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'OPEN',
  warehouse_id  uuid NOT NULL REFERENCES mfg_warehouses(id) ON DELETE RESTRICT,
  scope_type    text NOT NULL DEFAULT 'ALL',
  scope_value   text,
  take_date     date NOT NULL DEFAULT now(),
  notes         text,
  posted_at     timestamptz,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    integer,
  CONSTRAINT stock_takes_status_chk CHECK (status IN ('OPEN','POSTED','CANCELLED')),
  CONSTRAINT stock_takes_scope_type_chk CHECK (scope_type IN ('ALL','CATEGORY','CODE_PREFIX'))
);

CREATE INDEX IF NOT EXISTS idx_stock_takes_status ON stock_takes (status, take_date);
CREATE INDEX IF NOT EXISTS idx_stock_takes_warehouse ON stock_takes (warehouse_id);

CREATE TABLE IF NOT EXISTS stock_take_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_take_id uuid NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
  product_code  text NOT NULL,
  product_name  text,
  system_qty    integer NOT NULL DEFAULT 0,
  counted_qty   integer,
  variance      integer GENERATED ALWAYS AS (COALESCE(counted_qty, 0) - system_qty) STORED,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_take_lines_take ON stock_take_lines (stock_take_id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_take_lines_take_product_unique ON stock_take_lines (stock_take_id, product_code);

CREATE TABLE IF NOT EXISTS warehouse_racks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES mfg_warehouses(id) ON DELETE CASCADE,
  rack         text NOT NULL,
  position     text,
  status       text NOT NULL DEFAULT 'EMPTY',
  reserved     boolean NOT NULL DEFAULT false,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_racks_status_chk CHECK (status IN ('OCCUPIED','EMPTY','RESERVED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_racks_warehouse_rack_key ON warehouse_racks (warehouse_id, rack);
CREATE INDEX IF NOT EXISTS idx_warehouse_racks_warehouse ON warehouse_racks (warehouse_id, rack);
CREATE INDEX IF NOT EXISTS idx_warehouse_racks_status ON warehouse_racks (status);

CREATE TABLE IF NOT EXISTS warehouse_rack_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rack_id         uuid NOT NULL REFERENCES warehouse_racks(id) ON DELETE CASCADE,
  product_code    text NOT NULL,
  variant_key     text NOT NULL DEFAULT '',
  product_name    text,
  size_label      text,
  customer_name   text,
  source_doc_no   text,
  qty             integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  stocked_in_date date NOT NULL DEFAULT now(),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warehouse_rack_items_rack ON warehouse_rack_items (rack_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_rack_items_product ON warehouse_rack_items (product_code);

CREATE TABLE IF NOT EXISTS warehouse_rack_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type text NOT NULL,
  rack_id       uuid,
  rack_label    text,
  to_rack_id    uuid,
  to_rack_label text,
  warehouse_id  uuid REFERENCES mfg_warehouses(id) ON DELETE SET NULL,
  product_code  text,
  variant_key   text NOT NULL DEFAULT '',
  product_name  text,
  source_doc_no text,
  quantity      integer NOT NULL DEFAULT 1,
  reason        text,
  performed_by  integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_rack_movements_type_chk CHECK (movement_type IN ('STOCK_IN','STOCK_OUT','TRANSFER'))
);

CREATE INDEX IF NOT EXISTS idx_warehouse_rack_movements_type ON warehouse_rack_movements (movement_type);
CREATE INDEX IF NOT EXISTS idx_warehouse_rack_movements_rack ON warehouse_rack_movements (rack_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_rack_movements_created ON warehouse_rack_movements (created_at);

-- ── FIFO consumer (variant-scoped) — 2990s migration 0095, verbatim. ────────
-- Written on ONE PHYSICAL LINE (internal `; ` separators) so the ;\n runner
-- split keeps the whole plpgsql body in one statement.
CREATE OR REPLACE FUNCTION fn_consume_fifo( p_warehouse_id UUID, p_product_code TEXT, p_variant_key TEXT, p_qty_needed INTEGER, p_source_doc_type TEXT, p_source_doc_id UUID, p_source_doc_no TEXT, p_movement_id UUID, p_created_by INTEGER ) RETURNS TABLE (total_cost_sen INTEGER, qty_short INTEGER) AS $fn$ DECLARE v_lot RECORD; v_take INTEGER; v_remaining INTEGER := p_qty_needed; v_total_cost INTEGER := 0; BEGIN FOR v_lot IN SELECT id, qty_remaining, unit_cost_sen FROM inventory_lots WHERE warehouse_id = p_warehouse_id AND product_code = p_product_code AND variant_key = p_variant_key AND qty_remaining > 0 ORDER BY received_at ASC, id ASC FOR UPDATE LOOP EXIT WHEN v_remaining <= 0; v_take := LEAST(v_lot.qty_remaining, v_remaining); v_total_cost := v_total_cost + (v_take * v_lot.unit_cost_sen); v_remaining := v_remaining - v_take; UPDATE inventory_lots SET qty_remaining = qty_remaining - v_take WHERE id = v_lot.id; INSERT INTO inventory_lot_consumptions ( lot_id, warehouse_id, product_code, variant_key, qty_consumed, unit_cost_sen, total_cost_sen, source_doc_type, source_doc_id, source_doc_no, movement_id, created_by ) VALUES ( v_lot.id, p_warehouse_id, p_product_code, p_variant_key, v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen, p_source_doc_type, p_source_doc_id, p_source_doc_no, p_movement_id, p_created_by ); END LOOP; RETURN QUERY SELECT v_total_cost, GREATEST(v_remaining, 0); END; $fn$ LANGUAGE plpgsql;

-- ── Batch-scoped FIFO consumer — 2990s migration 0121, verbatim. ────────────
CREATE OR REPLACE FUNCTION fn_consume_fifo_batch( p_warehouse_id UUID, p_product_code TEXT, p_variant_key TEXT, p_qty_needed INTEGER, p_batch_no TEXT, p_source_doc_type TEXT, p_source_doc_id UUID, p_source_doc_no TEXT, p_movement_id UUID, p_created_by INTEGER ) RETURNS TABLE (total_cost_sen INTEGER, qty_short INTEGER) AS $fn$ DECLARE v_lot RECORD; v_take INTEGER; v_remaining INTEGER := p_qty_needed; v_total_cost INTEGER := 0; BEGIN FOR v_lot IN SELECT id, qty_remaining, unit_cost_sen FROM inventory_lots WHERE warehouse_id = p_warehouse_id AND product_code = p_product_code AND variant_key = p_variant_key AND batch_no = p_batch_no AND qty_remaining > 0 ORDER BY received_at ASC, id ASC FOR UPDATE LOOP EXIT WHEN v_remaining <= 0; v_take := LEAST(v_lot.qty_remaining, v_remaining); v_total_cost := v_total_cost + (v_take * v_lot.unit_cost_sen); v_remaining := v_remaining - v_take; UPDATE inventory_lots SET qty_remaining = qty_remaining - v_take WHERE id = v_lot.id; INSERT INTO inventory_lot_consumptions ( lot_id, warehouse_id, product_code, variant_key, qty_consumed, unit_cost_sen, total_cost_sen, source_doc_type, source_doc_id, source_doc_no, movement_id, created_by ) VALUES ( v_lot.id, p_warehouse_id, p_product_code, p_variant_key, v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen, p_source_doc_type, p_source_doc_id, p_source_doc_no, p_movement_id, p_created_by ); END LOOP; RETURN QUERY SELECT v_total_cost, GREATEST(v_remaining, 0); END; $fn$ LANGUAGE plpgsql;

-- ── FIFO movement trigger fn — FINAL state of 2990s migration 0126 (the
-- ADJUSTMENT branch, with the IN/OUT branches from 0121). One physical line. ──
CREATE OR REPLACE FUNCTION fn_inventory_movement_fifo() RETURNS TRIGGER AS $fn$ DECLARE v_result RECORD; v_abs_qty INTEGER; v_avg_cost INTEGER; v_unit_cost INTEGER; BEGIN IF NEW.movement_type = 'IN' THEN INSERT INTO inventory_lots ( warehouse_id, product_code, variant_key, product_name, qty_received, qty_remaining, unit_cost_sen, received_at, source_doc_type, source_doc_id, source_doc_no, movement_id, created_by, batch_no ) VALUES ( NEW.warehouse_id, NEW.product_code, NEW.variant_key, NEW.product_name, NEW.qty, NEW.qty, COALESCE(NEW.unit_cost_sen, 0), NEW.created_at, NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no, NEW.id, NEW.performed_by, NEW.batch_no ); UPDATE inventory_movements SET total_cost_sen = NEW.qty * COALESCE(NEW.unit_cost_sen, 0) WHERE id = NEW.id; ELSIF NEW.movement_type = 'OUT' THEN v_abs_qty := ABS(NEW.qty); IF NEW.batch_no IS NOT NULL THEN SELECT * INTO v_result FROM fn_consume_fifo_batch( NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty, NEW.batch_no, NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no, NEW.id, NEW.performed_by ); ELSE SELECT * INTO v_result FROM fn_consume_fifo( NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty, NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no, NEW.id, NEW.performed_by ); END IF; UPDATE inventory_movements SET total_cost_sen = v_result.total_cost_sen, unit_cost_sen = CASE WHEN v_abs_qty > 0 THEN v_result.total_cost_sen / v_abs_qty ELSE 0 END WHERE id = NEW.id; ELSIF NEW.movement_type = 'ADJUSTMENT' THEN IF NEW.qty > 0 THEN SELECT CASE WHEN SUM(qty_remaining) > 0 THEN SUM(qty_remaining * unit_cost_sen) / SUM(qty_remaining) ELSE 0 END INTO v_avg_cost FROM inventory_lots WHERE warehouse_id = NEW.warehouse_id AND product_code = NEW.product_code AND variant_key = NEW.variant_key AND qty_remaining > 0; v_unit_cost := COALESCE(NULLIF(NEW.unit_cost_sen, 0), v_avg_cost, 0); INSERT INTO inventory_lots ( warehouse_id, product_code, variant_key, product_name, qty_received, qty_remaining, unit_cost_sen, received_at, source_doc_type, source_doc_id, source_doc_no, movement_id, created_by, batch_no ) VALUES ( NEW.warehouse_id, NEW.product_code, NEW.variant_key, NEW.product_name, NEW.qty, NEW.qty, v_unit_cost, NEW.created_at, NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no, NEW.id, NEW.performed_by, NEW.batch_no ); UPDATE inventory_movements SET total_cost_sen = NEW.qty * v_unit_cost, unit_cost_sen = v_unit_cost WHERE id = NEW.id; ELSIF NEW.qty < 0 THEN v_abs_qty := ABS(NEW.qty); IF NEW.batch_no IS NOT NULL THEN SELECT * INTO v_result FROM fn_consume_fifo_batch( NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty, NEW.batch_no, NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no, NEW.id, NEW.performed_by ); ELSE SELECT * INTO v_result FROM fn_consume_fifo( NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty, NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no, NEW.id, NEW.performed_by ); END IF; UPDATE inventory_movements SET total_cost_sen = v_result.total_cost_sen, unit_cost_sen = CASE WHEN v_abs_qty > 0 THEN v_result.total_cost_sen / v_abs_qty ELSE 0 END WHERE id = NEW.id; END IF; END IF; RETURN NEW; END; $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_movement_fifo ON inventory_movements;
CREATE TRIGGER trg_inventory_movement_fifo AFTER INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION fn_inventory_movement_fifo();

-- ── Views (product-table-free subset; verbatim from 2990s 0095/0122) ────────
-- Per (warehouse, product_code, variant_key) on-hand. Drilldown balance source.
CREATE OR REPLACE VIEW inventory_balances AS SELECT warehouse_id, product_code, variant_key, MAX(product_name) AS product_name, SUM( CASE WHEN movement_type = 'IN' THEN qty WHEN movement_type = 'OUT' THEN -qty WHEN movement_type = 'ADJUSTMENT' THEN qty WHEN movement_type = 'TRANSFER' THEN qty ELSE 0 END ) AS qty, MAX(created_at) AS last_movement_at FROM inventory_movements GROUP BY warehouse_id, product_code, variant_key;

-- Open-lots drilldown (carries batch_no — 2990s migration 0122).
CREATE OR REPLACE VIEW v_inventory_lots_open AS SELECT l.id, l.warehouse_id, w.code AS warehouse_code, l.product_code, l.variant_key, l.product_name, l.qty_received, l.qty_remaining, l.unit_cost_sen, (l.qty_remaining * l.unit_cost_sen) AS remaining_value_sen, l.received_at, l.source_doc_type, l.source_doc_no, l.batch_no FROM inventory_lots l LEFT JOIN mfg_warehouses w ON w.id = l.warehouse_id WHERE l.qty_remaining > 0 ORDER BY l.received_at;

-- Valuation per (warehouse, product, variant).
CREATE OR REPLACE VIEW v_inventory_value AS SELECT l.warehouse_id, w.code AS warehouse_code, l.product_code, l.variant_key, l.product_name, SUM(l.qty_remaining) AS qty_on_hand, SUM(l.qty_remaining * l.unit_cost_sen) AS value_sen, CASE WHEN SUM(l.qty_remaining) > 0 THEN SUM(l.qty_remaining * l.unit_cost_sen) / SUM(l.qty_remaining) ELSE 0 END AS avg_unit_cost_sen FROM inventory_lots l LEFT JOIN mfg_warehouses w ON w.id = l.warehouse_id WHERE l.qty_remaining > 0 GROUP BY l.warehouse_id, w.code, l.product_code, l.variant_key, l.product_name;

-- COGS stream (flat list of consumptions).
CREATE OR REPLACE VIEW v_cogs_entries AS SELECT c.id, c.consumed_at, c.warehouse_id, w.code AS warehouse_code, c.product_code, c.variant_key, c.qty_consumed, c.unit_cost_sen, c.total_cost_sen, c.source_doc_type, c.source_doc_no, l.received_at AS lot_received_at, l.source_doc_no AS lot_source_doc_no FROM inventory_lot_consumptions c JOIN inventory_lots l ON l.id = c.lot_id LEFT JOIN mfg_warehouses w ON w.id = c.warehouse_id ORDER BY c.consumed_at DESC;

-- Seed the default warehouses (2990s migration 0050 seeded KL + PJ). Owner
-- re-enters real data; KL stays the default so GRN/DO pre-select works. ON
-- CONFLICT keeps this idempotent + non-destructive on re-run.
INSERT INTO mfg_warehouses (code, name, location, is_default) VALUES ('KL', 'KL Warehouse', NULL, true), ('PJ', '2990 PJ', NULL, false) ON CONFLICT (code) DO NOTHING;
