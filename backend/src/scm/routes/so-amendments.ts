// /so-amendments — SO amendment / revision workflow (port of 2990 so-amendments.ts).
//
// An amendment lets a salesperson change a PROCESSING-LOCKED Sales Order through a
// supplier-confirmed, two-gate state machine (REQUESTED → SUPPLIER_PENDING →
// SO_APPROVED → PO_APPROVED → SENT / REJECTED). The pure state machine + transition
// guards live in ../shared (so-amendment.ts) — this router imports canTransition /
// nextStatus, it does NOT redefine them.
//
// The CREATE endpoint (POST /mfg-sales-orders/:docNo/amendments) is NOT here: it
// lives on the mfgSalesOrders router so its URL nests under the SO mount and it can
// reuse that file's private SO guards (soProcessingLocked / soHasDownstream). This
// module carries list + detail + supplier-confirm + approve-so / approve-po / send
// / reject.
//
// Houzs gate adaptation: 2990's scm.staff.role gates are DEAD here (the SCM bridge
// pins every caller to one super_admin row — see scm/middleware/auth.ts), so every
// gate is `hasHouzsPerm(c, '<flat key>')` against the REAL Houzs caller. Audit rows
// route through recordSoAudit (resolves the NOT-NULL mfg_so_audit_log.company_id).

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { canTransition, nextStatus, type AmendStatus, type AmendAction } from '../shared';
import { applySoAmendment, reviseBoundPo, ReceivedFloorError } from '../lib/so-revision';
import { hasHouzsPerm, canViewAllSales, canWriteScmConfig } from '../lib/houzs-perms';
import { resolveSalesScopeIds, salesDocOutOfScope, resolveCallerStaffId } from '../lib/salesScope';
import { recordSoAudit } from '../lib/so-audit';
import { scopeToCompany, isMirroredDocNo, MIRRORED_SO_READONLY, activeCompanyId } from '../lib/companyScope';
import {
  enqueueAmendmentCommand,
  commandsEnabled,
  dispatchOne,
} from '../lib/amendment-command';
import { readBridgeCommandConfig, probeBridge } from '../lib/bridge-2990-command';
import type { Context } from 'hono';

export const soAmendments = new Hono<{ Bindings: Env; Variables: Variables }>();
soAmendments.use('*', supabaseAuth);

/* Real-caller display name for audit attribution (the scm.staff `user.id` is the
   pinned system row; user_metadata.name is the real Houzs caller). */
function actorName(user: { user_metadata?: { name?: string } } | undefined): string | null {
  return user?.user_metadata?.name ?? null;
}

/* The gate columns (supplier_confirmed_by / so_approved_by / po_approved_by)
   are scm.staff FKs the UI renders as "who did this". `user.id` is the bridge's
   pinned system row shared by EVERY caller, so stamping it made all three read
   as one system identity — the same defect the salesperson_id / requested_by
   stamps carried. Resolve the caller's real mig-0066 staff row; fall back to
   the pinned row when the sync row is missing so the FK stays valid. */
async function gateActorStaffId(
  sb: any,
  houzsUserId: number | null | undefined,
  fallbackStaffId: string,
): Promise<string> {
  return (await resolveCallerStaffId(sb, houzsUserId)) ?? fallbackStaffId;
}

type AmendmentForWrite = { id: string; so_doc_no: string; status: AmendStatus };
type AmendmentWriteLoad =
  // A Houzs-NATIVE amendment: apply locally, exactly as before.
  | { ok: true; mirrored: false; amendment: AmendmentForWrite }
  // A MIRRORED (2990-) amendment: the intent is dispatched as a command to
  // 2990's own API, never applied here (see dispatchMirroredCommand).
  | { ok: true; mirrored: true; amendment: AmendmentForWrite }
  | { ok: false; reason: 'not_found' };

