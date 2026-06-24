// ---------------------------------------------------------------------------
// Mail Center — in-ERP shared inbox for the company's email.
//
// Ported from Hookka (src/api/routes/mail-center.ts). Adaptations for Houzs:
//   • SINGLE-TENANT — every org_id / getOrgId / DEFAULT_ORG_ID is DROPPED.
//   • Houzs is snake_case (postgres.js, NO camelCase transform), so the row
//     mappers read PLAIN snake_case columns — the Hookka `r.camelCase ??
//     r.snake_case` dual-reads are removed.
//   • Query API: c.env.DB.prepare().bind().first()/.all()/.run() (d1-compat shim).
//   • Outbound send uses Houzs sendEmail (Resend) — NOT Hookka sendMail/Brevo.
//   • Attachments live in R2 (POD_BUCKET) and stream through an authed route
//     (GET /attachments/:id) — no Supabase Storage, no signed URLs.
//   • Auth: c.get("user") = AuthUser{ id:number, permissions[], ... }; super-admin
//     = permissions.includes("*") || mail_center.manage. Admin endpoints
//     (addresses / access / scope-level) are gated by requirePermission, mounted
//     in index.ts; reads/reply/compose/star/label/trash gate on mailbox SCOPE
//     ownership (a non-owner gets 404), NOT a permission key.
//   • From-default + the inbound mailbox domain read getBranding(env), never a
//     literal.
//   • Schema is a real migration (0039) applied before deploy — there is NO
//     runtime self-apply.
//
// Timestamp columns are TEXT, written via new Date().toISOString() (per mig 0008).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthUser } from "../services/auth";
import { hasPermission } from "../services/permissions";
import { sendEmail } from "../services/email";
import { getBranding } from "../services/branding";
import { validateMailAttachments } from "../lib/mail-attachments";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Inbound ingestion — called by the pre-auth /inbound route (routes/mail-inbound.ts)
// and by the admin test-inject endpoint below.
// ---------------------------------------------------------------------------
// One inbound attachment as it arrives on the /inbound payload. The sync layer
// base64-encodes the raw bytes so the JSON POST stays credential-free; the ERP
// owns storage (uploads to R2 here). Oversized files are dropped at the sync
// layer, so contentBase64 is always sane to decode in the Worker.
export interface InboundAttachmentPayload {
  filename?: string;
  contentType?: string;
  contentId?: string;
  contentBase64?: string;
}

export interface InboundEmailPayload {
  from?: string;
  fromName?: string;
  to?: string[] | string;
  cc?: string[] | string;
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[] | string;
  date?: string;
  attachments?: InboundAttachmentPayload[];
}

export type IngestResult =
  | { ok: true; threadId: string; messageId: string; deduped?: boolean }
  | { ok: false; error: string };

function toArray(v: string[] | string | undefined | null): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  // RFC headers separate addresses with commas; References uses whitespace.
  return String(v)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeIso(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const t = Date.parse(input);
  if (Number.isNaN(t)) return fallback;
  return new Date(t).toISOString();
}

