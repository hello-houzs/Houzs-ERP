// ----------------------------------------------------------------------------
// Sales Order audit-trail helper. 1:1 clone of 2990s apps/api/src/lib/so-audit.ts.
//
// Single entry point used by every mutation in routes/mfg-sales-orders.ts to
// append one row to mfg_so_audit_log: "谁 create 了什么 update 了什么 from 什么
// changes to 什么 在几点几分".
//
// Behaviour kept identical to 2990s:
//   - Best-effort. Audit logging must NEVER block the main mutation — a failed
//     insert is logged to console but swallowed silently.
//   - Actor name is snapshotted at write time so a later rename/delete of the
//     user row leaves historic display stable.
//   - fieldChanges is a free-form array of { field, from, to } objects.
//
// SEAMS (rule #3 + #4):
//   - DB layer: 2990s per-request Supabase (`sb`) -> Houzs Drizzle (`db`).
//     The `sb.from('mfg_so_audit_log').insert(...)` becomes a Drizzle insert.
//   - Actor: 2990s staff.id (uuid) + staff.name lookup -> Houzs users.id
//     (INTEGER) + users.name. actorId widens to number | null.
// ----------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import type { getDb } from "../db/client";
import { mfgSoAuditLog, users } from "../db/schema";

type Db = ReturnType<typeof getDb>;

export type FieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
};

export type SoAuditAction =
  | "CREATE"
  | "UPDATE_DETAILS"
  | "UPDATE_STATUS"
  | "ADD_PAYMENT"
  | "DELETE_PAYMENT"
  | "ADD_LINE"
  | "UPDATE_LINE"
  | "DELETE_LINE";

export async function recordSoAudit(
  db: Db,
  args: {
    docNo: string;
    action: SoAuditAction | string;
    actorId?: number | null;
    actorName?: string | null;
    fieldChanges?: FieldChange[];
    statusSnapshot?: string | null;
    source?: string;
    note?: string;
  },
): Promise<void> {
  try {
    let actorName = args.actorName ?? null;
    // Best-effort name snapshot — if caller didn't pass one, look it up from
    // the users row. Failure here is silent (we just leave it null).
    if (!actorName && args.actorId != null) {
      try {
        const rows = await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, args.actorId))
          .limit(1);
        actorName = rows[0]?.name ?? null;
      } catch {
        /* swallow */
      }
    }

    await db.insert(mfgSoAuditLog).values({
      soDocNo: args.docNo,
      action: args.action,
      actorId: args.actorId ?? null,
      actorNameSnapshot: actorName,
      fieldChanges: (args.fieldChanges ?? []) as unknown,
      statusSnapshot: args.statusSnapshot ?? null,
      source: args.source ?? "web",
      note: args.note ?? null,
    } as never);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[so-audit] insert failed (non-fatal):", args.docNo, args.action, e instanceof Error ? e.message : String(e));
  }
}

/* ──────────────────────────────────────────────────────────────────────
   diffFields — shared helper for UPDATE_DETAILS / UPDATE_LINE handlers.
   Given a `before` row (snake_case from the DB) and a `patch` body (camelCase
   from the client) plus an alias map, returns the array of FieldChange objects
   for fields that actually changed. Verbatim from 2990s (pure function).
   ────────────────────────────────────────────────────────────────────── */
export function diffFields(
  before: Record<string, unknown>,
  patchCamel: Record<string, unknown>,
  aliases: Array<[camel: string, snake: string]>,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [camel, snake] of aliases) {
    if (patchCamel[camel] === undefined) continue;
    const fromVal = before[snake];
    const toVal = patchCamel[camel];
    // Loose equality: treat null and '' as the same, numbers and stringified
    // numbers as the same. Avoids noisy diffs from JSON round-tripping.
    const a = fromVal == null ? "" : String(fromVal);
    const b = toVal == null ? "" : String(toVal);
    if (a !== b) out.push({ field: camel, from: fromVal ?? null, to: toVal ?? null });
  }
  return out;
}