/* ── loadAmendmentForWrite — the guard load every mutation gate shares ──────
   The list (GET /) and detail (GET /:id) reads above are company-scoped; the
   five mutation gates below used to load with a bare `.eq('id', id)`, so a
   caller whose active company was HOUZS could drive a 2990 amendment through
   its whole state machine by id alone. approve-so / approve-po are not status
   flips — they re-derive the SO's lines and the bound PO's lines and totals —
   so the unscoped load handed one company's user a financial rewrite of the
   other's document. Scope the mutation the way the reads are scoped, and 404
   rather than 403 so an out-of-company id is indistinguishable from a
   nonexistent one (the convention salesDocOutOfScope already set).

   Second axis: a MIRRORED (2990-) amendment is NOT applied here. Houzs is not
   the writer of 2990's records — applySoAmendment would rewrite a mirrored SO
   that the next 2990 drain silently reverts (F2). Previously this refused with
   409 MIRRORED_SO_READONLY. Now the refusal is REPLACED by intent-dispatch
   (design §3.2/D2): the gate hands the action to dispatchMirroredCommand, which
   calls 2990's OWN API so 2990 applies it with 2990's logic, and the result
   flows back down the existing mirror. When the feature is dark (flag off /
   bridge unconfigured), dispatchMirroredCommand restores the exact 409 refusal —
   so read-only-in-Houzs stays the default until the command channel is enabled. */
async function loadAmendmentForWrite(
  sb: any,
  id: string,
  c: Context<any>,
): Promise<AmendmentWriteLoad> {
  const { data } = await scopeToCompany(
    sb.from('so_amendments').select('id, so_doc_no, status').eq('id', id),
    c,
  ).maybeSingle();
  if (!data) return { ok: false, reason: 'not_found' };
  const amendment = data as AmendmentForWrite;
  return { ok: true, mirrored: isMirroredDocNo(amendment.so_doc_no), amendment };
}

/* ── dispatchMirroredCommand — turn an approve/reject INTENT on a 2990
   amendment into a command, instead of a local write (design §3.2/D2).

   Enqueue-then-drain, so the user is never blocked on a cross-system call: we
   write the durable sync_command row, fire ONE inline attempt on waitUntil, and
   return 202. The state change appears when the existing mirror delivers 2990's
   new status back down. A failed dispatch stays retryable and the every-5-min cron drain
   finishes it — nothing is fire-and-forget.

   Ships dark: with the flag off OR the bridge unconfigured, the mirrored
   amendment is refused read-only exactly as it was before this build. */
async function dispatchMirroredCommand(
  c: Context<any>,
  sb: any,
  amendment: AmendmentForWrite,
  action: AmendAction,
  payload: Record<string, unknown>,
) {
  if (!(await commandsEnabled(sb))) {
    // Feature dark — mirrored amendments remain read-only in Houzs.
    return c.json(MIRRORED_SO_READONLY, 409);
  }
  const cfg = readBridgeCommandConfig(c.env);
  if (!cfg.ok) {
    // The bridge is not set up, so this could never be delivered. Refuse rather
    // than queue a command that can only ever fail — and say so plainly.
    return c.json({
      error: 'bridge_not_configured',
      message: 'The connection to 2990 is not set up yet, so this change cannot be sent to 2990. Nothing was queued.',
      missing: cfg.missing,
    }, 503);
  }

  let enq;
  try {
    enq = await enqueueAmendmentCommand(sb, {
      // The mirrored row's id IS 2990's uuid (D4, verbatim) — it addresses the
      // right 2990 row with no translation.
      entityKey: amendment.id,
      action,
      payload,
      // The REAL Houzs caller — the authoritative approver (§3.5, requirement 3).
      // NEVER the pinned SCM system `user` (the pos-cart leak #633 class).
      requestedBy: c.get('houzsUser')?.id ?? null,
      companyId: activeCompanyId(c) ?? null,
    });
  } catch {
    return c.json({
      error: 'command_enqueue_failed',
      message: 'Could not queue the change for 2990. Please try again.',
    }, 500);
  }

  // One inline, non-blocking attempt for the happy path (sub-second). Only when
  // still PENDING — a duplicate decision that is already in-flight or resolved
  // (idempotency key) must not be re-fired.
  if (enq.row.status === 'PENDING') {
    const p = dispatchOne(sb, cfg.config, enq.row);
    try { c.executionCtx.waitUntil(p); } catch { void p; }
  }

  // Houzs-side audit of WHO dispatched — the real caller by name (requirement 3).
  // The authoritative id is sync_command.requested_by; the name is snapshotted
  // here. actorId is left null so nothing implies the pinned system row acted.
  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: `AMENDMENT_CMD_${action.toUpperCase().replace(/-/g, '_')}`,
    actorId: null,
    actorName: c.get('houzsUser')?.name ?? null,
    fieldChanges: [{ field: 'command', to: action }],
    note: `Dispatched to 2990 as command ${enq.row.id} (requested by Houzs user ${c.get('houzsUser')?.id ?? 'unknown'}).`,
  });

  return c.json({
    pending: true,
    command: { id: enq.row.id, action, status: enq.row.status },
    message: 'Sent to 2990. The updated status will appear here shortly.',
  }, 202);
}

