-- ═══════════════════════════════════════
-- Migration 004 — Region simplification + Events table
--
-- The dispatcher confirmed the operation runs from a single origin
-- warehouse (KL) for now. Trips fan out by destination region:
--
--   WEST  → door-to-door multi-drop (existing logic)
--   EAST  → bundle to Port Klang, sea freight handles last mile
--   SG    → bundle to Johor hub (existing)
--
-- The state_warehouse_map is rewritten so geocoding always lands at
-- KL. The PG / EAST / SABAH / SARAWAK warehouse rows stay in the table
-- but are deactivated, so the dropdowns and existing trip references
-- keep working. A new "PORT_KLANG" row is added as the EAST drop point.
--
-- An `events` table is added for setup / dismantle calendar entries.
-- These are not tied to sales orders and are free-form (title, date,
-- address, status text, notes). Status validation is intentionally
-- absent until the dispatcher finalizes the lifecycle.
-- ═══════════════════════════════════════

-- ── Deactivate everything except KL + SG, then refresh KL info ────
UPDATE warehouses SET is_active = 0 WHERE code IN ('PG','EAST','SABAH','SARAWAK');
UPDATE warehouses SET name = 'KL Warehouse (origin)' WHERE code = 'KL';

-- ── Add Port Klang as the EAST transit drop ───────────────────────
INSERT OR IGNORE INTO warehouses (code, name, address, lat, lng, is_active) VALUES
  ('PORT_KLANG', 'Port Klang (East Malaysia transit)', 'Port Klang, Selangor', 3.0042, 101.3933, 1);

-- ── Rewrite the state map so every state lands at KL ──────────────
-- Origin is always KL for now. The destination logic (WEST/EAST/SG)
-- comes from sales_orders.region, which is set during the AutoCount
-- pull and is more reliable than parsing addresses.
DELETE FROM state_warehouse_map;
INSERT OR IGNORE INTO state_warehouse_map (state, warehouse) VALUES
  ('Kuala Lumpur',    'KL'),
  ('Selangor',        'KL'),
  ('Putrajaya',       'KL'),
  ('Negeri Sembilan', 'KL'),
  ('Melaka',          'KL'),
  ('Johor',           'KL'),
  ('Penang',          'KL'),
  ('Pulau Pinang',    'KL'),
  ('Kedah',           'KL'),
  ('Perlis',          'KL'),
  ('Perak',           'KL'),
  ('Kelantan',        'KL'),
  ('Terengganu',      'KL'),
  ('Pahang',          'KL'),
  ('Sabah',           'KL'),
  ('Labuan',          'KL'),
  ('Sarawak',         'KL'),
  ('Singapore',       'KL');

-- ── Remap any existing geocoded order_details rows ────────────────
-- All orders now ship from KL regardless of destination region.
UPDATE order_details
   SET warehouse = 'KL'
 WHERE warehouse IS NOT NULL AND warehouse != 'KL';

-- ── Move PG lorries to KL pool ────────────────────────────────────
-- The PG warehouse is inactive; the existing lorries are still part
-- of the fleet, just operating out of KL alongside the rest.
UPDATE lorries SET warehouse = 'KL' WHERE warehouse = 'PG' AND is_internal = 1;

-- ── Events (setup / dismantle calendar) ───────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('setup','dismantle')),
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,           -- YYYY-MM-DD
  address TEXT,
  status TEXT,                         -- free text for now (lifecycle TBD)
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
