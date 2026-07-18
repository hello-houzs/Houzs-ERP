// ----------------------------------------------------------------------------
// entity-audit.ts — the audit-trail writer for every SCM document that is NOT a
// Sales Order. Sibling of lib/so-audit.ts, writing scm.entity_audit_log
// (migration 0139) keyed by (entity_type, entity_id) instead of so_doc_no.
//
// Owner's rule: every edit records WHO, WHEN to the minute, and WHAT changed
// from-value -> to-value. so-audit.ts is the only place in this tree that has
// ever obeyed it; this is that same mechanism pointed at money and stock.
//
// `diffFields` is IMPORTED from so-audit rather than reimplemented. Two differs
// would drift, and the whole point of a from->to record is that both tables
// answer the question the same way.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import { diffFields, type FieldChange } from './so-audit';
import { resolveCallerStaffId } from './salesScope';

export { diffFields };
export type { FieldChange };

/* The documents this log covers. A closed union rather than a free string so a
   typo cannot silently create a second, invisible history for the same module —
   the read endpoint filters on this exact value. */
export const ENTITY_TYPES = [
  'PAYMENT_VOUCHER',
  'GRN',
  'STOCK_TAKE',
  'STOCK_TRANSFER',
  'INVENTORY_ADJUSTMENT',
  /* The document modules, added after the money/stock set. entity_type is plain
     text in migration 0139 with NO check constraint, deliberately (see the
     migration header), so extending this list needs no migration — but it is
     still the ONLY list, because the read endpoint rejects anything not in it. */
  'SALES_INVOICE',
  'PURCHASE_ORDER',
  'PURCHASE_INVOICE',
  'DELIVERY_ORDER',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(v: unknown): v is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(String(v));
}

/* Stable verbs, shared across every module. so-audit.ts uses per-module verbs
   (ADD_PAYMENT, UPDATE_LINE...) because it describes ONE document type; this log
   spans five, so the verb answers "what kind of event" and the entity_type
   answers "to what". A renderer can label six verbs; it cannot label an open set. */
export const AUDIT_ACTIONS = ['CREATE', 'UPDATE', 'POST', 'CANCEL', 'REVERSE', 'DELETE'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* The Houzs caller, as middleware/auth.ts stashes it. Deliberately structural:
   the writer needs three fields and taking the whole Variables type would couple
   every caller's import graph to Hono's context generics. */
export type AuditActor = {
  id?: number | null;
  name?: string | null;
  email?: string | null;
};

export type RecordEntityAuditArgs = {
  entityType: EntityType;
  entityId: string;
  entityDocNo?: string | null;
  action: AuditAction;
  /* The REAL Houzs user (c.get('houzsUser')), never c.get('user'). See the actor
     resolution note below — this distinction is the difference between an audit
     trail and a list of identical rows. */
  actor?: AuditActor | null;
  companyId?: number | null;
  fieldChanges?: FieldChange[];
  statusSnapshot?: string | null;
  source?: string;
  note?: string;
};

/**
 * Append one row to scm.entity_audit_log.
 *
 * BEST-EFFORT, exactly as recordSoAudit is: a failed audit insert is logged and
 * swallowed, never propagated. A GRN that received stock must not un-receive it
 * because the history row would not write.
 *
 * THE OWNER HAS NOT RULED ON WHETHER A FAILED LOG SHOULD BLOCK THE OPERATION.
 * If he decides it should, this function is the ONLY place that changes: throw
 * from the marked branch below instead of logging, and every call site inherits
 * it. Do not pre-empt that decision by making individual handlers check a return
 * value — that would scatter the policy across five files and guarantee they
 * disagree.
 */
export async function recordEntityAudit(
  sb: SupabaseClient,
  args: RecordEntityAuditArgs,
): Promise<void> {
  try {
    /* ACTOR RESOLUTION — the reason this writer takes `houzsUser` and not the
       Supabase-shaped `user`. Inside /api/scm/*, middleware/auth.ts PINS
       c.get('user').id to one seeded system staff uuid for every caller (a type
       shim: 2990's routes expect a uuid, Houzs users are integers). so-audit.ts's
       47 call sites pass that pinned id, so mfg_so_audit_log.actor_id names the
       same system row on every entry ever written — only its
       actor_name_snapshot is personalised, and that was itself a later fix.
       Copying that would ship a money-movement log whose actor column is a
       constant. The mig-0066 bridge gives every non-disabled user a real staff
       uuid; resolveCallerStaffId is the documented way to reach it. */
    let actorId: string | null = null;
    if (args.actor?.id != null) {
      try {
        actorId = await resolveCallerStaffId(sb, args.actor.id);
      } catch {
        /* swallow — an unattributed row still records WHEN and WHAT. */
      }
    }

    /* Snapshotted at write time so renaming or disabling the user later cannot
       rewrite history. Falls back to the email because a row that says WHO in
       any form beats one that says nobody. */
    const actorName = args.actor?.name ?? args.actor?.email ?? null;

    const { error } = await sb.from('entity_audit_log').insert({
      entity_type:         args.entityType,
      entity_id:           args.entityId,
      entity_doc_no:       args.entityDocNo ?? null,
      ...(args.companyId != null ? { company_id: args.companyId } : {}),
      action:              args.action,
      actor_id:            actorId,
      actor_name_snapshot: actorName,
      field_changes:       args.fieldChanges ?? [],
      status_snapshot:     args.statusSnapshot ?? null,
      source:              args.source ?? 'web',
      note:                args.note ?? null,
    });
    if (error) {
      // OWNER DECISION POINT — see the docblock. Today: log and continue.
      // eslint-disable-next-line no-console
      console.error(
        '[entity-audit] insert failed (non-fatal):',
        args.entityType, args.entityId, args.action, error.message,
      );
    }
  } catch (e) {
    // OWNER DECISION POINT — see the docblock. Today: log and continue.
    // eslint-disable-next-line no-console
    console.error(
      '[entity-audit] unexpected error (non-fatal):',
      args.entityType, args.entityId, args.action, e,
    );
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Pure helpers for building FieldChange arrays outside a patch-body diff.
   ────────────────────────────────────────────────────────────────────── */

/**
 * One explicit from->to pair, or null when nothing moved.
 *
 * MONEY IS INTEGER SEN IN THIS CODEBASE and must be recorded as the INTEGER, not
 * a formatted string: "RM 1,234.50" cannot be summed, compared or reconciled,
 * and the moment a locale changes the history becomes unparseable. Formatting is
 * the reader's job. Pass amount_centi straight in.
 */
export function fieldChange(field: string, from: unknown, to: unknown): FieldChange | null {
  const a = from == null ? '' : String(from);
  const b = to == null ? '' : String(to);
  if (a === b) return null;
  return { field, from: from ?? null, to: to ?? null };
}

/** Drop the no-ops from a hand-built list. */
export function compactChanges(changes: Array<FieldChange | null>): FieldChange[] {
  return changes.filter((c): c is FieldChange => c !== null);
}

/**
 * The from->to pair for a status transition, the shape POST / CANCEL / REVERSE
 * all record. Separate from `fieldChange` only so every module spells the field
 * name identically — a renderer keying on 'status' must not meet 'Status' too.
 */
export function statusChange(from: string | null | undefined, to: string): FieldChange[] {
  const c = fieldChange('status', from ?? null, to);
  return c ? [c] : [];
}
