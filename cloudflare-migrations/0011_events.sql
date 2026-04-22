-- Events table — exhibition / solo roadshow projects.
-- Mirrors HouzsEvent interface in src/lib/mock-data.ts. The `a42` is the
-- compound natural key (YEAR-MM-ORGANIZER-STATE-VENUE-BRAND).

CREATE TABLE IF NOT EXISTS events (
  a42                        TEXT PRIMARY KEY,
  status                     TEXT NOT NULL DEFAULT 'CONFIRMED',     -- CONFIRMED / PENDING / CANCELLED
  progress                   TEXT NOT NULL DEFAULT 'NOT STARTED',   -- NOT STARTED / IN PROGRESS / COMPLETED
  year                       INTEGER NOT NULL,
  month                      TEXT NOT NULL,
  start_date                 TEXT NOT NULL,                         -- ISO yyyy-mm-dd
  end_date                   TEXT NOT NULL,
  duration_days              INTEGER NOT NULL DEFAULT 1,
  organizer                  TEXT NOT NULL,
  state                      TEXT NOT NULL,
  venue                      TEXT NOT NULL,
  brand                      TEXT NOT NULL,
  event_type                 TEXT NOT NULL,                         -- SOLO / EXHIBITION
  contractor                 TEXT,
  -- PM workflow flags (TRUE / FALSE / DONE / "NO NEED" / "")
  agreement_approval         TEXT,
  floorplan                  TEXT,
  booth_no                   TEXT,
  size_sqm                   REAL NOT NULL DEFAULT 0,
  send_floorplan_to_designer TEXT,
  three_d_checked_by_mgt     TEXT,
  three_d_approved_by_peter  TEXT,
  three_d_uploaded_in_notion TEXT,
  weekend_activity_theme     TEXT,
  license_majlis             TEXT,
  work_loading_bay_permit    TEXT,
  deco_coffee_table          TEXT,
  sec_depo_refund            TEXT,
  -- Financials
  total_sales_rm             REAL NOT NULL DEFAULT 0,
  rental_rm                  REAL NOT NULL DEFAULT 0,
  -- Integration / misc
  link_notion                TEXT,
  gcal_id                    TEXT,
  pic                        TEXT,
  bd_pic                     TEXT,
  sales_pic                  TEXT,
  preparation_condition      TEXT,
  setup_driver               TEXT,
  setup_lori                 TEXT,
  setup_datetime             TEXT,
  dismantle_datetime         TEXT,
  setup_dismantle_status     TEXT,
  -- JSON-serialised arrays
  assigned_sales             TEXT NOT NULL DEFAULT '[]',
  setup_drivers              TEXT NOT NULL DEFAULT '[]',
  setup_loris                TEXT NOT NULL DEFAULT '[]',
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_start   ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_year    ON events(year);
CREATE INDEX IF NOT EXISTS idx_events_status  ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_brand   ON events(brand);
CREATE INDEX IF NOT EXISTS idx_events_state   ON events(state);
CREATE INDEX IF NOT EXISTS idx_events_venue   ON events(venue);