// Decode standard base64 into raw bytes. Tolerant of base64url and stray
// whitespace/newlines. Returns null on anything that doesn't decode so a single
// bad attachment never aborts the whole email.
function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const clean = b64.replace(/[\r\n\s]+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Sanitise a filename for use inside an R2 object key: strip any path segments
// (no traversal), keep a readable ASCII-ish basename, bound the length.
function safeFilename(name: string | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() || "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || "file";
}

// Persist the attachments for one freshly-stored (or backfilled) message: upload
// each file's bytes to R2 (POD_BUCKET) and INSERT an email_attachments row.
// Best-effort per attachment — a single failed upload/insert is logged and
// skipped so the rest of the email is unaffected. No-op when there is no bucket
// or no attachments. R2 key scheme: mail/{messageId}/{n}-{safeFilename}.
async function storeAttachments(
  db: D1Database,
  env: Env | undefined,
  msgRowId: string,
  attachments: InboundAttachmentPayload[] | undefined,
): Promise<void> {
  if (!attachments || attachments.length === 0) return;
  if (!env?.POD_BUCKET) {
    console.warn(
      "[mail-center] attachments present but POD_BUCKET not configured — skipping",
    );
    return;
  }
  const now = new Date().toISOString();
  let idx = 0;
  for (const att of attachments) {
    idx++;
    const bytes = base64ToBytes(att.contentBase64 ?? "");
    if (!bytes || bytes.length === 0) {
      console.warn(
        `[mail-center] attachment ${idx} on ${msgRowId} had no decodable content — skipping`,
      );
      continue;
    }
    const fname = safeFilename(att.filename);
    const contentType = (att.contentType || "application/octet-stream").slice(0, 200);
    // Prefix each file with its index so two same-named files on one email don't
    // collide on the same R2 key.
    const storagePath = `mail/${msgRowId}/${idx}-${fname}`;
    try {
      await env.POD_BUCKET.put(storagePath, bytes, {
        httpMetadata: { contentType },
      });
      await db
        .prepare(
          `INSERT INTO email_attachments
             (id, message_id, filename, content_type, size_bytes,
              storage_path, content_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          msgRowId,
          att.filename ?? fname,
          contentType,
          bytes.length,
          storagePath,
          att.contentId ?? null,
          now,
        )
        .run();
    } catch (e) {
      console.error(
        `[mail-center] failed to store attachment ${idx} on ${msgRowId}:`,
        e,
      );
    }
  }
}

// The inbound mailbox domain (e.g. "houzscentury.com") comes from the central
// Branding config — never a literal. Falls back to houzscentury.com if Branding
// is unreadable (getBranding never throws).
async function brandingDomain(env: Env | undefined): Promise<string> {
  if (!env) return "houzscentury.com";
  try {
    const branding = await getBranding(env);
    return (branding.email.split("@")[1] || "houzscentury.com").trim().toLowerCase();
  } catch {
    return "houzscentury.com";
  }
}

export async function ingestInboundEmail(
  db: D1Database,
  payload: InboundEmailPayload,
  // Env carries the R2 binding for attachment storage + Branding for the inbound
  // domain. Absent => attachments are skipped, the message itself still stores.
  env?: Env,
): Promise<IngestResult> {
  const from = (payload.from || "").trim();
  if (!from) return { ok: false, error: "missing from address" };

  const to = toArray(payload.to);
  const cc = toArray(payload.cc);
  const recipients = [...to, ...cc];

  // Which of OUR addresses did this hit? Prefer an explicit email_addresses
  // match, else the first recipient on our branding domain, else the first to:.
  let mailbox = "";
  for (const r of recipients) {
    const hit = await db
      .prepare(
        `SELECT address FROM email_addresses WHERE lower(address) = lower(?) LIMIT 1`,
      )
      .bind(r)
      .first<{ address: string }>();
    if (hit?.address) {
      mailbox = hit.address;
      break;
    }
  }
  if (!mailbox) {
    const domain = await brandingDomain(env);
    mailbox =
      recipients.find((r) => r.toLowerCase().endsWith(`@${domain}`)) ||
      recipients[0] ||
      "";
  }

  const now = new Date().toISOString();
  const sentAt = safeIso(payload.date, now);
  const subject = (payload.subject || "(no subject)").slice(0, 500);
  const snippet = (payload.text || stripHtml(payload.html || "") || "")
    .trim()
    .slice(0, 240);

  // Idempotency — the inbound worker may retry. Skip if we already stored this
  // Message-ID. BUT: if the existing message has NO attachments yet and this
  // (re)delivery carries some, backfill them onto the already-ingested message.
  if (payload.messageId) {
    const dup = await db
      .prepare(
        `SELECT id, thread_id FROM email_messages WHERE message_id = ? LIMIT 1`,
      )
      .bind(payload.messageId)
      .first<{ id: string; thread_id?: string }>();
    if (dup?.id) {
      if (payload.attachments && payload.attachments.length > 0) {
        const existing = await db
          .prepare(
            `SELECT COUNT(*) AS n FROM email_attachments WHERE message_id = ?`,
          )
          .bind(dup.id)
          .first<{ n?: number | string }>();
        const have = Number(existing?.n ?? 0);
        if (have === 0) {
          await storeAttachments(db, env, dup.id, payload.attachments);
        }
      }
      return {
        ok: true,
        threadId: dup.thread_id ?? "",
        messageId: dup.id,
        deduped: true,
      };
    }
  }

  // Thread resolution: follow In-Reply-To / References back to an existing
  // message's thread. Otherwise start a new thread.
  let threadId = "";
  const refs = [payload.inReplyTo, ...toArray(payload.references)].filter(
    Boolean,
  ) as string[];
  if (refs.length) {
    const placeholders = refs.map(() => "?").join(", ");
    const ref = await db
      .prepare(
        `SELECT thread_id FROM email_messages WHERE message_id IN (${placeholders}) LIMIT 1`,
      )
      .bind(...refs)
      .first<{ thread_id?: string }>();
    if (ref?.thread_id) threadId = ref.thread_id;
  }

  if (!threadId) {
    threadId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO email_threads
           (id, mailbox_address, subject, counterparty_email,
            counterparty_name, status, last_message_at, last_direction,
            last_snippet, message_count, unread, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, 'inbound', ?, 1, 1, ?)`,
      )
      .bind(
        threadId,
        mailbox,
        subject,
        from,
        payload.fromName ?? null,
        sentAt,
        snippet,
        now,
      )
      .run();
  } else {
    // Re-open a closed thread when a new inbound message lands.
    await db
      .prepare(
        `UPDATE email_threads
            SET last_message_at = ?, last_direction = 'inbound',
                last_snippet = ?, message_count = message_count + 1,
                unread = 1,
                status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
          WHERE id = ?`,
      )
      .bind(sentAt, snippet, threadId)
      .run();
  }

  const msgId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO email_messages
         (id, thread_id, direction, message_id, in_reply_to,
          reference_ids, from_address, from_name, to_addresses, cc_addresses,
          subject, text_body, html_body, sent_at, received_at, created_at)
       VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      msgId,
      threadId,
      payload.messageId ?? null,
      payload.inReplyTo ?? null,
      toArray(payload.references).join(" ") || null,
      from,
      payload.fromName ?? null,
      JSON.stringify(to),
      cc.length ? JSON.stringify(cc) : null,
      subject,
      payload.text ?? null,
      payload.html ?? null,
      sentAt,
      now,
      now,
    )
    .run();

  // Upload + index any attachments for this newly-stored message. Best-effort.
  await storeAttachments(db, env, msgId, payload.attachments);

  return { ok: true, threadId, messageId: msgId };
}

// ---------------------------------------------------------------------------
// Row -> API shape mappers. Houzs is snake_case (no camelCase transform), so
// these read plain snake columns. The API shape stays camelCase for the FE.
// ---------------------------------------------------------------------------
type ThreadRow = {
  id: string;
  mailbox_address: string | null;
  subject: string | null;
  counterparty_email: string | null;
  counterparty_name: string | null;
  status: string;
  assigned_to_user_id: number | null;
  assigned_to_name: string | null;
  last_message_at: string | null;
  last_direction: string | null;
  last_snippet: string | null;
  message_count: number | string | null;
  unread: number | boolean | null;
  starred: number | boolean | null;
  labels: string | null;
  trashed_at: string | null;
  created_at: string | null;
  // Computed (not a column): EXISTS roll-up of any outbound message, so the
  // frontend's Sent folder is accurate instead of relying on last_direction.
  has_outbound?: number | boolean | null;
};

function rowToThread(r: ThreadRow) {
  return {
    id: r.id,
    mailboxAddress: r.mailbox_address ?? "",
    subject: r.subject ?? "(no subject)",
    counterpartyEmail: r.counterparty_email ?? "",
    counterpartyName: r.counterparty_name ?? "",
    status: r.status,
    assignedToUserId: r.assigned_to_user_id ?? undefined,
    assignedToName: r.assigned_to_name ?? undefined,
    lastMessageAt: r.last_message_at ?? "",
    lastDirection: r.last_direction ?? "inbound",
    lastSnippet: r.last_snippet ?? "",
    messageCount: Number(r.message_count ?? 0),
    unread: Number(r.unread ?? 0) === 1,
    starred: Number(r.starred ?? 0) === 1,
    labels: parseJsonArray(r.labels),
    trashedAt: r.trashed_at ?? null,
    hasOutbound: Number(r.has_outbound ?? 0) === 1,
    createdAt: r.created_at ?? "",
  };
}

type MessageRow = {
  id: string;
  thread_id: string;
  direction: string;
  message_id: string | null;
  in_reply_to: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  sent_at: string | null;
  received_at: string | null;
  sent_by_user_id: number | null;
  sent_by_name: string | null;
  created_at: string | null;
};

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToMessage(r: MessageRow) {
  return {
    id: r.id,
    threadId: r.thread_id,
    direction: r.direction,
    messageId: r.message_id ?? undefined,
    inReplyTo: r.in_reply_to ?? undefined,
    fromAddress: r.from_address ?? "",
    fromName: r.from_name ?? "",
    toAddresses: parseJsonArray(r.to_addresses),
    ccAddresses: parseJsonArray(r.cc_addresses),
    subject: r.subject ?? "",
    textBody: r.text_body ?? "",
    htmlBody: r.html_body ?? "",
    sentAt: r.sent_at ?? "",
    receivedAt: r.received_at ?? "",
    sentByUserId: r.sent_by_user_id ?? undefined,
    sentByName: r.sent_by_name ?? undefined,
    createdAt: r.created_at ?? "",
  };
}

// Attachment row -> API shape served on each message. `url` is the authed
// streaming route (GET /api/mail-center/attachments/:id), NOT a signed URL.
type AttachmentRow = {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | string | null;
  storage_path: string | null;
  content_id: string | null;
  message_id: string | null;
};

function attachmentToApi(r: AttachmentRow) {
  return {
    id: r.id,
    filename: r.filename ?? "file",
    contentType: r.content_type ?? "application/octet-stream",
    sizeBytes: Number(r.size_bytes ?? 0),
    contentId: r.content_id ?? undefined,
    // Authed stream route — the FE swaps this for a blob URL via the client's
    // authed fetch helper. No signed URL.
    url: `/api/mail-center/attachments/${r.id}`,
  };
}

type AddressRow = {
  id: string;
  address: string;
  label: string | null;
  assigned_user_id: number | null;
  assigned_user_name: string | null;
  assigned_dept: string | null;
  assigned_position: string | null;
  active: number | boolean | null;
  created_at: string | null;
};

function rowToAddress(r: AddressRow) {
  return {
    id: r.id,
    address: r.address,
    label: r.label ?? "",
    assignedUserId: r.assigned_user_id ?? undefined,
    assignedUserName: r.assigned_user_name ?? undefined,
    assignedDept: r.assigned_dept ?? undefined,
    assignedPosition: r.assigned_position ?? undefined,
    active: Number(r.active ?? 0) === 1,
    createdAt: r.created_at ?? "",
  };
}

type LabelRow = {
  id: string;
  name: string;
  color: string | null;
  created_at: string | null;
};

function rowToLabel(r: LabelRow) {
  return {
    id: r.id,
    name: r.name,
    color: r.color ?? "",
    createdAt: r.created_at ?? "",
  };
}

// ---------------------------------------------------------------------------
// Hierarchical mailbox visibility. Super-admin (permissions "*" or
// mail_center.manage) always sees every thread/address. Every other user has a
// VISIBILITY LEVEL in mail_user_scope (default 'personal'):
//   • 'personal'   — own assigned alias(es) + shared mailboxes granted via
//                    email_address_access.
//   • 'department' — the personal set PLUS every active mailbox whose
//                    assigned_dept matches the caller's own dept.
//   • 'company'    — every active mailbox.
// Inherently scoped to the caller — no broad RBAC grant required.
// ---------------------------------------------------------------------------
const MAIL_SCOPE_LEVELS = ["personal", "department", "company"] as const;
type MailScopeLevel = (typeof MAIL_SCOPE_LEVELS)[number];

// A user is a Mail Center admin (sees all) if they hold the "*" wildcard or the
// mail_center.manage permission.
function isMailAdmin(user: AuthUser | undefined): boolean {
  if (!user) return false;
  const granted = user.permissions_set ?? user.permissions;
  return (
    hasPermission(granted, "*") || hasPermission(granted, "mail_center.manage")
  );
}

async function getMailScope(c: Context<{ Bindings: Env }>): Promise<{
  isAdmin: boolean;
  userId: number | null;
  addresses: string[];
  level: string;
}> {
  const user = c.get("user");
  const userId = c.get("userId") ?? null;
  if (isMailAdmin(user))
    return { isAdmin: true, userId, addresses: [], level: "company" };
  if (!userId)
    return { isAdmin: false, userId: null, addresses: [], level: "personal" };

  const levelRow = await c.env.DB.prepare(
    `SELECT level FROM mail_user_scope WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ level: string | null }>();
  let level: MailScopeLevel = (MAIL_SCOPE_LEVELS as readonly string[]).includes(
    levelRow?.level ?? "",
  )
    ? (levelRow!.level as MailScopeLevel)
    : "personal";

  // 'company' — every active mailbox.
  if (level === "company") {
    const all = await c.env.DB.prepare(
      `SELECT address FROM email_addresses WHERE active = 1`,
    ).all<{ address: string }>();
    return {
      isAdmin: false,
      userId,
      addresses: dedupeLower((all.results ?? []).map((r) => r.address)),
      level,
    };
  }

  // 'personal' base set: own assigned alias(es) + granted shared mailboxes.
  const own = await c.env.DB.prepare(
    `SELECT address FROM email_addresses
       WHERE active = 1 AND (
         assigned_user_id = ?
         OR id IN (SELECT address_id FROM email_address_access WHERE user_id = ?)
       )`,
  )
    .bind(userId, userId)
    .all<{ address: string }>();
  const addresses = (own.results ?? []).map((r) => r.address);

  // 'department' — additionally every active mailbox in the caller's own dept.
  if (level === "department") {
    const deptRow = await c.env.DB.prepare(
      `SELECT assigned_dept FROM email_addresses
         WHERE assigned_user_id = ?
           AND assigned_dept IS NOT NULL AND assigned_dept <> '' LIMIT 1`,
    )
      .bind(userId)
      .first<{ assigned_dept?: string | null }>();
    const dept = (deptRow?.assigned_dept ?? "").trim();
    if (dept) {
      const deptRows = await c.env.DB.prepare(
        `SELECT address FROM email_addresses
           WHERE active = 1 AND assigned_dept = ?`,
      )
        .bind(dept)
        .all<{ address: string }>();
      addresses.push(...(deptRows.results ?? []).map((r) => r.address));
    } else {
      level = "personal";
    }
  }

  return { isAdmin: false, userId, addresses: dedupeLower(addresses), level };
}

// Lowercase + de-duplicate an address list (order-preserving).
function dedupeLower(addrs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const lc = (a ?? "").toLowerCase();
    if (!lc || seen.has(lc)) continue;
    seen.add(lc);
    out.push(lc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authenticated read endpoints (mounted at /api/mail-center, AFTER auth).
// Per-user scoped via getMailScope — every logged-in user reads THEIR OWN
// mailbox; admins read all.
// ---------------------------------------------------------------------------

// GET /api/mail-center/threads?mailbox=&status=&q=&starred=
app.get("/threads", async (c) => {
  const scope = await getMailScope(c);
  if (!scope.isAdmin && scope.addresses.length === 0) return c.json([]);

  const mailbox = c.req.query("mailbox");
  const status = c.req.query("status");
  const q = c.req.query("q");
  const starredOnly = c.req.query("starred") === "1";

  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (!scope.isAdmin) {
    const ph = scope.addresses.map(() => "?").join(", ");
    where.push(`LOWER(mailbox_address) IN (${ph})`);
    binds.push(...scope.addresses);
  }
  if (mailbox) {
    where.push("mailbox_address = ?");
    binds.push(mailbox);
  }
  // Trash is its own folder: status=trashed returns ONLY soft-deleted rows;
  // every other view EXCLUDES them.
  if (status === "trashed") {
    where.push("trashed_at IS NOT NULL");
  } else {
    where.push("trashed_at IS NULL");
    if (status) {
      where.push("status = ?");
      binds.push(status);
    }
  }
  if (starredOnly) {
    where.push("starred = 1");
  }
  if (q) {
    where.push(
      "(LOWER(subject) LIKE ? OR LOWER(counterparty_email) LIKE ? OR LOWER(last_snippet) LIKE ?)",
    );
    const like = `%${q.toLowerCase()}%`;
    binds.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql =
    `SELECT t.*,
       EXISTS (
         SELECT 1 FROM email_messages m
          WHERE m.thread_id = t.id AND m.direction = 'outbound'
       ) AS has_outbound
       FROM email_threads t ${whereSql}` +
    " ORDER BY t.last_message_at DESC NULLS LAST LIMIT 300";
  const res = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<ThreadRow>();
  return c.json((res.results ?? []).map(rowToThread));
});

// GET /api/mail-center/threads/:id — thread + its messages (marks read).
app.get("/threads/:id", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  const thread = await c.env.DB.prepare(
    `SELECT * FROM email_threads WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((thread.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const msgs = await c.env.DB.prepare(
    `SELECT * FROM email_messages WHERE thread_id = ? ORDER BY created_at ASC`,
  )
    .bind(id)
    .all<MessageRow>();
  const mappedMsgs = (msgs.results ?? []).map(rowToMessage);

  // Attachments — load every attachment for THIS thread's messages and group
  // them under their message. Each carries an authed stream URL (no signed URL).
  const attByMsg = new Map<string, ReturnType<typeof attachmentToApi>[]>();
  try {
    const msgIds = mappedMsgs.map((m) => m.id);
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => "?").join(", ");
      const attRows = await c.env.DB.prepare(
        `SELECT * FROM email_attachments
           WHERE message_id IN (${ph})
           ORDER BY created_at ASC`,
      )
        .bind(...msgIds)
        .all<AttachmentRow>();
      for (const r of attRows.results ?? []) {
        const msgKey = r.message_id ?? "";
        if (!msgKey) continue;
        const item = attachmentToApi(r);
        const list = attByMsg.get(msgKey) ?? [];
        list.push(item);
        attByMsg.set(msgKey, list);
      }
    }
  } catch (e) {
    console.error("[mail-center] loading attachments failed:", e);
  }

  // Clear the unread flag on open.
  try {
    await c.env.DB.prepare(`UPDATE email_threads SET unread = 0 WHERE id = ?`)
      .bind(id)
      .run();
  } catch {
    /* read view must not fail if the mark-read write blips */
  }

  return c.json({
    thread: rowToThread(thread),
    messages: mappedMsgs.map((m) => ({
      ...m,
      attachments: attByMsg.get(m.id) ?? [],
    })),
  });
});

// GET /api/mail-center/attachments/:id — authed R2 stream (replaces signed URLs).
// Scoped: a non-admin may only fetch an attachment whose thread mailbox is in
// their scope. The bytes never leave through a public URL.
app.get("/attachments/:id", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  // Join the attachment -> its message -> its thread so we can scope on the
  // thread's mailbox (the same gate as reading the thread).
  const row = await c.env.DB.prepare(
    `SELECT a.filename, a.content_type, a.storage_path, t.mailbox_address
       FROM email_attachments a
       JOIN email_messages m ON m.id = a.message_id
       JOIN email_threads t ON t.id = m.thread_id
      WHERE a.id = ? LIMIT 1`,
  )
    .bind(id)
    .first<{
      filename: string | null;
      content_type: string | null;
      storage_path: string | null;
      mailbox_address: string | null;
    }>();
  if (!row || !row.storage_path) return c.json({ error: "Not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((row.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Not found" }, 404);
  }

  const obj = await c.env.POD_BUCKET.get(row.storage_path);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const filename = safeFilename(row.filename ?? "file");
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=600",
    },
  });
});

