// PR-D — Sales Order audit trail helper.
// Commander 2026-05-27: "要有 audit trail 的 谁 create 了什么 update 了什么
// from 什么 changes to 什么 在几点几分". Single entry point used by every
// mutation in routes/mfg-sales-orders.ts to append one row to mfg_so_audit_log.
//
// Design notes:
//   - Best-effort. Audit logging must NEVER block the main mutation —
//     a failed insert is logged to console but swallowed silently.
//   - Actor name is snapshotted at write time. If the staff row is later
//     renamed (or deleted), the historic display stays stable.
//   - `fieldChanges` is a free-form array of { field, from, to } objects.
//     The render layer maps `field` to a human label.

import type { SupabaseClient } from '@supabase/supabase-js';

export type FieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
};

export type SoAuditAction =
  | 'CREATE'
  | 'UPDATE_DETAILS'
  | 'UPDATE_STATUS'
  | 'ADD_PAYMENT'
  | 'DELETE_PAYMENT'
  | 'ADD_LINE'
  | 'UPDATE_LINE'
  | 'DELETE_LINE';

export async function recordSoAudit(
  sb: SupabaseClient,
  args: {
    docNo: string;
    action: SoAuditAction | string;
    actorId?: string | null;
    actorName?: string | null;
    fieldChanges?: FieldChange[];
    statusSnapshot?: string | null;
    source?: string;
    note?: string;
  },
): Promise<void> {
  try {
    let actorName = args.actorName ?? null;
    // Best-effort name snapshot — if caller didn't pass one, look it up
    // from the staff row. Failure here is silent (we just leave it null).
    if (!actorName && args.actorId) {
      try {
        const { data } = await sb.from('staff').select('name').eq('id', args.actorId).maybeSingle();
        actorName = (data as { name?: string } | null)?.name ?? null;
      } catch {
        /* swallow */
      }
    }

    const { error } = await sb.from('mfg_so_audit_log').insert({
      so_doc_no:           args.docNo,
      action:              args.action,
      actor_id:            args.actorId ?? null,
      actor_name_snapshot: actorName,
      field_changes:       args.fieldChanges ?? [],
      status_snapshot:     args.statusSnapshot ?? null,
      source:              args.source ?? 'web',
      note:                args.note ?? null,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[so-audit] insert failed (non-fatal):', args.docNo, args.action, error.message);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[so-audit] unexpected error (non-fatal):', args.docNo, args.action, e);
  }
}

/* ──────────────────────────────────────────────────────────────────────
   diffFields — shared helper for UPDATE_DETAILS / UPDATE_LINE handlers.
   Given a `before` row (snake_case from supabase) and a `patch` body
   (camelCase from the client) plus an alias map, returns the array of
   FieldChange objects for fields that actually changed.
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
    const a = fromVal == null ? '' : String(fromVal);
    const b = toVal == null ? '' : String(toVal);
    if (a !== b) out.push({ field: camel, from: fromVal ?? null, to: toVal ?? null });
  }
  return out;
}
