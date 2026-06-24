# houzs-mail-sync — Gmail IMAP -> ERP

Pulls mail from the company **Gmail (Google Workspace)** mailbox into the ERP
Mail Center — with **no MX change**.

The mailbox (e.g. `hello@houzscentury.com`) stays on Google Workspace. This job
connects over **IMAP, read-only** (it never marks your mail as read) and POSTs
every message to the ERP's `POST /api/mail-center/inbound`. The ERP **dedups by
Message-ID**, so re-running — including the one-time history backfill — never
creates duplicates.

It runs on a **GitHub Actions cron** (`.github/workflows/mail-sync.yml`), every
5 minutes. It is NOT part of the Cloudflare Worker — it's an independent Node
script, so it can use the mature `imapflow` IMAP client + `mailparser`.

This replaces the need for a Cloudflare Email-Routing / MX-cutover path: the
mail stays on Gmail, the ERP just reads it. Both paths feed the same ingest.

## One-time setup

### 1. Pick a shared secret

Generate a random string **>= 16 chars** (the inbound secret). You set the
**same value** in two places:

- **GitHub** -> repo **Settings -> Secrets and variables -> Actions -> New repository secret**
  - `MAIL_INBOUND_SECRET` = _that string_
- **The ERP worker** (Cloudflare) -> set `MAIL_INBOUND_SECRET` as a Worker
  secret (`wrangler secret put MAIL_INBOUND_SECRET`, or via the dashboard) =
  _the same string_. The ERP returns **503** on `/api/mail-center/inbound` until
  this is set and >= 16 chars, and **401** if the header doesn't match.

### 2. Create a Google App Password for the mailbox

The mailbox account needs **2-Step Verification** enabled, then create an
**App Password** (Google Account -> Security -> App passwords). Use that 16-char
app password as `IMAP_PASSWORD` — NOT the normal account password. IMAP must be
enabled in Gmail settings (Workspace admins: ensure IMAP access is allowed).

### 3. Add the GitHub secrets

Repo **Settings -> Secrets and variables -> Actions**:

| Secret name | Value |
|---|---|
| `MAIL_INBOUND_SECRET` | the shared secret from step 1 (also on the ERP worker) |
| `IMAP_USER` | the Gmail address, e.g. `hello@houzscentury.com` |
| `IMAP_PASSWORD` | the Google **App Password** from step 2 |

Optional repo **Variable** (not a secret) — only if you want a non-default URL:

| Variable name | Value |
|---|---|
| `MAIL_INBOUND_URL` | defaults to `https://autocount-sync-api.houzs-erp.workers.dev/api/mail-center/inbound` |

Other defaults you usually don't touch (override via repo **Variables**):
`IMAP_HOST` = `imap.gmail.com`, `IMAP_PORT` = `993`, `IMAP_MAILBOX` = `INBOX`.

## First run (import history)

Actions tab -> **Mail Sync (Gmail IMAP -> ERP)** -> **Run workflow** ->
tick **backfill** -> Run. This imports all existing INBOX mail. Watch the run
log for the per-mailbox summary (`N seen, N new, N dup, N failed`).

After that, leave it — the cron keeps pulling new mail every 5 minutes.

> **Cron + branch:** scheduled runs only fire from the repo's **default** branch.
> To test on a feature branch first, use **Run workflow** (manual) and pick that
> branch — it runs this file from whatever branch you select. Once the workflow
> file is on the default branch, the 5-minute cron is automatic.

## Notes / limits

- **Read-only**: opens the folder with EXAMINE and fetches with `BODY.PEEK[]`,
  so unread counts in Gmail are never touched.
- **Incremental window**: each cron run fetches the last `SINCE_DAYS` (default 3)
  and relies on Message-ID dedup — robust against missed ticks / downtime.
- **INBOX only** for now (incoming mail). To mirror mail sent from Gmail webmail,
  point `IMAP_MAILBOX` at `[Gmail]/Sent Mail` in a second job later.
- This handles **receive**. Sending from the ERP is a separate path (the Mail
  Center send flow).
