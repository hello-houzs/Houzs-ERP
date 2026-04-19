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
  | "supplier_invite"
  | "project_due_reminder"
  | "password_reset"
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
  supplier_invite: "email.supplier_invite",
  project_due_reminder: "email.project_due_reminder",
  password_reset: "email.password_reset",
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

  const from = env.EMAIL_FROM || "Houzs ERP <no-reply@houzs-erp.pages.dev>";
  const replyTo = opts.replyTo ?? env.EMAIL_REPLY_TO ?? null;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text || stripHtml(opts.html),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const result: SendResult = {
        status: "error",
        reason: `resend ${resp.status}: ${body.slice(0, 300)}`,
      };
      await logEmail(env, opts, result);
      return result;
    }
    const data = (await resp.json().catch(() => ({}))) as { id?: string };
    const result: SendResult = { status: "sent", providerId: data.id };
    await logEmail(env, opts, result);
    return result;
  } catch (e: any) {
    const result: SendResult = {
      status: "error",
      reason: e?.message || String(e),
    };
    await logEmail(env, opts, result);
    return result;
  }
}

// ── Convenience: build a public URL for email links ──────────
// Used by callers to build survey / portal / supplier invite URLs.
// Falls back to the canonical Pages domain if PUBLIC_APP_URL is unset.

export function publicUrl(env: Env, path: string): string {
  const base = (env.PUBLIC_APP_URL || "https://houzs-erp.pages.dev").replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
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
