import type { Context } from "hono";
import type { Env } from "../types";
import { clientIp } from "../middleware/rateLimit";

// ── Audit trail ───────────────────────────────────────────────
//
// Append-only ledger of security-relevant mutations (role / permission edits,
// user invites + status flips, finance edits, order voids). One row per action
// in audit_events (mig 096 / 0006) carrying the actor, the entity, a one-line
// summary and a JSON before/after blob.
//
// Design:
//   • Best-effort. A failed audit insert is logged and swallowed — it must
//     never break the mutation it was recording. Callers don't await a result.
//   • Append-only. The app has no UPDATE/DELETE path on this table; tampering
//     would have to happen at the database, which is itself outside the app.
//   • Context-aware. audit(c, ...) lifts actor / ip / request-id off the Hono
//     context so call sites only spell out what's specific to the action.

export interface AuditInput {
  action: string; // 'role.update', 'user.invite', 'finance.update', ...
  entityType?: string | null; // 'role','position','user','project_finance','order'
  entityId?: string | number | null;
  summary?: string | null; // human one-liner
  meta?: unknown; // serialized to JSON (before/after, request detail)
  actorId?: number | null;
  actorEmail?: string | null;
  ip?: string | null;
  requestId?: string | null;
}

/** Low-level insert. Never throws. Prefer `audit(c, ...)` from a route. */
export async function writeAudit(env: Env, e: AuditInput): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_events
         (actor_id, actor_email, action, entity_type, entity_id, summary, meta, ip, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        e.actorId ?? null,
        e.actorEmail ?? null,
        e.action,
        e.entityType ?? null,
        e.entityId == null ? null : String(e.entityId),
        e.summary ?? null,
        e.meta == null ? null : JSON.stringify(e.meta),
        e.ip ?? null,
        e.requestId ?? null,
      )
      .run();
  } catch (err) {
    // Audit must never break the request it records.
    console.error("[audit] insert failed", err);
  }
}

/** Route-level helper: fills actor / ip / request-id from the context. */
export async function audit(
  c: Context<{ Bindings: Env }>,
  e: AuditInput,
): Promise<void> {
  const user = c.get("user");
  await writeAudit(c.env, {
    ...e,
    actorId: e.actorId ?? user?.id ?? null,
    actorEmail: e.actorEmail ?? user?.email ?? null,
    ip: e.ip ?? clientIp(c),
    requestId: e.requestId ?? c.get("requestId") ?? null,
  });
}
