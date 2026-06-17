-- ----------------------------------------------------------------------------
-- 0032 — MRP · per-category lead time (1:1 clone of 2990s migration 0099).
--
-- The ONLY persisted MRP table. The MRP planner itself (mrp.ts) is a PURE
-- CALCULATOR with no persistence (recomputed on every GET); the lead-times
-- config is the one piece of state — it backs the order-by-date calc
-- (order-by = SO delivery date - lead_days[category]) and the Sales-Order
-- Maintenance "Lead Time" mini-table.
--
--   category   : 'sofa' | 'bedframe' | 'mattress' | 'accessory' | 'service'
--                (lowercase, matches mfg_sales_order_items.item_group; the MRP
--                 server uppercase-normalises product category on lookup)
--   lead_days  : how many days early to place the PO (0 = order on the due date)
--
-- SEAMS vs 2990s 0099 (canonical clone rules):
--   - BARE name `mrp_category_lead_times` (Houzs has no collision).
--   - RLS policies DROPPED — Houzs is Drizzle-over-Hyperdrive, not Supabase
--     (no `authenticated` role; route is gated by requirePermission("*")).
--   - `updated_at` kept as timestamptz (config table, server stamps an ISO
--     string via Drizzle; not the datetime('now') text-column gotcha from
--     mig 0008 since this column is never written by raw SQL date fns).
--   - Runner-safe: no BEGIN/COMMIT (the runner wraps the whole file in ONE tx),
--     each statement ends with `;` on its own line, idempotent (IF NOT EXISTS
--     / ON CONFLICT DO NOTHING).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mrp_category_lead_times (
  category    text PRIMARY KEY CHECK (category IN ('sofa', 'bedframe', 'mattress', 'accessory', 'service')),
  lead_days   integer NOT NULL DEFAULT 0 CHECK (lead_days >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO mrp_category_lead_times (category, lead_days) VALUES ('sofa', 0) ON CONFLICT (category) DO NOTHING;
INSERT INTO mrp_category_lead_times (category, lead_days) VALUES ('bedframe', 0) ON CONFLICT (category) DO NOTHING;
INSERT INTO mrp_category_lead_times (category, lead_days) VALUES ('mattress', 0) ON CONFLICT (category) DO NOTHING;
INSERT INTO mrp_category_lead_times (category, lead_days) VALUES ('accessory', 0) ON CONFLICT (category) DO NOTHING;
INSERT INTO mrp_category_lead_times (category, lead_days) VALUES ('service', 0) ON CONFLICT (category) DO NOTHING;
