# Houzs vs Hookka — next upgrades (gap analysis 2026-06-13)

Same platform DNA (CF Workers + Hono + Postgres/Hyperdrive). Excludes factory-floor
features Houzs doesn't need (BOM, job cards, payroll, QC scanning), GL delegated to
AutoCount, and what's already shipped (positions/User-Mgmt, idempotency, KV cache,
slow-query log, migration tracker, indexes, CI/bundle/smoke hardening). Ranked by value
then effort. Source: Hookka clone `hookka-audit` vs `Houzs-ERP-cutover`.

## Do first — high value
1. **Login / portal-token rate limiting** — value HIGH · effort **S** · risk low. Houzs **lacks** it
   (auth.ts has no lockout; track.ts even admits it). Port Hookka's KV-backed throttle
   (~80 lines): 10 attempts / 15 min, keyed email+IP on login, email on forgot-password,
   IP on the public survey/track/supplier-portal token endpoints. Fail-open if KV unbound.
   **The single cheapest security win** + blunts portal-token guessing.
2. **Durable email outbox + retry** — HIGH · **M** · low. Houzs **partial** (sends inline; a
   transient Resend 5xx or unset key = silently lost invite/reset/survey). Add `email_outbox`
   table; `sendEmail()` enqueues; a Cloudflare cron drains pending with 3 retries + backoff.
   Kills the "customer never got the survey/invite" tickets. (We just fixed which domain
   sends; this makes the *delivery* robust.)
3. **Global immutable audit trail (`audit_events`)** — HIGH · **M** · low. Houzs **partial**
   (only per-module feeds; no who-changed-what on finance/orders/**the new permission
   editor**). Add `audit_events` (resource, id, action, before/after, actor, source, ip) +
   `writeAudit()` helper, called from high-value mutations first (permission/position/role
   edits, user invite/disable, finance + petty cash, order status). Non-blocking.
4. **TOTP 2FA for admin/owner** — HIGH · **M** · risk medium. Houzs **lacks** (owner/director
   accounts = password only, yet they hold finance + the permission matrix + AutoCount push).
   Port Hookka's totp.ts; enforce for Owner/Director positions with a soft grace prompt.
   **Do after #1** (rate-limiting) — together they close the account-takeover path.

## Then — medium value
5. **Lightweight observability** — MED · **S** · low. Houzs **partial** (slow-query log only).
   One structured `[req]` log line/request (method, path, status, dur_ms, user) + a request
   id in responses; optional Sentry behind `SENTRY_DSN` (no-op when unset). ~60 lines.
6. **Event-driven supplier/customer notifications** — MED · **M** · low. Houzs **lacks** (PO
   submit / DO scheduled / case completed trigger no email). After #2, enqueue: PO submitted →
   supplier portal link, DO scheduled → customer ETA, case completed → survey link.
7. **OAuth (Google Workspace) SSO** — MED · **M** · medium. Houzs **lacks**. Convenience +
   central deprovisioning if staff live in Google Workspace. Link to existing users by verified
   email (don't auto-provision — keep invite/position as source of truth). After #1/#4.
8. **Keyset pagination + virtualized grids** — MED · **M** · low. Houzs **partial**. For lists
   that will grow (sales orders, ASSR). OFFSET is fine now; do when a list gets slow.

## Later — low value
9. **Richer PDF document generation** — LOW · **M** · low. Houzs **partial** (ASSR/event sheets
   only). More printable docs (PO, DO, quotation) if the business wants branded printouts.

## Recommended sequence
**Security+reliability batch (high value, mostly low risk):** #1 rate-limiting → #2 email outbox
→ #3 audit trail → #5 observability. Then #4 TOTP, #6 notifications (needs #2), #7 OAuth.
#8/#9 on demand.