/* ── GET / — amendment list (newest first) ─────────────────────────────────
   .limit(500) bounds the result so PostgREST's default 1000-row cap can't
   silently truncate — matches the SO/DO/GRN list convention.

   Row-level scope (Owner 2026-07-16) — a salesperson must see the amendments
   for THEIR OWN Sales Orders (they raise them), so the area guard admits them
   (scmAreaGuard scm.sales.orders has an isSalesStaff bypass). But an amendment
   carries no salesperson_id of its own, so without scoping a rep would see
   EVERY rep's amendments. Filter the loaded amendments down to those whose
   bound SO falls in the caller's own+downline sales scope — the SAME
   self+downline tiering the SO list/detail uses. View-all callers (directors /
   office / `*`) are unrestricted (resolveSalesScopeIds → null). */
soAmendments.get('/', async (c) => {
  const sb = c.get('supabase');
  // scopeToCompany: isolate the list to the active company (mig 0080 company_id);
  // no-op pre-activation so single-company Houzs is unchanged.
  const { data, error } = await scopeToCompany(sb.from('so_amendments')
    .select('id, so_doc_no, amendment_no, status, reason, requested_by, created_at, updated_at'), c)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  let rows = (data ?? []) as Array<{ so_doc_no?: string | null }>;
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  if (scopeIds && rows.length > 0) {
    // Resolve which of the listed amendments' SOs the caller may see — a single
    // bounded query over the ≤500 doc_nos on the page (salesperson_id ∈ scope).
    const docNos = [...new Set(rows.map((r) => r.so_doc_no).filter((x): x is string => !!x))];
    const { data: soRows } = await scopeToCompany(sb.from('mfg_sales_orders')
      .select('doc_no')
      .in('doc_no', docNos)
      .in('salesperson_id', scopeIds), c);
    const allowed = new Set(((soRows ?? []) as Array<{ doc_no: string }>).map((r) => r.doc_no));
    rows = rows.filter((r) => r.so_doc_no != null && allowed.has(r.so_doc_no));
  }
  return c.json({ amendments: rows });
});

/* ── GET /command-diag — the owner's dry-run for the write-back channel ─────
   Cannot be verified without a live 2990 bridge account, so this is how the
   owner checks it once the account exists (same idea as the mirror probes). It
   reports: the DB kill-switch state, which bridge secrets are set, and — with
   ?probe=true — an end-to-end read-only check (sign in as the bridge user, then
   GET 2990's amendment list with that JWT). It NEVER dispatches a command and
   NEVER mutates anything on either side. Registered BEFORE GET /:id so the
   static path wins over the :id param. Gated to scm.config.write (owner-level),
   like maintenance-push/diff, because it exercises the 2990 connection. */
soAmendments.get('/command-diag', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', message: 'You do not have permission to view the 2990 connection diagnostics.' }, 403);
  }
  const sb = c.get('supabase');
  const enabled = await commandsEnabled(sb);
  const cfg = readBridgeCommandConfig(c.env);

  const base: Record<string, unknown> = {
    commandsEnabled: enabled,
    bridgeConfigured: cfg.ok,
    missingSecrets: cfg.ok ? [] : cfg.missing,
    note: 'commandsEnabled is the scm.sync_config row mirror_commands_enabled = true. Both must be true (and the probe green) before Houzs can drive a 2990 amendment.',
  };

  if (c.req.query('probe') !== 'true' || !cfg.ok) {
    return c.json(base);
  }
  const probe = await probeBridge(cfg.config);
  return c.json({ ...base, probe });
});

/* ── GET /:id — amendment detail ───────────────────────────────────────────
   Returns: the amendment row + its so_amendment_lines + the SO header summary
   (doc_no, status, revision) + a light bound-PO summary (po_number, status). */