// GET /api/mail-center/addresses — our addresses / aliases, scoped to match the
// thread scope at every visibility level.
app.get("/addresses", async (c) => {
  c.header("Cache-Control", "no-store");
  const scope = await getMailScope(c);
  if (scope.isAdmin) {
    const res = await c.env.DB.prepare(
      `SELECT * FROM email_addresses ORDER BY address ASC`,
    ).all<AddressRow>();
    return c.json((res.results ?? []).map(rowToAddress));
  }
  if (scope.addresses.length === 0) return c.json([]);
  const ph = scope.addresses.map(() => "?").join(", ");
  const res = await c.env.DB.prepare(
    `SELECT * FROM email_addresses
       WHERE LOWER(address) IN (${ph})
       ORDER BY address ASC`,
  )
    .bind(...scope.addresses)
    .all<AddressRow>();
  return c.json((res.results ?? []).map(rowToAddress));
});

// ---------------------------------------------------------------------------
// Label catalogue. Reads are open to any authenticated mailbox user (the
// sidebar needs colours); create/edit/delete require a mailbox in scope — the
// SAME gate as labelling a thread, NOT a permission key.
// ---------------------------------------------------------------------------
const LABEL_COLORS = [
  "#6B5C32",
  "#B45309",
  "#15803D",
  "#0E7490",
  "#1D4ED8",
  "#6D28D9",
  "#BE185D",
  "#B91C1C",
  "#475569",
] as const;
const DEFAULT_LABEL_COLOR = LABEL_COLORS[0];

