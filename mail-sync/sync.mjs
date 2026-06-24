// ---------------------------------------------------------------------------
// houzs-mail-sync — Gmail (Google Workspace) IMAP -> ERP inbound bridge
// ---------------------------------------------------------------------------
// The company mailbox lives on Google Workspace (Gmail). This script polls it
// over IMAP (READ-ONLY — it never alters \Seen, so the humans' unread counts
// are untouched) and POSTs every message to the ERP's secret-guarded endpoint
// POST /api/mail-center/inbound. That endpoint dedups by Message-ID, so
// re-fetching a recent window (or re-running a backfill) NEVER double-inserts.
//
// It is NOT part of the Cloudflare Worker bundle — it runs on a GitHub Actions
// cron (see ../.github/workflows/mail-sync.yml). The payload it POSTs is the
// ERP's InboundEmailPayload (see backend/src/routes/mail-center.ts); the same
// shape the standalone CF Email Worker would send, so receive works whichever
// path is active — with NO MX change required.
//
// Required env (GitHub Actions secrets — see README.md):
//   IMAP_USER            the Gmail address, e.g. hello@houzscentury.com
//   IMAP_PASSWORD        a Google App Password (NOT the account password)
//   MAIL_INBOUND_SECRET  shared secret; MUST equal the ERP's MAIL_INBOUND_SECRET (>= 16 chars)
//   MAIL_INBOUND_URL     the ERP worker, e.g.
//                        https://autocount-sync-api.houzs-erp.workers.dev/api/mail-center/inbound
// Optional env (sensible defaults):
//   IMAP_HOST / IMAP_PORT  default imap.gmail.com / 993
//   IMAP_MAILBOX           IMAP folder to read (default INBOX)
//   BACKFILL               "true"/"1" => fetch ALL history once; else incremental
//   SINCE_DAYS             incremental look-back window in days (default 3)
// ---------------------------------------------------------------------------

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const MAIL_INBOUND_URL =
  (process.env.MAIL_INBOUND_URL || "").trim() ||
  "https://autocount-sync-api.houzs-erp.workers.dev/api/mail-center/inbound";
const SECRET = (process.env.MAIL_INBOUND_SECRET || "").trim();
const IMAP_HOST = (process.env.IMAP_HOST || "").trim() || "imap.gmail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993) || 993;
const IMAP_USER = (process.env.IMAP_USER || "").trim();
const IMAP_PASSWORD = process.env.IMAP_PASSWORD || "";
const IMAP_MAILBOX = (process.env.IMAP_MAILBOX || "").trim() || "INBOX";
const BACKFILL = /^(1|true|yes)$/i.test(process.env.BACKFILL || "");
const SINCE_DAYS = Number(process.env.SINCE_DAYS || 3) || 3;

if (SECRET.length < 16) {
  console.error(
    "FATAL: MAIL_INBOUND_SECRET is unset or < 16 chars. Set it as a GitHub secret AND on the ERP worker (Cloudflare) — the two MUST match.",
  );
  process.exit(1);
}
if (!IMAP_USER || !IMAP_PASSWORD) {
  console.error(
    "FATAL: IMAP_USER and IMAP_PASSWORD must be set (IMAP_PASSWORD is a Google App Password).",
  );
  process.exit(1);
}

// Flatten mailparser address objects (from/to/cc) to bare "user@host" strings.
// mailparser returns { value: [{ address, name }], text, html } for each.
function addrList(field) {
  if (!field) return [];
  const value = Array.isArray(field) ? field : field.value;
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const a of value) {
    if (a && a.address) out.push(String(a.address).trim());
    if (a && a.group) out.push(...addrList({ value: a.group }));
  }
  return out.filter(Boolean);
}

function firstAddress(field) {
  const list = addrList(field);
  return list.length ? list[0] : "";
}

function firstName(field) {
  if (!field) return undefined;
  const value = Array.isArray(field) ? field : field.value;
  if (Array.isArray(value) && value[0] && value[0].name) {
    const n = String(value[0].name).trim();
    return n || undefined;
  }
  return undefined;
}

