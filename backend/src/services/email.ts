import type { Env } from "../types";

// ── Email service (Resend-backed) ─────────────────────────────
//
// Design goals:
//   • No-op safely when secrets or recipients are missing.  send()
//     never throws — it returns a result object that callers can log
//     but don't *need* to check. This keeps notification calls off
//     the critical path of mutations like "close case" or "escalate".
//   • Every attempt (sent / skipped / error) is written to email_log
//     so ops can trace a missing email to a specific reason without
//     digging through worker logs.
//   • Channel toggles in app_settings let admins disable categories
//     (e.g. flip off SLA escalation during a quiet week) without
//     needing a deploy.

export type EmailPurpose =
  | "assr_survey"
  | "assr_sla_escalation"
  // v3.1 per-stage alert events (one toggle each so admins can mute
  // half-time chatter while leaving breach alerts on)
  | "assr_alert_stage_entered"
  | "assr_alert_half_time"
  | "assr_alert_approaching_breach"
  | "assr_alert_breach"
  | "assr_daily_digest"
  | "supplier_invite"
  | "member_invite"
  | "project_due_reminder"
  | "password_reset"
  // Customer-facing document emails (auto-send foundation). All OFF by default
  // (seeded false in mig 098) — high-stakes outbound, flip per-channel when ready.
  | "delivery_order"
  | "invoice"
  | "document_report"
  | "generic";

export interface SendOptions {
  to: string | null | undefined;
  subject: string;
  html: string;
  text?: string;        // plain-text fallback; auto-derived from html if missing
  purpose: EmailPurpose;
  refType?: string | null;
  refId?: number | null;
  replyTo?: string | null;
}

export interface SendResult {
  status: "sent" | "skipped" | "error";
  providerId?: string;
  reason?: string;
}

const PURPOSE_TOGGLE_KEYS: Record<EmailPurpose, string> = {
  assr_survey: "email.assr_survey",
  assr_sla_escalation: "email.assr_sla_escalation",
  assr_alert_stage_entered: "email.assr_alert_stage_entered",
  assr_alert_half_time: "email.assr_alert_half_time",
  assr_alert_approaching_breach: "email.assr_alert_approaching_breach",
  assr_alert_breach: "email.assr_alert_breach",
  assr_daily_digest: "email.assr_daily_digest",
  supplier_invite: "email.supplier_invite",
  member_invite: "email.member_invite",
  project_due_reminder: "email.project_due_reminder",
  password_reset: "email.password_reset",
  delivery_order: "email.delivery_order",
  invoice: "email.invoice",
  document_report: "email.document_report",
  // No toggle for 'generic' — caller opted in explicitly.
  generic: "email.enabled",
};

async function isChannelEnabled(env: Env, purpose: EmailPurpose): Promise<boolean> {
  // Master kill-switch first.
  const master = await readSetting<{ value: boolean }>(env, "email.enabled");
  if (master && master.value === false) return false;
  // Per-channel check.
  const k = PURPOSE_TOGGLE_KEYS[purpose];
  if (k === "email.enabled") return true;
  const s = await readSetting<{ value: boolean }>(env, k);
  // Default to ON if the row is missing (row wasn't seeded for some reason).
  return s?.value !== false;
}

