-- App-wide settings stored as key / JSON-value rows. Used for anything that's
-- admin-configurable but not per-user (positions list, default commission
-- tiers, etc.). Each value is stored as a JSON string; consumers parse.
--
-- Seeded with the same defaults the frontend used to hard-code in
-- sales-store.ts so the migration is a no-op for existing tenants.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('positions',          '["Sales Director","Sales Manager","Sales Executive","Sales Trainee"]'),
  ('default_commission', '[{"threshold":0,"pct":5},{"threshold":300000,"pct":6},{"threshold":500000,"pct":7}]');