soAmendments.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  const [amdRes, lineRes] = await Promise.all([
    // scopeToCompany: detail read isolated to the active company (mig 0080); no-op pre-activation.
    scopeToCompany(sb.from('so_amendments')
      .select('id, so_doc_no, amendment_no, status, reason, requested_by, ' +
        'supplier_confirmed_by, supplier_confirmation_ref, supplier_confirmation_note, ' +
        'supplier_confirmation_attachment_key, so_approved_by, so_approved_at, ' +
        'po_approved_by, po_approved_at, sent_at, created_at, updated_at, ' +
        // mig 0119 — the HEADER half of the request (Delivery Date / Processing
        // Date / State / Postcode) + its before-snapshot. NULL on a line-only
        // amendment. Without these the approver could not SEE a requested date
        // change, only line diffs.
        'header_changes, old_header_snapshot')
      .eq('id', id), c).maybeSingle(),
    sb.from('so_amendment_lines')
      .select('id, amendment_id, sales_order_item_id, change_type, new_item_code, ' +
        'new_variants, new_qty, new_unit_price_sen, old_snapshot')
      .eq('amendment_id', id),
  ]);
  if (amdRes.error) return c.json({ error: 'load_failed', reason: amdRes.error.message }, 500);
  if (!amdRes.data) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRes.data as unknown as { so_doc_no: string } & Record<string, unknown>;
  const lines = (lineRes.data ?? []) as unknown as Array<Record<string, unknown>>;

  // SO header summary — doc_no, status, revision (+ salesperson_id for the scope
  // check below).
  const { data: soRow } = await sb.from('mfg_sales_orders')
    .select('doc_no, status, revision, salesperson_id')
    .eq('doc_no', amendment.so_doc_no).maybeSingle();
  const salesOrder = (soRow ?? null) as
    { doc_no: string; status: string; revision: number; salesperson_id?: number | string | null } | null;

  /* Row-level scope (Owner 2026-07-16) — a scoped salesperson may open only an
     amendment for a Sales Order in their own+downline scope; anything else 404s
     (indistinguishable from a nonexistent id), mirroring the SO detail read.
     View-all callers pass. */
  if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), salesOrder?.salesperson_id)) {
    return c.json({ error: 'not_found' }, 404);
  }

  /* Light bound-PO summary — the PO(s) whose lines were derived from this SO's
     lines (purchase_order_items.so_item_id → mfg_sales_order_items.id). */
  let purchaseOrders: Array<{ id: string; po_number: string; status: string }> = [];
  const { data: soItemRows } = await sb.from('mfg_sales_order_items')
    .select('id').eq('doc_no', amendment.so_doc_no);
  const soItemIds = ((soItemRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (soItemIds.length > 0) {
    const { data: poItemRows } = await sb.from('purchase_order_items')
      .select('purchase_order_id').in('so_item_id', soItemIds);
    const poIds = [...new Set(((poItemRows ?? []) as Array<{ purchase_order_id: string | null }>)
      .map((r) => r.purchase_order_id).filter((x): x is string => Boolean(x)))];
    if (poIds.length > 0) {
      const { data: poRows } = await sb.from('purchase_orders')
        .select('id, po_number, status').in('id', poIds);
      purchaseOrders = (poRows ?? []) as Array<{ id: string; po_number: string; status: string }>;
    }
  }

  return c.json({ amendment, lines, salesOrder, purchaseOrders });
});

/* ── PATCH /:id/supplier-confirm ───────────────────────────────────────────
   Record the supplier's acknowledgement of the requested change. Body:
   { ref, note?, attachmentKey? }. Gated to scm.amendment.supplier_confirm.
   Transition REQUESTED → SUPPLIER_PENDING via the shared state machine. */
