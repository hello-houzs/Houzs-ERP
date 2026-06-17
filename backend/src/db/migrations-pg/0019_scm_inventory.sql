-- 0019_scm_inventory — Supply Chain stock-movement ledger.
--
-- scm_stock_moves is an append-only ledger of every signed quantity change to
-- on-hand stock (+inbound, -outbound) per (warehouse_code, material_kind,
-- material_code). There is intentionally NO snapshot/balance table:
--   - on-hand qty   is DERIVED as sum(qty) over a material's moves
--   - FIFO valuation is DERIVED by replaying the moves in created_at order,
--     consuming the oldest inbound layers first (each inbound layer carries its
--     unit_cost_centi at move time)
-- Keeping the ledger as the single source of truth avoids drift between a cached
-- balance and the move history. Aggregation happens in the read path.
--
-- Idempotent + immutable: CREATE ... IF NOT EXISTS so re-running is a no-op.

CREATE TABLE IF NOT EXISTS scm_stock_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_code text NOT NULL,                 -- soft ref to warehouses.code
  material_kind text NOT NULL CHECK (material_kind IN ('mfg_product','fabric','raw')),
  material_code text NOT NULL,
  material_name text,
  qty integer NOT NULL,                          -- SIGNED: +inbound, -outbound
  unit_cost_centi integer NOT NULL DEFAULT 0,    -- cost/unit at move time (for FIFO inbound layers)
  move_type text NOT NULL CHECK (move_type IN ('GRN_IN','PURCHASE_RETURN_OUT','TRANSFER_OUT','TRANSFER_IN','ADJUST_IN','ADJUST_OUT','STOCKTAKE_ADJ')),
  ref_type text,                                 -- e.g. 'grn','transfer','stocktake','manual'
  ref_id uuid,
  note text,
  created_by integer,                            -- soft ref users.id
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scm_moves_whmat ON scm_stock_moves (warehouse_code, material_kind, material_code);
CREATE INDEX IF NOT EXISTS idx_scm_moves_ref ON scm_stock_moves (ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_scm_moves_created ON scm_stock_moves (created_at);