async function readSetting<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare(
    `SELECT value FROM app_settings WHERE key = ?`
  )
    .bind(key)
    .first<{ value: string }>();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function logEmail(
  env: Env,
  opts: SendOptions,
  result: SendResult,
  error?: string | null
) {
  try {
    await env.DB.prepare(
      `INSERT INTO email_log
         (purpose, ref_type, ref_id, to_addr, subject, status, provider_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        opts.purpose,
        opts.refType ?? null,
        opts.refId ?? null,
        opts.to ?? "",
        opts.subject,
        result.status,
        result.providerId ?? null,
        error ?? result.reason ?? null
      )
      .run();
  } catch (e) {
    // Logging failures are non-fatal — the request already succeeded.
    console.error("[email_log] insert failed", e);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Low-level Resend POST. No logging / no outbox — shared by sendEmail and the
// outbox drain. Returns 'sent' | 'error' (caller pre-checks channel + key).
async function deliverViaResend(
  env: Env,
  m: { to: string; subject: string; html: string; text?: string | null; replyTo?: string | null },
): Promise<SendResult> {
  const from = env.EMAIL_FROM || "Houzs ERP <no-reply@houzscentury.com>";
  const replyTo = m.replyTo ?? env.EMAIL_REPLY_TO ?? null;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text || stripHtml(m.html),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { status: "error", reason: `resend ${resp.status}: ${body.slice(0, 300)}` };
    }
    const data = (await resp.json().catch(() => ({}))) as { id?: string };
    return { status: "sent", providerId: data.id };
  } catch (e: any) {
    return { status: "error", reason: e?.message || String(e) };
  }
}

export async function sendEmail(env: Env, opts: SendOptions): Promise<SendResult> {
  const to = (opts.to || "").trim();
  if (!to || !to.includes("@")) {
    const result: SendResult = { status: "skipped", reason: "missing or invalid recipient" };
    await logEmail(env, opts, result);
    return result;
  }

  if (!(await isChannelEnabled(env, opts.purpose))) {
    const result: SendResult = { status: "skipped", reason: "channel disabled" };
    await logEmail(env, opts, result);
    return result;
  }

  if (!env.RESEND_API_KEY) {
    const result: SendResult = { status: "skipped", reason: "RESEND_API_KEY not configured" };
    await logEmail(env, opts, result);
    return result;
  }

  // Durable: enqueue first (so a failed send is never silently lost), then try
  // to deliver immediately. On failure the row stays 'pending' for the */5 cron
  // drain (drainEmailOutbox) to retry. email_log remains the per-attempt audit.
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO email_outbox
         (id, to_address, subject, body_html, body_text, purpose, ref_type, ref_id, reply_to, status, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)`,
    )
      .bind(id, to, opts.subject, opts.html, opts.text ?? null, opts.purpose, opts.refType ?? null, opts.refId ?? null, opts.replyTo ?? null)
      .run();
  } catch (e) {
    console.warn("[email] outbox enqueue failed; sending inline only:", e);
  }

  const result = await deliverViaResend(env, {
    to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: opts.replyTo,
  });
  try {
    if (result.status === "sent") {
      await env.DB.prepare(`UPDATE email_outbox SET status='sent', sent_at=datetime('now') WHERE id=?`).bind(id).run();
    } else {
      await env.DB.prepare(`UPDATE email_outbox SET last_error=? WHERE id=?`).bind(result.reason ?? null, id).run();
    }
  } catch {
    /* outbox bookkeeping is best-effort */
  }
  await logEmail(env, opts, result);
  return result;
}

