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
import { hasHouzsPerm } from '../lib/houzs-perms';
import { recordSoAudit } from '../lib/so-audit';

export const soAmendments = new Hono<{ Bindings: Env; Variables: Variables }>();
soAmendments.use('*', supabaseAuth);

/* Real-caller display name for audit attribution (the scm.staff `user.id` is the
   pinned system row; user_metadata.name is the real Houzs caller). */
function actorName(user: { user_metadata?: { name?: string } } | undefined): string | null {
  return user?.user_metadata?.name ?? null;
}

/* ── GET / — amendment list (newest first) ─────────────────────────────────
   .limit(500) bounds the result so PostgREST's default 1000-row cap can't
   silently truncate — matches the SO/DO/GRN list convention. */
soAmendments.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await sb.from('so_amendments')
    .select('id, so_doc_no, amendment_no, status, reason, requested_by, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ amendments: data ?? [] });
});

/* ── GET /:id — amendment detail ───────────────────────────────────────────
   Returns: the amendment row + its so_amendment_lines + the SO header summary
   (doc_no, status, revision) + a light bound-PO summary (po_number, status). */
soAmendments.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  const [amdRes, lineRes] = await Promise.all([
    sb.from('so_amendments')
      .select('id, so_doc_no, amendment_no, status, reason, requested_by, ' +
        'supplier_confirmed_by, supplier_confirmation_ref, supplier_confirmation_note, ' +
        'supplier_confirmation_attachment_key, so_approved_by, so_approved_at, ' +
        'po_approved_by, po_approved_at, sent_at, created_at, updated_at')
      .eq('id', id).maybeSingle(),
    sb.from('so_amendment_lines')
      .select('id, amendment_id, sales_order_item_id, change_type, new_item_code, ' +
        'new_variants, new_qty, new_unit_price_sen, old_snapshot')
      .eq('amendment_id', id),
  ]);
  if (amdRes.error) return c.json({ error: 'load_failed', reason: amdRes.error.message }, 500);
  if (!amdRes.data) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRes.data as unknown as { so_doc_no: string } & Record<string, unknown>;
  const lines = (lineRes.data ?? []) as unknown as Array<Record<string, unknown>>;

  // SO header summary — doc_no, status, revision.
  const { data: soRow } = await sb.from('mfg_sales_orders')
    .select('doc_no, status, revision')
    .eq('doc_no', amendment.so_doc_no).maybeSingle();
  const salesOrder = (soRow ?? null) as { doc_no: string; status: string; revision: number } | null;

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

  const { data: amdRow } = await sb.from('so_amendments')
    .select('id, so_doc_no, status').eq('id', id).maybeSingle();
  if (!amdRow) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRow as { id: string; so_doc_no: string; status: AmendStatus };

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
    supplier_confirmed_by:                user.id,
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

  const { data: amdRow } = await sb.from('so_amendments')
    .select('id, so_doc_no, status').eq('id', id).maybeSingle();
  if (!amdRow) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRow as { id: string; so_doc_no: string; status: AmendStatus };

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
    applied = await applySoAmendment(sb, id, user.id);
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
    so_approved_by: user.id,
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

  const { data: amdRow } = await sb.from('so_amendments')
    .select('id, so_doc_no, status').eq('id', id).maybeSingle();
  if (!amdRow) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRow as { id: string; so_doc_no: string; status: AmendStatus };

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
    revised = await reviseBoundPo(sb, id, user.id);
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
    po_approved_by: user.id,
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

  const { data: amdRow } = await sb.from('so_amendments')
    .select('id, so_doc_no, status').eq('id', id).maybeSingle();
  if (!amdRow) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRow as { id: string; so_doc_no: string; status: AmendStatus };

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

  const { data: amdRow } = await sb.from('so_amendments')
    .select('id, so_doc_no, status').eq('id', id).maybeSingle();
  if (!amdRow) return c.json({ error: 'not_found' }, 404);
  const amendment = amdRow as { id: string; so_doc_no: string; status: AmendStatus };

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