soAmendments.patch('/:id/supplier-confirm', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.amendment.supplier_confirm')) {
    return c.json({
      error: 'supplier_confirm_forbidden',
      message: 'You do not have permission to record a supplier confirmation.',
    }, 403);
  }

  let body: { ref?: string; note?: string; attachmentKey?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!ref) return c.json({ error: 'ref_required', reason: 'A supplier confirmation reference is required.' }, 400);

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) {
    return dispatchMirroredCommand(c, sb, loaded.amendment, 'supplier-confirm', {
      ref, note: body.note, attachmentKey: body.attachmentKey,
    });
  }
  const { amendment } = loaded;

  const action: AmendAction = 'supplier-confirm';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot record a supplier confirmation from status ${amendment.status}.`,
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:                               to,
    supplier_confirmed_by:                await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    supplier_confirmation_ref:            ref,
    supplier_confirmation_note:           body.note ?? null,
    supplier_confirmation_attachment_key: body.attachmentKey ?? null,
    updated_at:                           new Date().toISOString(),
  }).eq('id', id).select('id, so_doc_no, amendment_no, status').single();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_SUPPLIER_CONFIRMED',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [{ field: 'amendment_status', from: amendment.status, to }],
    note: ref,
  });

  return c.json({ amendment: updated });
});

/* ── PATCH /:id/approve-so ─────────────────────────────────────────────────
   The first hard gate. Guard the transition (SUPPLIER_PENDING / REQUESTED →
   SO_APPROVED — the light no-supplier path may skip supplier-confirm), then
   RE-DERIVE the SO: snapshot the current version to so_revisions, apply the line
   diffs to mfg_sales_order_items, RE-RUN the honest-pricing recompute
   (applySoAmendment), bump mfg_sales_orders.revision, and audit.

   If the SO has NO bound PO this is the TERMINAL step — the amendment rests at
   SO_APPROVED. */
soAmendments.patch('/:id/approve-so', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.amendment.approve_so')) {
    return c.json({
      error: 'approve_so_forbidden',
      message: 'You do not have permission to approve a Sales Order revision.',
    }, 403);
  }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) return dispatchMirroredCommand(c, sb, loaded.amendment, 'approve-so', {});
  const { amendment } = loaded;

  const action: AmendAction = 'approve-so';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot approve the SO revision from status ${amendment.status}.`,
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  /* Apply the revision. A hard failure leaves the amendment status unchanged (we
     only advance status AFTER a clean apply) so the operator can retry — the
     snapshot upsert is idempotent on (so_doc_no, revision). */
  let applied: { soDocNo: string; revision: number };
  try {
    applied = await applySoAmendment(sb, id, user.id, c);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[so-amendment] approve-so apply failed:', e);
    return c.json({
      error: 'apply_failed',
      reason: e instanceof Error ? e.message : 'Failed to apply the SO revision.',
    }, 500);
  }

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:         to,
    so_approved_by: await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    so_approved_at: new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  }).eq('id', id).select('id, so_doc_no, amendment_no, status').single();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);

  return c.json({ amendment: updated, revision: applied.revision });
});

/* ── PATCH /:id/approve-po ─────────────────────────────────────────────────
   The second hard gate. Guard the transition (SO_APPROVED → PO_APPROVED), then
   RE-DERIVE the bound PO(s): reviseBoundPo snapshots each live bound PO to
   po_revisions, re-derives its lines from the NOW-REVISED SO lines, recomputes
   totals, bumps purchase_orders.revision, and audits.

   Received floor: reviseBoundPo throws a ReceivedFloorError BEFORE mutating if
   any revised qty would drop below that PO line's already-received_qty → 409. */
