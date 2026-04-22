-- Houzs ERP — Auth & Audit schema
-- Adds: users (replaces localStorage sales-store), invitations, password_resets,
-- login_attempts (rate limiting), audit_log.

-- ── Users (sales team + auth fields) ────────────────────────────────────────
-- Replaces the localStorage-backed sales-store.ts persistence.
-- Same shape as SalesMember interface + auth columns.
CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,       -- "dir-kingsley", "exe-shawn"
  name                   TEXT NOT NULL,
  code                   TEXT,                   -- short display code
  email                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone                  TEXT,
  ic                     TEXT,
  position               TEXT NOT NULL,          -- Sales Director / Manager / Executive / Trainee
  parent_id              TEXT,                   -- main upline (self-ref, nullable)
  additional_parent_ids  TEXT,                   -- JSON array of extra upline ids
  join_date              TEXT,
  status                 TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE / INACTIVE / PENDING
  assigned_brands        TEXT NOT NULL DEFAULT '[]',      -- JSON array of Brand strings
  commission_tiers       TEXT NOT NULL DEFAULT '[]',      -- JSON array
  min_rate               REAL NOT NULL DEFAULT 0,
  notes                  TEXT,
  -- Auth fields
  password_hash          TEXT,                   -- PBKDF2 hash, NULL until first login set
  password_salt          TEXT,                   -- 16-byte random salt, base64
  must_change_password   INTEGER NOT NULL DEFAULT 0,   -- 1 = force change on next login
  last_login             TEXT,                   -- ISO datetime of last successful login
  locked_until           TEXT,                   -- ISO datetime, set after too many failed attempts
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_position ON users(position);
CREATE INDEX IF NOT EXISTS idx_users_parent   ON users(parent_id);
CREATE INDEX IF NOT EXISTS idx_users_status   ON users(status);

-- ── Invitations (invite flow with temp password) ────────────────────────────
-- One row per invite sent. Temp password hash lives in users.password_hash so
-- this table just tracks the invite event (audit + expiry + resend).
CREATE TABLE IF NOT EXISTS invitations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  invited_by    TEXT,                            -- admin user_id who sent it
  expires_at    TEXT NOT NULL,                   -- ISO datetime (7 days from send)
  used_at       TEXT,                            -- set when user completes first login
  resent_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_user ON invitations(user_id);

-- ── Password resets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_resets (
  token       TEXT PRIMARY KEY,          -- URL-safe random token (in email link)
  user_id     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,             -- 1 hour from send
  used_at     TEXT,
  ip_address  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

-- ── Login attempts (rate limiting + audit) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL COLLATE NOCASE,
  user_id     TEXT,                              -- resolved only on success
  ip_address  TEXT,
  user_agent  TEXT,
  success     INTEGER NOT NULL DEFAULT 0,        -- 0 = failed, 1 = success
  reason      TEXT,                              -- wrong_password / no_user / locked / expired_invite
  timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email, timestamp);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time    ON login_attempts(ip_address, timestamp);

-- ── Audit log (every create/update/delete + auth events) ───────────────────
-- Append-only; never deleted. ~200 bytes/row, plenty of room in D1.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,                            -- NULL for anonymous events (e.g. failed login)
  user_name     TEXT,                            -- denormalised so deleted users still show
  user_position TEXT,                            -- "Sales Director" at time of event
  action        TEXT NOT NULL,                   -- create/update/delete/login/login_failed/logout/invite/reset_password/enable/disable
  entity_type   TEXT,                            -- sku / so_header / so_line / payment / user / fabric / variants_config
  entity_id     TEXT,                            -- FK id or natural key (SO-011460, sku-0099)
  field         TEXT,                            -- single field name for simple updates
  old_value     TEXT,
  new_value     TEXT,
  changes_json  TEXT,                            -- full diff JSON for multi-field updates
  ip_address    TEXT,
  user_agent    TEXT,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user      ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity    ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action    ON audit_log(action);