// Per-attachment and per-message size caps. We base64-encode attachment bytes
// into the JSON POST, so we cap individual files at ~8 MB and the TOTAL across
// one message at ~15 MB to keep the request body sane. Anything over is dropped
// (logged) — the ERP stores the email regardless; only the oversized file is
// skipped.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Build the ERP attachments payload from mailparser's parsed.attachments.
// Each item: { filename, contentType, contentId, contentBase64 }. Drops files
// over MAX_ATTACHMENT_BYTES or once the running total exceeds the message cap.
function toAttachments(parsed) {
  const list = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  if (list.length === 0) return undefined;
  const out = [];
  let total = 0;
  for (const att of list) {
    const buf = att && att.content;
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) continue;
    const filename = (att && att.filename) || "attachment";
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      console.warn(
        `  SKIP attachment "${filename}" — ${buf.length} bytes > ${MAX_ATTACHMENT_BYTES} cap`,
      );
      continue;
    }
    if (total + buf.length > MAX_TOTAL_ATTACHMENT_BYTES) {
      console.warn(
        `  SKIP attachment "${filename}" — message total would exceed ${MAX_TOTAL_ATTACHMENT_BYTES} cap`,
      );
      continue;
    }
    total += buf.length;
    out.push({
      filename,
      contentType: (att && att.contentType) || "application/octet-stream",
      contentId: (att && att.contentId) || undefined,
      contentBase64: buf.toString("base64"),
    });
  }
  return out.length ? out : undefined;
}

async function postToErp(payload) {
  const res = await fetch(MAIL_INBOUND_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mail-secret": SECRET },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `ERP POST ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }
  return res.json().catch(() => ({}));
}

// Build the ERP InboundEmailPayload. We PREPEND the mailbox we fetched this
// message FROM to `to`, guaranteeing it is the first recipient on our domain so
// the ERP attributes the thread to the correct mailbox even when the original
// To: was a list, a BCC, or a forward.
function toPayload(parsed, sourceMailbox) {
  const from = firstAddress(parsed.from);
  const fromName = firstName(parsed.from);
  const parsedTo = addrList(parsed.to);
  const to = [
    sourceMailbox,
    ...parsedTo.filter((x) => x.toLowerCase() !== sourceMailbox.toLowerCase()),
  ];
  const cc = addrList(parsed.cc);
  // mailparser exposes references as string | string[]; normalise to string[].
  let references;
  if (Array.isArray(parsed.references)) {
    references = parsed.references.map((s) => String(s).trim()).filter(Boolean);
  } else if (typeof parsed.references === "string") {
    references = parsed.references
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const date =
    parsed.date instanceof Date
      ? parsed.date.toISOString()
      : parsed.date || undefined;
  return {
    from,
    fromName,
    to,
    cc: cc.length ? cc : undefined,
    subject: parsed.subject || undefined,
    text: parsed.text || undefined,
    html: parsed.html || undefined,
    messageId: parsed.messageId || undefined,
    inReplyTo: parsed.inReplyTo || undefined,
    references: references && references.length ? references : undefined,
    date,
    attachments: toAttachments(parsed),
  };
}

async function syncMailbox() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
  });
  let total = 0;
  let added = 0;
  let deduped = 0;
  let failed = 0;
  await client.connect();
  try {
    // readOnly (EXAMINE) + source uses BODY.PEEK[] — two layers of guarantee
    // that we never flip \Seen on the humans' mailbox.
    const lock = await client.getMailboxLock(IMAP_MAILBOX, { readOnly: true });
    try {
      let range = null;
      let useUid = false;
      if (BACKFILL) {
        range = "1:*"; // every message, one-time history import (sequence range)
      } else {
        const since = new Date(Date.now() - SINCE_DAYS * 86_400_000);
        const uids = await client.search({ since }, { uid: true });
        if (uids && uids.length) {
          range = uids;
          useUid = true;
        }
      }
      if (range) {
        for await (const msg of client.fetch(
          range,
          { source: true },
          useUid ? { uid: true } : {},
        )) {
          total++;
          try {
            if (!msg.source) {
              failed++;
              continue;
            }
            const parsed = await simpleParser(msg.source);
            const payload = toPayload(parsed, IMAP_USER);
            if (!payload.from) {
              failed++;
              continue;
            }
            const r = await postToErp(payload);
            if (r && r.deduped) deduped++;
            else added++;
          } catch (e) {
            failed++;
            console.error(`  msg fail:`, (e && e.message) || e);
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  console.log(
    `${IMAP_USER}: ${total} seen, ${added} new, ${deduped} dup, ${failed} failed`,
  );
}

let anyHardFail = false;
try {
  await syncMailbox();
} catch (e) {
  anyHardFail = true;
  console.error(`MAILBOX ${IMAP_USER} FAILED:`, (e && e.message) || e);
}
console.log(
  `Done. mode=${BACKFILL ? "BACKFILL(all)" : `incremental(${SINCE_DAYS}d)`} -> ${MAIL_INBOUND_URL}`,
);
process.exit(anyHardFail ? 1 : 0);