function normalizeColor(input: string | undefined | null): string {
  const v = (input ?? "").trim();
  if (!v) return DEFAULT_LABEL_COLOR;
  const up = v.toUpperCase();
  const hit = (LABEL_COLORS as readonly string[]).find(
    (c2) => c2.toUpperCase() === up,
  );
  return hit ?? DEFAULT_LABEL_COLOR;
}

// Whether the caller may manage the label catalogue: admin, or any user with at
// least one mailbox in scope (same bar as labelling a thread).
async function canManageLabels(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const scope = await getMailScope(c);
  return scope.isAdmin || scope.addresses.length > 0;
}

// GET /api/mail-center/labels — the catalogue (name + colour).
app.get("/labels", async (c) => {
  c.header("Cache-Control", "no-store");
  const res = await c.env.DB.prepare(
    `SELECT * FROM email_labels ORDER BY name ASC`,
  ).all<LabelRow>();
  return c.json((res.results ?? []).map(rowToLabel));
});

// POST /api/mail-center/labels {name,color} — create a catalogue label.
app.post("/labels", async (c) => {
  if (!(await canManageLabels(c))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const body = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as { name?: string; color?: string });
  const name = (body.name ?? "").trim().slice(0, 60);
  if (!name) return c.json({ error: "name is required" }, 400);
  const color = normalizeColor(body.color);

  const existing = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE lower(name) = lower(?) LIMIT 1`,
  )
    .bind(name)
    .first<LabelRow>();
  if (existing) return c.json(rowToLabel(existing));

  const id = crypto.randomUUID();
  const userId = c.get("userId") ?? null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO email_labels (id, name, color, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, name, color, new Date().toISOString(), userId)
      .run();
  } catch {
    const row = await c.env.DB.prepare(
      `SELECT * FROM email_labels WHERE lower(name) = lower(?) LIMIT 1`,
    )
      .bind(name)
      .first<LabelRow>();
    return c.json(row ? rowToLabel(row) : { id, name, color });
  }
  const row = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<LabelRow>();
  return c.json(row ? rowToLabel(row) : { id, name, color }, 201);
});

// PATCH /api/mail-center/labels/:id {name?,color?} — rename / recolour. A rename
// cascades to every thread carrying the OLD name.
app.patch("/labels/:id", async (c) => {
  if (!(await canManageLabels(c))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const id = c.req.param("id");
  const body = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as { name?: string; color?: string });

  const current = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<LabelRow>();
  if (!current) return c.json({ error: "label not found" }, 404);

  const sets: string[] = [];
  const binds: (string | null)[] = [];
  let renameFrom = "";
  let renameTo = "";
  if (body.name !== undefined) {
    const name = body.name.trim().slice(0, 60);
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    if (name.toLowerCase() !== current.name.toLowerCase()) {
      const clash = await c.env.DB.prepare(
        `SELECT id FROM email_labels WHERE lower(name) = lower(?) AND id <> ? LIMIT 1`,
      )
        .bind(name, id)
        .first<{ id: string }>();
      if (clash) return c.json({ error: "a label with that name exists" }, 409);
      renameFrom = current.name;
      renameTo = name;
    }
    sets.push("name = ?");
    binds.push(name);
  }
  if (body.color !== undefined) {
    sets.push("color = ?");
    binds.push(normalizeColor(body.color));
  }
  if (sets.length === 0) return c.json({ error: "no fields to update" }, 400);

  await c.env.DB.prepare(
    `UPDATE email_labels SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...binds, id)
    .run();

  if (renameFrom && renameTo) {
    await renameThreadLabel(c, renameFrom, renameTo);
  }

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<LabelRow>();
  return c.json(row ? rowToLabel(row) : { id });
});

