-- 0146_push_device_tokens.sql — APNs device tokens for the iOS shell.
--
-- WHY THIS EXISTS. Notifications reach the browser through ONE mechanism: the
-- 30s poll of GET /api/notifications, whose result BrowserPushSink turns into a
-- Web Notification() banner. Inside WKWebView the Notification constructor does
-- not exist and the poll stops the moment iOS suspends the app, so the native
-- shell delivers NOTHING. Apple's push service is the only way to reach a
-- backgrounded iOS app, and it addresses a DEVICE, not a user — so the server
-- has to hold the device tokens. That is all this table is.
--
-- ── THE UNIQUENESS RULE IS ON token ALONE, AND THAT IS THE WHOLE DESIGN ──
-- An APNs token identifies one install of one app on one physical device. It is
-- NOT a per-user value: it is minted by iOS before anyone signs in, and it
-- survives sign-out. Two facts follow, and a naive UNIQUE (user_id, token)
-- gets both wrong.
--
--   1. One device must never accumulate rows. The app re-registers on every
--      cold start, so anything other than an upsert on the token grows one row
--      per launch and every notification is then delivered N times to the same
--      handset. UNIQUE (token) makes the repeat registration an UPDATE.
--
--   2. A token MOVES between users. Staff here share handsets — a warehouse
--      iPad is signed in by whoever is on shift. If user A signs out and user B
--      signs in, the token is now B's device, and A must stop receiving on it.
--      With UNIQUE (token) the upsert reassigns user_id and A's row is gone by
--      construction. With UNIQUE (user_id, token) both rows survive and the
--      device would show A's notifications to B — a data-leak, not a nuisance.
--
-- The tradeoff is accepted deliberately: a user cannot own the same token
-- twice, which is exactly the invariant we want, and the "user has many
-- devices" case is still a plain one-to-many on user_id.
--
-- ── disabled_at, NOT DELETE, FOR APNs FEEDBACK ──
-- APNs answers 410 Unregistered when the app has been deleted from the handset.
-- The send path stamps disabled_at instead of deleting so a token that comes
-- back (app reinstalled, same token) is reactivated by the same upsert rather
-- than silently re-created, and so a dead-token spike is visible rather than
-- being an absence of rows. An explicit sign-out DELETEs — that one is a
-- privacy action, and a soft-deleted row on a shared device is the leak above.
--
-- TEXT TIMESTAMPS, per the rule mig 0008 established for the public schema:
-- every *_at column here is text holding a UTC string, and the DEFAULT is the
-- same to_char(now() AT TIME ZONE 'UTC', ...) shape schema.pg.ts's `nowText`
-- emits. NOT timestamptz, and emphatically NOT SQLite's datetime('now') — that
-- function does not exist in Postgres and would fail this file, which under the
-- deploy's auto-apply blocks EVERY subsequent deploy until prod is hand-patched.
--
-- NO FOREIGN KEY to users. Nothing in migrations-pg references users(id) — the
-- table arrived through the D1 import and the tree has never asserted an FK
-- against it. Adding the first one here would make this migration's success
-- depend on a constraint state no other file establishes. Orphan rows are
-- handled where they matter: the send path joins users and skips inactive ones.
--
-- HOUSE STYLE (0130/0139/0144): additive, IF NOT EXISTS, plain statements, no
-- dollar-quoted blocks (the pg-migrate runner splits each file on ";\n"), no
-- demo or seed rows.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS push_device_tokens (
  id           bigserial PRIMARY KEY,
  user_id      integer NOT NULL,
  -- The APNs device token, lowercase hex. Length is not pinned: Apple has
  -- changed it before (32 -> 32+ bytes) and a CHECK on length would turn a
  -- future widening into a registration outage.
  token        text NOT NULL,
  platform     text NOT NULL DEFAULT 'ios',
  -- The apns-topic the token was registered under. Stored rather than assumed
  -- because a TestFlight build and the App Store build are different bundle ids
  -- and a push sent to the wrong topic is rejected, not misdelivered.
  bundle_id    text,
  -- 'production' or 'sandbox'. A token minted by a development build is only
  -- valid against api.sandbox.push.apple.com; sending it to the production host
  -- returns BadDeviceToken. Nullable: the send path falls back to the Worker's
  -- configured environment when the client did not say.
  apns_env     text,
  app_version  text,
  device_model text,
  created_at   text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at   text NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- Stamped on every re-registration, so a token that has not been seen in
  -- months can be retired without guessing from created_at.
  last_seen_at text,
  -- Set when APNs reports the token is gone (410 Unregistered / BadDeviceToken).
  disabled_at  text
);

-- The upsert target. See the uniqueness note above: this is the constraint that
-- both collapses repeat registrations and moves a shared device to its current
-- signed-in user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_push_device_tokens_token
  ON push_device_tokens (token);

-- The only read the send path makes: every live token for one user. Partial,
-- because a disabled token is never an answer to it.
CREATE INDEX IF NOT EXISTS idx_push_device_tokens_user_live
  ON push_device_tokens (user_id)
  WHERE disabled_at IS NULL;
