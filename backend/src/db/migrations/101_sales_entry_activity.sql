-- 101_sales_entry_activity.sql
--
-- Boss-requested: full edit history on sales entries — who touched the
-- entry and when (Created by … / Edited by … · date-time). Append-only
-- audit trail, one row per action.

CREATE TABLE IF NOT EXISTS sales_entry_activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL,
  user_id    INTEGER,
  action     TEXT NOT NULL,            -- created | edited | submitted | unsubmitted | voided | pushed | deleted
  note       TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sales_entry_activity_entry
  ON sales_entry_activity(entry_id, created_at);