// Cron drain (called from the every-5-min scheduled handler): retry pending
// outbox rows — the immediate-send failures. Up to 3 attempts total, then
// 'failed'. No-op when RESEND_API_KEY is unset. Each attempt mirrors to email_log.
export async function drainEmailOutbox(
  env: Env,
  limit = 25,
): Promise<{ processed: number; sent: number; failed: number }> {
  if (!env.RESEND_API_KEY) return { processed: 0, sent: 0, failed: 0 };
  const rows = await env.DB.prepare(
    `SELECT id, to_address, subject, body_html, body_text, purpose, ref_type, ref_id, reply_to, attempts
       FROM email_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      to_address: string;
      subject: string;
      body_html: string | null;
      body_text: string | null;
      purpose: EmailPurpose;
      ref_type: string | null;
      ref_id: number | null;
      reply_to: string | null;
      attempts: number;
    }>();

  let sent = 0;
  let failed = 0;
  const list = rows.results ?? [];
  for (const r of list) {
    const result = await deliverViaResend(env, {
      to: r.to_address,
      subject: r.subject,
      html: r.body_html ?? "",
      text: r.body_text,
      replyTo: r.reply_to,
    });
    const attempts = (r.attempts ?? 0) + 1;
    if (result.status === "sent") {
      await env.DB.prepare(`UPDATE email_outbox SET status='sent', sent_at=datetime('now'), attempts=? WHERE id=?`).bind(attempts, r.id).run();
      sent++;
    } else {
      const status = attempts >= 3 ? "failed" : "pending";
      await env.DB.prepare(`UPDATE email_outbox SET status=?, attempts=?, last_error=? WHERE id=?`).bind(status, attempts, result.reason ?? null, r.id).run();
      if (status === "failed") failed++;
    }
    await logEmail(
      env,
      {
        to: r.to_address,
        subject: r.subject,
        html: r.body_html ?? "",
        purpose: r.purpose,
        refType: r.ref_type ?? undefined,
        refId: r.ref_id ?? undefined,
      },
      result,
    );
  }
  return { processed: list.length, sent, failed };
}

// ── Convenience: build a public URL for email links ──────────
// Used by callers to build survey / portal / invite / reset URLs.
// Falls back to the canonical user-facing domain if PUBLIC_APP_URL is unset.

export function publicUrl(env: Env, path: string): string {
  const base = (env.PUBLIC_APP_URL || "https://erp.houzscentury.com").replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

// ── Shared transactional templates ───────────────────────────
// Kept here (not in route files) so invite + reset mail share one
// look and both invite paths (issue + resend) render identically.

export function inviteEmailHtml(p: {
  link: string;
  roleName: string;
  inviterName: string;
  expiresIn: string;
}): string {
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 10px">You're invited to Houzs ERP</h2>
      <p>${p.inviterName} has invited you to join the Houzs ERP workspace as <strong>${p.roleName}</strong>.</p>
      <p style="margin:24px 0">
        <a href="${p.link}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Accept invitation
        </a>
      </p>
      <p style="color:#777;font-size:12px">
        You'll be asked to set your own password. If the button doesn't work,
        paste this link into your browser:
      </p>
      <p style="color:#555;font-size:11px;word-break:break-all">${p.link}</p>
      <p style="color:#777;font-size:12px">
        This invitation expires in ${p.expiresIn}. If you weren't expecting it,
        you can ignore this email.
      </p>
    </div>`;
}

// Shared customer-facing document email (Delivery Order, Invoice, Report all
// reuse this — only the label + summary rows differ). HTML-only: it inlines the
// document summary and optionally links to a view/print page, rather than
// attaching a PDF. WHY: Cloudflare Workers has no headless-browser PDF path and
// deliverViaResend has no attachment param; the repo's existing "documents"
// (assr_print/projects_print) are server-rendered HTML for browser print too.
export function documentEmailHtml(p: {
  docTypeLabel: string; // "Delivery Order" | "Invoice" | "Report"
  docNo: string;
  recipientName: string;
  rows: Array<{ label: string; value: string }>; // summary key/values
  viewLink?: string | null; // tokenized public view/print URL, optional
  note?: string | null;
}): string {
  const summary = p.rows
    .map(
      (r) =>
        `<tr><td style="padding:4px 14px 4px 0;color:#777;white-space:nowrap">${r.label}</td>` +
        `<td style="padding:4px 0;color:#222;font-weight:600">${r.value}</td></tr>`,
    )
    .join("");
  const button = p.viewLink
    ? `<p style="margin:24px 0"><a href="${p.viewLink}"
         style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">View ${p.docTypeLabel}</a></p>`
    : "";
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 4px">Houzs Century</h2>
      <p style="margin:0 0 16px;color:#777">${p.docTypeLabel} ${p.docNo}</p>
      <p>Dear ${p.recipientName},</p>
      <p>Please find your ${p.docTypeLabel.toLowerCase()} details below.</p>
      <table style="border-collapse:collapse;margin:12px 0">${summary}</table>
      ${p.note ? `<p style="color:#555">${p.note}</p>` : ""}
      ${button}
      <p style="color:#777;font-size:12px;margin-top:24px">
        This is an automated message from Houzs Century. Reply to this email if
        you have any questions about your order.
      </p>
    </div>`;
}

export function resetEmailHtml(p: {
  name: string;
  link: string;
  expiresIn: string;
  requestedBy: string | null;
}): string {
  const intro = p.requestedBy
    ? `${p.requestedBy} has initiated a password reset for your Houzs ERP account.`
    : `We received a request to reset the password for your Houzs ERP account. If this was you, set a new password below.`;
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 10px">Hi ${p.name},</h2>
      <p>${intro}</p>
      <p style="margin:24px 0">
        <a href="${p.link}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Set new password
        </a>
      </p>
      <p style="color:#777;font-size:12px">
        This link expires in ${p.expiresIn}. If you didn't expect this email,
        you can ignore it — but if you notice repeated resets on your
        account, flag it with your admin.
      </p>
    </div>`;
}

// ── Settings helpers exposed to routes ────────────────────────

export async function getAllEmailSettings(env: Env): Promise<Record<string, any>> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM app_settings WHERE key LIKE 'email.%'`
  ).all<{ key: string; value: string }>();
  const out: Record<string, any> = {};
  for (const r of rows.results ?? []) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = null;
    }
  }
  return out;
}

export async function setSetting(
  env: Env,
  key: string,
  value: any,
  userId: number | null
) {
  const json = JSON.stringify(value);
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`
  )
    .bind(key, json, userId ?? null)
    .run();
}
