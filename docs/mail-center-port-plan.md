# Wave B — Mail Center port plan (Hookka -> Houzs)

Port the Hookka Mail Center (shared inbox: Cloudflare Email Routing + Brevo + Supabase)
into Houzs. Do AFTER Wave A (POM tidy) + the Branding config. Owner confirmed access:
gh is authed as weisiang329-eng (repo scope); the source repo is PUBLIC.

## Source — weisiang329-eng/hookka-erp-testing @ main

| Layer | Files |
|---|---|
| Frontend | `src/pages/mail-center/`: index.tsx (inbox), detail.tsx, compose.tsx, mail-actions.ts, mail-labels.ts, mail-prefs.ts, mail-local.ts, mail-from-default.ts |
| Backend | `src/api/routes/mail-center.ts`; `src/api/lib/`: email.ts, email-outbox.ts, mail-attachments.ts |
| Migrations | `migrations-postgres/`: 0081_email_outbox.sql, 0171_email_labels.sql (0163 = consignment-dispatch email, port only if needed) |
| Inbound worker | `mail-inbound-worker/` (index.ts + wrangler.toml + README) — receives mail via CF Email Routing |
| Jobs | `mail-sync/` (sync.mjs); `.github/workflows/`: mail-sync.yml, process-email-outbox.yml |
| Tests | tests/mail-attachments.test.mjs, tests/mail-from-default.test.mjs, scripts/render-test-emails.mjs |

Pull a file: `gh api repos/weisiang329-eng/hookka-erp-testing/contents/<path> --jq .content | base64 -d`.

## Adapt to Houzs (do NOT blind-copy)

- **What Houzs already has** (reconcile, don't duplicate): an email-outbox + outbound email
  (Brevo/Resend, EMAIL_FROM=houzscentury.com — see project_houzs_security_upgrades #2 +
  project_houzs_doc_email). Reuse/extend Houzs's existing email lib + outbox; layer the
  Mail Center UI + inbound + labels on top.
- **Schema**: Houzs core = `public` (Hyperdrive/postgres.js, camelCase results), SCM = `scm`
  (PostgREST). Mail Center is a core feature -> `public` schema; port the migrations as Houzs
  numbered migrations (timestamp text cols, not timestamptz — the mig-0008 gotcha).
- **Auth**: use Houzs's auth bridge; mail scope via getMailScope (per-user mailbox), NOT
  requirePermission("mail-center") — that key is unseeded (the Hookka RBAC gotcha).
- **Inbound**: needs the MX cutover + the mail-inbound-worker deployed; domain-wide MX, so
  test via a sample POST first before flipping MX.
- **Brand/from**: mail-from-default + aliases must read Houzs Branding (Houzs Century,
  houzscentury.com), not Hookka — ties into the Branding config (Wave A.5).

## User Management — Email Alias column (this wave)

Members already carry their own Email + Department + Role. Add an **Email Alias** column
(like Hookka) so each member gets an assigned alias address. Email Access permission =
deferred (owner: "之后再整理"). Set the mailbox password together with the owner (manual).

## Deploy

Backend worker via wrangler; frontend manually (Pages Git integration still mis-deploys —
disconnect pending). Migrations applied BEFORE the code deploy (migrate-before-deploy).