// DELETE /api/mail-center/labels/:id — remove a catalogue label and strip it
// from every thread that carried it.
app.delete("/labels/:id", async (c) => {
  if (!(await canManageLabels(c))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const id = c.req.param("id");
  const current = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<LabelRow>();
  if (!current) return c.json({ error: "label not found" }, 404);

  await c.env.DB.prepare(`DELETE FROM email_labels WHERE id = ?`)
    .bind(id)
    .run();
  await renameThreadLabel(c, current.name, "");
  return c.json({ ok: true });
});

// Rewrite one label name across every thread's JSON label array. renameTo=""
// REMOVES the label; otherwise rename in place, de-duped case-insensitively.
async function renameThreadLabel(
  c: Context<{ Bindings: Env }>,
  from: string,
  to: string,
): Promise<void> {
  const like = `%${from}%`;
  const rows = await c.env.DB.prepare(
    `SELECT id, labels FROM email_threads
       WHERE labels IS NOT NULL AND labels LIKE ?`,
  )
    .bind(like)
    .all<{ id: string; labels: string | null }>();
  for (const r of rows.results ?? []) {
    const arr = parseJsonArray(r.labels);
    if (!arr.some((l) => l.toLowerCase() === from.toLowerCase())) continue;
    const next: string[] = [];
    for (const l of arr) {
      if (l.toLowerCase() === from.toLowerCase()) {
        if (to && !next.some((n) => n.toLowerCase() === to.toLowerCase())) {
          next.push(to);
        }
      } else if (!next.some((n) => n.toLowerCase() === l.toLowerCase())) {
        next.push(l);
      }
    }
    await c.env.DB.prepare(`UPDATE email_threads SET labels = ? WHERE id = ?`)
      .bind(JSON.stringify(next), r.id)
      .run();
  }
}

// POST /api/mail-center/test-inject — admin-only: seed ONE sample inbound email
// so the owner can verify the inbox + reply UI BEFORE switching MX (zero infra).
// Gated by requirePermission("mail_center.manage") in index.ts is NOT applied to
// this sub-path (the router is mounted whole), so gate inline on isMailAdmin.
app.post("/test-inject", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "Forbidden: requires mail_center.manage" }, 403);
  }
  // Land it on a real configured address if one exists, else <branding domain>.
  const addr = await c.env.DB.prepare(
    `SELECT address FROM email_addresses WHERE active = 1 ORDER BY created_at ASC LIMIT 1`,
  ).first<{ address: string }>();
  const domain = await brandingDomain(c.env);
  const mailbox = addr?.address || `support@${domain}`;
  const result = await ingestInboundEmail(
    c.env.DB,
    {
      from: "customer@example.com",
      fromName: "Test Customer",
      to: [mailbox],
      subject: "Test: can you make a 5ft bed frame?",
      text: "Hi, I'd like to order a 5ft bed frame. Could you let me know the price and lead time?\n\n(This is a test email — feel free to delete it.)\n\nThanks,\nTest Customer",
      messageId: `test-${crypto.randomUUID()}@example.com`,
      date: new Date().toISOString(),
    },
    c.env,
  );
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Address admin endpoints. Creating / managing an alias is an account-level
// action, gated on mail_center.manage (owner passes via "*"). The route-level
// requirePermission mount in index.ts protects the router as a whole only for
// the admin sub-paths — but since the whole router is mounted after a single
// permission check would over-gate the reads, these admin handlers each verify
// isMailAdmin inline. (Reads above intentionally stay scope-gated, not perm-gated.)
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/mail-center/addresses — create an alias for a user.
app.post("/addresses", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "Forbidden: requires mail_center.manage" }, 403);
  }

  type CreateBody = {
    address?: string;
    label?: string;
    assignedUserId?: number | null;
    assignedUserName?: string;
    assignedDept?: string;
    assignedPosition?: string;
  };
  const body: CreateBody = await c.req
    .json<CreateBody>()
    .catch(() => ({}) as CreateBody);

  const address = (body.address ?? "").trim().toLowerCase();
  if (!address || !EMAIL_RE.test(address)) {
    return c.json({ error: "invalid email address" }, 400);
  }
  // Enforce the company domain from Branding (not a literal).
  const domain = await brandingDomain(c.env);
  if (!address.endsWith(`@${domain}`)) {
    return c.json({ error: `address must end with @${domain}` }, 400);
  }

  const userId = c.get("userId") ?? null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO email_addresses
         (id, address, label, assigned_user_id, assigned_user_name,
          assigned_dept, assigned_position, active, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        id,
        address,
        body.label?.trim() || null,
        body.assignedUserId ?? null,
        body.assignedUserName ?? null,
        body.assignedDept ?? null,
        body.assignedPosition?.trim() || null,
        now,
        userId,
      )
      .run();
  } catch (e) {
    const existing = await c.env.DB.prepare(
      `SELECT * FROM email_addresses WHERE lower(address) = ? LIMIT 1`,
    )
      .bind(address)
      .first<AddressRow>();
    if (existing) {
      return c.json({ error: "address already exists" }, 409);
    }
    console.error("[mail-center] address insert failed:", e);
    return c.json({ error: "failed to create address" }, 500);
  }

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_addresses WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<AddressRow>();
  return c.json(row ? rowToAddress(row) : { id, address }, 201);
});