soAmendments.patch('/:id/approve-po', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.amendment.approve_po')) {
    return c.json({
      error: 'approve_po_forbidden',
      message: 'You do not have permission to approve a Purchase Order revision.',
    }, 403);
  }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) return dispatchMirroredCommand(c, sb, loaded.amendment, 'approve-po', {});
  const { amendment } = loaded;

  const action: AmendAction = 'approve-po';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot approve the PO revision from status ${amendment.status}.`,
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  let revised: Awaited<ReturnType<typeof reviseBoundPo>>;
  try {
    revised = await reviseBoundPo(sb, id, user.id, c);
  } catch (e) {
    if (e instanceof ReceivedFloorError) {
      return c.json({
        error: 'received_floor',
        code: e.code,
        poItemId: e.poItemId,
        revisedQty: e.revisedQty,
        receivedQty: e.receivedQty,
        reason: e.message,
      }, 409);
    }
    // eslint-disable-next-line no-console
    console.error('[so-amendment] approve-po revise failed:', e);
    return c.json({
      error: 'revise_failed',
      reason: e instanceof Error ? e.message : 'Failed to revise the bound PO.',
    }, 500);
  }

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:         to,
    po_approved_by: await gateActorStaffId(sb, c.get('houzsUser')?.id, user.id),
    po_approved_at: new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  }).eq('id', id).select('id, so_doc_no, amendment_no, status').single();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_PO_APPROVED',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [
      { field: 'amendment_status', from: amendment.status, to },
      { field: 'pos_revised', to: revised.perPo.map((p) => p.poNumber).join(', ') || 'none' },
    ],
    note: revised.perPo.length
      ? `Revised PO(s): ${revised.perPo.map((p) => `${p.poNumber} rev ${p.revision}`).join('; ')}`
      : 'No bound PO — nothing to revise.',
  });

  return c.json({ amendment: updated, revisedPurchaseOrders: revised.perPo });
});

/* ── PATCH /:id/send ───────────────────────────────────────────────────────
   The terminal happy-path step. Guard the transition (PO_APPROVED → SENT), then
   stamp sent_at. Houzs has NO server-side PO-PDF / doc-email path (the PO PDF is
   produced client-side in the SPA), so the actual Revised-PO delivery is
   performed by the frontend once this gate flips to SENT. Gated to
   scm.amendment.approve_po (same purchasing gate as approve-po). */
soAmendments.patch('/:id/send', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.amendment.approve_po')) {
    return c.json({
      error: 'send_forbidden',
      message: 'You do not have permission to send the revised Purchase Order.',
    }, 403);
  }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) return dispatchMirroredCommand(c, sb, loaded.amendment, 'send', {});
  const { amendment } = loaded;

  const action: AmendAction = 'send';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot send the revised PO from status ${amendment.status}.`,
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:     to,
    sent_at:    new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id).select('id, so_doc_no, amendment_no, status').single();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_SENT',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [{ field: 'amendment_status', from: amendment.status, to }],
    note: 'Revised PO marked sent to supplier.',
  });

  return c.json({ amendment: updated });
});

/* ── PATCH /:id/reject ─────────────────────────────────────────────────────
   Reject an in-flight amendment from ANY pre-approved gate (REQUESTED /
   SUPPLIER_PENDING / SO_APPROVED / PO_APPROVED). NO document changes: the SO/PO
   are untouched, the amendment simply closes as REJECTED (freeing the one-open
   partial unique index so a fresh amendment can be raised). Gated to
   scm.amendment.approve_po. */
soAmendments.patch('/:id/reject', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  if (!hasHouzsPerm(c, 'scm.amendment.approve_po')) {
    return c.json({
      error: 'reject_forbidden',
      message: 'You do not have permission to reject an amendment.',
    }, 403);
  }

  let body: { reason?: string } = {};
  try { body = (await c.req.json()) as typeof body; } catch { /* reason is optional */ }

  const loaded = await loadAmendmentForWrite(sb, id, c);
  if (!loaded.ok) return c.json({ error: 'not_found' }, 404);
  if (loaded.mirrored) {
    return dispatchMirroredCommand(c, sb, loaded.amendment, 'reject',
      typeof body.reason === 'string' && body.reason.trim() ? { reason: body.reason.trim() } : {});
  }
  const { amendment } = loaded;

  const action: AmendAction = 'reject';
  if (!canTransition(amendment.status, action)) {
    return c.json({
      error: 'bad_transition',
      reason: `Cannot reject an amendment from status ${amendment.status}.`,
    }, 409);
  }
  const to = nextStatus(amendment.status, action);
  if (!to) return c.json({ error: 'bad_transition' }, 409);

  const { data: updated, error: updErr } = await sb.from('so_amendments').update({
    status:     to,
    updated_at: new Date().toISOString(),
  }).eq('id', id).select('id, so_doc_no, amendment_no, status').single();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);

  await recordSoAudit(sb, {
    docNo: amendment.so_doc_no,
    action: 'AMENDMENT_REJECTED',
    actorId: user.id,
    actorName: actorName(user),
    fieldChanges: [{ field: 'amendment_status', from: amendment.status, to }],
    note: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Amendment rejected.',
  });

  return c.json({ amendment: updated });
});