// PATCH /api/mail-center/addresses/:id — toggle active / relabel / reassign.
app.patch("/addresses/:id", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "Forbidden: requires mail_center.manage" }, 403);
  }
  const id = c.req.param("id");

  type PatchBody = {
    label?: string;
    assignedUserId?: number | null;
    assignedUserName?: string | null;
    assignedDept?: string | null;
    assignedPosition?: string | null;
    active?: boolean;
  };
  const body: PatchBody = await c.req
    .json<PatchBody>()
    .catch(() => ({}) as PatchBody);

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.label !== undefined) {
    sets.push("label = ?");
    binds.push(body.label?.trim() || null);
  }
  if (body.assignedUserId !== undefined) {
    sets.push("assigned_user_id = ?");
    binds.push(body.assignedUserId ?? null);
  }
  if (body.assignedUserName !== undefined) {
    sets.push("assigned_user_name = ?");
    binds.push(body.assignedUserName ?? null);
  }
  if (body.assignedDept !== undefined) {
    sets.push("assigned_dept = ?");
    binds.push(body.assignedDept?.trim() || null);
  }
  if (body.assignedPosition !== undefined) {
    sets.push("assigned_position = ?");
    binds.push(body.assignedPosition?.trim() || null);
  }
  if (body.active !== undefined) {
    sets.push("active = ?");
    binds.push(body.active ? 1 : 0);
  }
  if (sets.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const res = await c.env.DB.prepare(
    `UPDATE email_addresses SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...binds, id)
    .run();
  if (!res.meta?.changes) {
    return c.json({ error: "address not found" }, 404);
  }

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_addresses WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<AddressRow>();
  return c.json(row ? rowToAddress(row) : { id });
});

// ---------------------------------------------------------------------------
// Mailbox access matrix. A user always has their own assigned alias; these
// grants ADDITIONALLY let them open a SHARED mailbox. Admin-only.
// ---------------------------------------------------------------------------

// GET /api/mail-center/access — every (addressId,userId) grant.
app.get("/access", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "Forbidden: requires mail_center.manage" }, 403);
  }
  const res = await c.env.DB.prepare(
    `SELECT address_id, user_id FROM email_address_access`,
  ).all<{ address_id: string; user_id: number }>();
  c.header("Cache-Control", "no-store");
  return c.json(
    (res.results ?? []).map((r) => ({
      addressId: r.address_id,
      userId: r.user_id,
    })),
  );
});

// POST /api/mail-center/access {addressId,userId} — grant access. Idempotent.
app.post("/access", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "Forbidden: requires mail_center.manage" }, 403);
  }
  const body = await c.req
    .json<{ addressId?: string; userId?: number }>()
    .catch(() => ({}) as { addressId?: string; userId?: number });
  const addressId = (body.addressId ?? "").toString().trim();
  const userId = body.userId;
  if (!addressId || userId == null) {
    return c.json({ error: "addressId and userId are required" }, 400);
  }
  const grantedBy = c.get("userId") ?? null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO email_address_access
         (id, address_id, user_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        addressId,
        userId,
        new Date().toISOString(),
        grantedBy,
      )
      .run();
  } catch {
    // Unique (address_id,user_id) collision → the grant already exists.
  }
  return c.json({ ok: true, addressId, userId }, 201);
});

// DELETE /api/mail-center/access {addressId,userId} — revoke a grant.
app.delete("/access", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "Forbidden: requires mail_center.manage" }, 403);
  }
  const body = await c.req
    .json<{ addressId?: string; userId?: number }>()
    .catch(() => ({}) as { addressId?: string; userId?: number });
  const addressId = (body.addressId ?? c.req.query("addressId") ?? "")
    .toString()
    .trim();
  const userIdRaw = body.userId ?? c.req.query("userId");
  const userId = userIdRaw == null ? null : Number(userIdRaw);
  if (!addressId || userId == null || Number.isNaN(userId)) {
    return c.json({ error: "addressId and userId are required" }, 400);
  }
  await c.env.DB.prepare(
    `DELETE FROM email_address_access WHERE address_id = ? AND user_id = ?`,
  )
    .bind(addressId, userId)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Hierarchical mail-visibility levels. Admin sets a per-user level in
// mail_user_scope: 'personal' | 'department' | 'company'. Absent row = personal.
// ---------------------------------------------------------------------------

// GET /api/mail-center/scope-levels — every per-user level row.
app.get("/scope-levels", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "Forbidden: requires mail_center.manage" }, 403);
  }
  const res = await c.env.DB.prepare(
    `SELECT user_id, level FROM mail_user_scope`,
  ).all<{ user_id: number; level: string }>();
  c.header("Cache-Control", "no-store");
  return c.json(
    (res.results ?? []).map((r) => ({
      userId: r.user_id,
      level: r.level,
    })),
  );
});

// PUT /api/mail-center/scope-level {userId,level} — upsert a user's level.
app.put("/scope-level", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "Forbidden: requires mail_center.manage" }, 403);
  }
  const body = await c.req
    .json<{ userId?: number; level?: string }>()
    .catch(() => ({}) as { userId?: number; level?: string });
  const userId = body.userId;
  const level = (body.level ?? "").trim().toLowerCase();
  if (userId == null) {
    return c.json({ error: "userId is required" }, 400);
  }
  if (!(MAIL_SCOPE_LEVELS as readonly string[]).includes(level)) {
    return c.json(
      { error: "level must be 'personal', 'department', or 'company'" },
      400,
    );
  }
  await c.env.DB.prepare(
    `INSERT INTO mail_user_scope (user_id, level, created_at)
       VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET level = excluded.level`,
  )
    .bind(userId, level, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reply + compose (mounted at /api/mail-center, AFTER auth). Outbound send uses
// Houzs sendEmail (Resend); from-default + company come from Branding.
// ---------------------------------------------------------------------------

// Resolve a sender display name for the outbound message row. Houzs users.name
// (not Hookka displayName); fall back to email, else the numeric id as a string.
async function senderName(db: D1Database, userId: number | null): Promise<string> {
  if (userId == null) return "";
  try {
    const row = await db
      .prepare("SELECT name, email FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .first<{ name: string | null; email: string | null }>();
    return row?.name?.trim() || row?.email || String(userId);
  } catch {
    return String(userId);
  }
}

// Minimal HTML escape for wrapping a plain-text reply into an HTML body.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// POST /api/mail-center/threads/:id/reply — send an outbound reply via Houzs
// sendEmail (Resend), then record it. The From identity (domain/company) tracks
// Branding inside deliverViaResend; the operator's chosen mailbox is honoured
// only when it's in their scope.
//
// NOTE: sendEmail has no custom In-Reply-To / References header support, so this
// reply is NOT RFC-threaded on the recipient's side for v1 — local threading is
// still correct. Attachments are validated for the FE caps but sendEmail does
// not forward attachments to Resend, so they are NOT delivered (FE flags this).
app.post("/threads/:id/reply", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  type ReplyBody = {
    text?: string;
    html?: string;
    fromAddress?: string;
    attachments?: Array<{ filename: string; contentBase64: string }>;
  };
  const body: ReplyBody = await c.req
    .json<ReplyBody>()
    .catch(() => ({}) as ReplyBody);

  const text = (body.text ?? "").trim();
  const html = body.html?.trim() || "";
  if (!text && !html) {
    return c.json({ error: "reply body is empty" }, 400);
  }

  const attachments = body.attachments ?? [];
  const attachCheck = validateMailAttachments(attachments);
  if (!attachCheck.ok) {
    return c.json({ error: attachCheck.error || "Invalid attachments." }, 400);
  }

  const thread = await c.env.DB.prepare(
    `SELECT * FROM email_threads WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((thread.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const to = (thread.counterparty_email ?? "").trim();
  if (!to) {
    return c.json({ error: "thread has no counterparty email to reply to" }, 400);
  }

  const mailbox = (thread.mailbox_address ?? "").trim();

  // Resolve the From: an explicit fromAddress is honoured only when the caller
  // may send from it (admin = any; non-admin = a mailbox in scope). Otherwise
  // fall back to the thread's mailbox (already ownership-checked above).
  const requestedFrom = (body.fromAddress ?? "").trim();
  let fromAddress = mailbox;
  if (
    requestedFrom &&
    (scope.isAdmin || scope.addresses.includes(requestedFrom.toLowerCase()))
  ) {
    fromAddress = requestedFrom;
  }

  const baseSubject = thread.subject ?? "(no subject)";
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;

  const htmlBody = html || `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;

  // Send via Houzs sendEmail. purpose:"generic" (caller opted in). The From is
  // the operator's chosen mailbox (owner ask: replies come FROM the mailbox, not
  // no-reply@) — sendEmail wraps it with the Branding company display name.
  // replyTo is the same mailbox so the customer's reply lands back on it.
  const result = await sendEmail(c.env, {
    to,
    subject,
    html: htmlBody,
    text: text || undefined,
    purpose: "generic",
    from: fromAddress || undefined,
    replyTo: fromAddress || undefined,
  });
  if (result.status !== "sent") {
    return c.json(
      { error: result.reason || "failed to send reply" },
      result.status === "skipped" ? 400 : 502,
    );
  }

  const userId = c.get("userId") ?? null;
  const fromName = await senderName(c.env.DB, userId);

  const now = new Date().toISOString();
  const snippet = (text || stripHtml(htmlBody)).slice(0, 240);
  const messageId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO email_messages
       (id, thread_id, direction, from_address, from_name,
        to_addresses, subject, text_body, html_body, sent_at, received_at,
        sent_by_user_id, sent_by_name, provider_message_id, created_at)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      id,
      fromAddress || null,
      fromName || null,
      JSON.stringify([to]),
      subject,
      text || null,
      htmlBody,
      now,
      now,
      userId,
      fromName || null,
      result.providerId ?? null,
      now,
    )
    .run();

  await c.env.DB.prepare(
    `UPDATE email_threads
        SET last_message_at = ?, last_direction = 'outbound',
            last_snippet = ?, message_count = message_count + 1, unread = 0
      WHERE id = ?`,
  )
    .bind(now, snippet, id)
    .run();

  return c.json({ ok: true, messageId });
});

// POST /api/mail-center/compose — start a NEW outbound conversation. Sends via
// Houzs sendEmail (Resend), then records a fresh thread + outbound message.
//
// Per-user scope: a non-admin may only send FROM an address that is
// assigned/granted to them (getMailScope). Admins may send from any.
app.post("/compose", async (c) => {
  const scope = await getMailScope(c);

  type ComposeBody = {
    fromAddress?: string;
    to?: string;
    subject?: string;
    text?: string;
    attachments?: Array<{ filename: string; contentBase64: string }>;
  };
  const body: ComposeBody = await c.req
    .json<ComposeBody>()
    .catch(() => ({}) as ComposeBody);

  const fromAddress = (body.fromAddress ?? "").trim();
  const to = (body.to ?? "").trim();
  const subject = (body.subject ?? "").trim();
  const text = (body.text ?? "").trim();
  const attachments = body.attachments ?? [];

  if (!fromAddress) {
    return c.json({ error: "fromAddress is required" }, 400);
  }
  if (!EMAIL_RE.test(to)) {
    return c.json({ error: "a valid recipient (to) is required" }, 400);
  }
  if (!subject) {
    return c.json({ error: "subject is required" }, 400);
  }
  if (!text) {
    return c.json({ error: "message body is required" }, 400);
  }

  const attachCheck = validateMailAttachments(attachments);
  if (!attachCheck.ok) {
    return c.json({ error: attachCheck.error || "Invalid attachments." }, 400);
  }

  // Authorize the From: non-admins may only send from a mailbox they own or have
  // been granted. addresses are already lowercased in getMailScope.
  if (!scope.isAdmin && !scope.addresses.includes(fromAddress.toLowerCase())) {
    return c.json({ error: "not allowed to send from " + fromAddress }, 403);
  }

  const htmlBody = `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;

  // From = the operator's chosen mailbox (owner ask), not no-reply@. replyTo is
  // the same so the recipient's reply lands back on it.
  const result = await sendEmail(c.env, {
    to,
    subject,
    html: htmlBody,
    text,
    purpose: "generic",
    from: fromAddress || undefined,
    replyTo: fromAddress || undefined,
  });
  if (result.status !== "sent") {
    return c.json(
      { error: result.reason || "send failed" },
      result.status === "skipped" ? 400 : 502,
    );
  }

  const userId = c.get("userId") ?? null;
  const fromName = await senderName(c.env.DB, userId);

  const now = new Date().toISOString();
  const snippet = text.slice(0, 200);
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO email_threads
       (id, mailbox_address, subject, counterparty_email,
        counterparty_name, status, last_message_at, last_direction,
        last_snippet, message_count, unread, created_at)
     VALUES (?, ?, ?, ?, '', 'open', ?, 'outbound', ?, 1, 0, ?)`,
  )
    .bind(threadId, fromAddress, subject, to, now, snippet, now)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO email_messages
       (id, thread_id, direction, from_address, from_name,
        to_addresses, cc_addresses, subject, text_body, html_body, sent_at,
        sent_by_user_id, sent_by_name, provider_message_id, created_at)
     VALUES (?, ?, 'outbound', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      threadId,
      fromAddress,
      fromName || null,
      JSON.stringify([to]),
      subject,
      text,
      htmlBody,
      now,
      userId,
      fromName || null,
      result.providerId ?? null,
      now,
    )
    .run();

  return c.json({ ok: true, threadId, messageId }, 201);
});

// PATCH /api/mail-center/threads/:id — mutate a thread: assign / resolve /
// reopen, plus star / labels / mark-unread / trash. Gate matches the READS
// (getMailScope ownership): a mailbox OWNER may mutate THEIR OWN threads;
// admin keeps all. The UPDATE is built dynamically from the body fields.
app.patch("/threads/:id", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  type PatchBody = {
    status?: "open" | "closed";
    assignedToUserId?: number | null;
    assignedToName?: string | null;
    starred?: boolean;
    labels?: string[];
    unread?: boolean;
    trashed?: boolean;
  };
  const body: PatchBody = await c.req
    .json<PatchBody>()
    .catch(() => ({}) as PatchBody);

  const owned = await c.env.DB.prepare(
    `SELECT mailbox_address FROM email_threads WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<{ mailbox_address?: string | null }>();
  if (!owned) return c.json({ error: "Thread not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((owned.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "closed") {
      return c.json({ error: "status must be 'open' or 'closed'" }, 400);
    }
    sets.push("status = ?");
    binds.push(body.status);
  }
  if (body.assignedToUserId !== undefined) {
    sets.push("assigned_to_user_id = ?");
    binds.push(body.assignedToUserId ?? null);
  }
  if (body.assignedToName !== undefined) {
    sets.push("assigned_to_name = ?");
    binds.push(body.assignedToName ?? null);
  }
  if (body.starred !== undefined) {
    sets.push("starred = ?");
    binds.push(body.starred ? 1 : 0);
  }
  if (body.labels !== undefined) {
    const clean = Array.isArray(body.labels)
      ? body.labels.map((l) => String(l).trim()).filter(Boolean)
      : [];
    sets.push("labels = ?");
    binds.push(JSON.stringify(clean));
  }
  if (body.unread !== undefined) {
    sets.push("unread = ?");
    binds.push(body.unread ? 1 : 0);
  }
  if (body.trashed !== undefined) {
    sets.push("trashed_at = ?");
    binds.push(body.trashed ? new Date().toISOString() : null);
  }
  if (sets.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE email_threads SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...binds, id)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_threads WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<ThreadRow>();
  return c.json(row ? rowToThread(row) : { id });
});

export default app;
