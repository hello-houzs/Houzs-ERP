// ----------------------------------------------------------------------------
// SO amendment apply-revision helpers — port of 2990 apps/api/src/lib/so-revision.ts.
//
// `applySoAmendment` is the Approve-SO gate's engine: it freezes the current SO
// as an immutable `so_revisions` snapshot, applies the amendment's line diffs
// (SPEC / QTY / ADD / REMOVE) to `mfg_sales_order_items`, then RE-RUNS the
// server-side honest-pricing recompute on every surviving line — the SAME pricing
// path POST /mfg-sales-orders uses (never skip / never reinvent the recompute).
//
// Pricing reuse — how this mirrors POST /mfg-sales-orders:
//   • Per line: `recomputeOneLine(sb, item, cachedConfig)` (mfg-pricing-recompute).
//     Loads product + fabric + MaintenanceConfig + sofa module prices + selling
//     tiers + fabric-tier config + per-Model / per-compartment Δ overrides, then
//     calls the pure recompute → computeMfgLinePrice / computeMfgLineCost. Persists
//     the same columns the create path writes (unit/total/cost/margin + divan/leg/
//     special/custom breakdown).
//   • Delivery fee + header totals: `rederiveDeliveryFee(sb, docNo)`
//     (mfg-sales-orders.ts) — re-runs computeSoDeliveryFee over the SO's CURRENT
//     items (rebuilding SVC-DELIVERY* lines) and folds recomputeTotals.
//
// Houzs adaptations vs 2990 (Houzs SCM is a vendored 2990 clone):
//   • The per-line delivery date column on mfg_sales_order_items is
//     `line_delivery_date` in Houzs (2990's column was `delivery_date`). The bound
//     PO line's own delivery date column stays `delivery_date`.
//   • Imports are Houzs-relative ('../shared', './mfg-pricing-recompute', …).
//   • Audit rows route through recordSoAudit (which resolves the NOT-NULL
//     mfg_so_audit_log.company_id from the SO) — never a raw audit insert.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import { buildVariantSummary, receivedFloorViolation } from '../shared';
import {
  loadMaintenanceConfig,
  recomputeOneLine,
  type MfgItemForRecompute,
} from './mfg-pricing-recompute';
import { recordSoAudit } from './so-audit';
import { deriveMfgPoUnitCost } from './po-pricing';
import {
  rederiveDeliveryFee,
  deriveCountryFromState,
  deriveSalesLocationFromState,
  deriveWarehouseIdFromState,
} from '../routes/mfg-sales-orders';
import { activeCompanyId, isMirroredDocNo } from './companyScope';

/* The Supabase client threaded through the routes is loosely typed (`any` in
   every sibling helper — see mfg-pricing-recompute.ts / so-audit callers). Keep
   the same shape so this file composes with them without a type fight. */
type Sb = any;

type AmendmentRow = {
  id: string;
  so_doc_no: string;
  status: string;
  /* mig 0119 — the HEADER half of the request: { camelCaseKey: newValue|null }
     for the frozen columns only. NULL on a line-only amendment. */
  header_changes?: Record<string, string | null> | null;
};

/* ── assertNotMirrored — the last gate before either engine mutates ─────────
   Both engines below rewrite a Sales Order and its bound PO from an amendment
   id. If that SO is 2990's, the next 2990 mirror drain re-applies 2990's
   version over the top — header upsert plus delete-then-reinsert of every line
   — so the whole re-derivation vanishes with no error and no alarm, and the
   operator is left believing an approval landed that did not (see the
   MIRRORED_COMPANY_CODE block in lib/companyScope.ts).

   The route gate in routes/so-amendments.ts already refuses these, so this is
   defence in depth — but it belongs HERE too, because these are exported
   library functions reachable from any future caller, and because the doc-no
   marker needs no Context: the guard still holds on the `c`-less call the
   signature allows, where a company_id lookup would silently no-op. */
function assertNotMirrored(docNo: string, fn: string): void {
  if (isMirroredDocNo(docNo)) {
    throw new Error(`${fn}: ${docNo} belongs to 2990 and cannot be revised from Houzs`);
  }
}

/* The frozen header columns an amendment may carry, keyed by the camelCase
   payload name -> column. MIRRORS AMENDABLE_HEADER_FIELDS in
   routes/mfg-sales-orders.ts (the create-time trust boundary that already
   rejected any unlisted key). Re-checked here so a row written before/outside
   that validation can never write an arbitrary column on approve — this is the
   LAST gate before the value lands on the SO. */
const AMENDABLE_HEADER_FIELDS: Record<string, string> = {
  internalExpectedDd:   'internal_expected_dd',
  customerDeliveryDate: 'customer_delivery_date',
  customerState:        'customer_state',
  postcode:             'postcode',
};

type AmendmentLineRow = {
  id: string;
  sales_order_item_id: string | null;
  change_type: string;                 // SPEC | QTY | ADD | REMOVE
  new_item_code: string | null;
  new_variants: Record<string, unknown> | null;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  old_snapshot: Record<string, unknown> | null;
};

/* ── snapshotSo ─────────────────────────────────────────────────────────────
   Freeze the SO's CURRENT state (header + all items) into a `so_revisions` row
   at the SO's CURRENT `revision`, so the version being replaced stays immutable.
   Returns the NEXT revision number (current + 1) for the caller to stamp on the
   SO after applying the diffs.

   Idempotent-safe: the `uq_so_revision (so_doc_no, revision)` unique index means
   a re-run at the same revision no-ops on conflict (ignoreDuplicates) rather
   than doubling the snapshot — so an Approve-SO retry after a mid-apply failure
   can't create two snapshots at the same counter. */
export async function snapshotSo(
  sb: Sb,
  docNo: string,
  amendmentId?: string | null,
  userId?: string | null,
  c?: Context<any>,
): Promise<number> {
  const { data: header, error: hErr } = await sb
    .from('mfg_sales_orders')
    .select('*')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (hErr) throw new Error(`snapshotSo: header load failed: ${hErr.message}`);
  if (!header) throw new Error(`snapshotSo: SO ${docNo} not found`);

  const currentRevision =
    typeof (header as { revision?: unknown }).revision === 'number'
      ? (header as { revision: number }).revision
      : 1;

  const { data: lines, error: lErr } = await sb
    .from('mfg_sales_order_items')
    .select('*')
    .eq('doc_no', docNo)
    .order('line_no', { ascending: true, nullsFirst: true });
  if (lErr) throw new Error(`snapshotSo: lines load failed: ${lErr.message}`);

  const snapshot = {
    header,
    lines: lines ?? [],
    snapshotAt: new Date().toISOString(),
  };

  const { error: insErr } = await sb
    .from('so_revisions')
    .upsert(
      {
        so_doc_no:    docNo,
        revision:     currentRevision,
        snapshot,
        amendment_id: amendmentId ?? null,
        created_by:   userId ?? null,
        // company_id: active company (mig 0080 nullable column); no-op pre-activation.
        company_id:   c ? activeCompanyId(c) : undefined,
      },
      { onConflict: 'so_doc_no,revision', ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`snapshotSo: revision insert failed: ${insErr.message}`);

  return currentRevision + 1;
}

/* ── applySoAmendment ───────────────────────────────────────────────────────
   The Approve-SO engine. Load the amendment + its line diffs + the SO; snapshot
   the current SO; apply each diff to mfg_sales_order_items carrying ALL variant
   columns; re-run the honest-pricing recompute on every surviving line via the
   SAME shared path POST /mfg-sales-orders uses; re-derive the delivery fee +
   header totals; bump the SO's revision; write an audit row.

   Returns the applied revision + the affected SO doc_no. Throws on a hard
   failure (load / write) — the caller (approve-so route) leaves the amendment
   status unchanged so the operator can retry. */
export async function applySoAmendment(
  sb: Sb,
  amendmentId: string,
  userId: string | null,
  c?: Context<any>,
): Promise<{ soDocNo: string; revision: number }> {
  // (1) Load amendment + lines + SO header.
  const { data: amdRow, error: amdErr } = await sb
    .from('so_amendments')
    .select('id, so_doc_no, status, header_changes')
    .eq('id', amendmentId)
    .maybeSingle();
  if (amdErr) throw new Error(`applySoAmendment: amendment load failed: ${amdErr.message}`);
  if (!amdRow) throw new Error('applySoAmendment: amendment not found');
  const amendment = amdRow as AmendmentRow;
  const docNo = amendment.so_doc_no;
  assertNotMirrored(docNo, 'applySoAmendment');

  const { data: lineRows, error: lineErr } = await sb
    .from('so_amendment_lines')
    .select('id, sales_order_item_id, change_type, new_item_code, new_variants, ' +
      'new_qty, new_unit_price_sen, old_snapshot')
    .eq('amendment_id', amendmentId);
  if (lineErr) throw new Error(`applySoAmendment: amendment lines load failed: ${lineErr.message}`);
  const amendmentLines = (lineRows ?? []) as AmendmentLineRow[];

  // (2) Snapshot the CURRENT SO before touching a single line. Returns the next
  //     revision to stamp once the diffs land.
  const nextRevision = await snapshotSo(sb, docNo, amendmentId, userId, c);

  // Multi-company: an ADD-line diff inserts a new mfg_sales_order_items row —
  // it inherits the SO header's company (NOT the request's active company: an
  // amendment may be approved while another company is active).
  /* Throws, like every other load in this function (and per its docblock) — the
     approve-so route catches it, leaves the amendment status unchanged and lets the
     operator retry; snapshotSo's upsert is idempotent on (so_doc_no, revision), so
     the retry is clean. This read was the one exception, and `?? null` does not
     fail closed: the ADD-line insert below OMITS company_id when this is null, and
     mig 0091 gave the column a HOUZS DEFAULT — so a blip books a 2990 order's new
     line to Houzs, silently, exactly as the note on that insert warns. */
  const { data: soHdrCo, error: soHdrCoErr } = await sb.from('mfg_sales_orders')
    .select('company_id').eq('doc_no', docNo).maybeSingle();
  if (soHdrCoErr) throw new Error(`applySoAmendment: SO company load failed: ${soHdrCoErr.message}`);
  const soCompanyId = (soHdrCo as { company_id?: number | null } | null)?.company_id ?? null;

  // Config loaded ONCE and threaded into every per-line recompute (the create
  // path's `cachedConfig` — one maintenance_config read for the whole apply).
  const cachedConfig = await loadMaintenanceConfig(sb);

  /* (3) Apply each line diff to mfg_sales_order_items, carrying ALL variant
     columns. SPEC rewrites item_code + variants (+ optional qty/price); QTY
     rewrites qty; ADD inserts a new line; REMOVE deletes the line. Each write
     that changes/adds a priced line is followed by (4) the honest-pricing
     recompute so unit/cost/margin/breakdown columns stay authoritative. */
  const touched: Array<{ change: string; itemCode: string; qty: number }> = [];

  for (const diff of amendmentLines) {
    const change = String(diff.change_type ?? '').toUpperCase();

    if (change === 'REMOVE') {
      if (!diff.sales_order_item_id) continue;
      const { error: delErr } = await sb
        .from('mfg_sales_order_items')
        .delete()
        .eq('id', diff.sales_order_item_id)
        .eq('doc_no', docNo);
      if (delErr) throw new Error(`applySoAmendment: REMOVE failed for line ${diff.sales_order_item_id}: ${delErr.message}`);
      touched.push({ change, itemCode: String(diff.old_snapshot?.item_code ?? ''), qty: 0 });
      continue;
    }

    if (change === 'ADD') {
      const itemCode = String(diff.new_item_code ?? '').trim();
      if (!itemCode) throw new Error('applySoAmendment: ADD line has no new_item_code');
      const variants = (diff.new_variants ?? null) as Record<string, unknown> | null;
      const itemGroup = String((variants?.itemGroup ?? diff.old_snapshot?.item_group ?? 'others')).toLowerCase();
      const qty = Math.max(1, Number(diff.new_qty ?? 1));

      // Recompute the new line authoritatively (same path as POST /).
      const rec = await recomputeOneLine(sb, {
        itemCode,
        itemGroup,
        qty,
        unitPriceCenti: Number(diff.new_unit_price_sen ?? 0),
        variants: (variants as MfgItemForRecompute['variants']) ?? null,
      }, cachedConfig, soCompanyId);

      const unit = rec.unit_price_sen;
      const lineTotal = qty * unit;
      const unitCost = rec.unit_cost_sen;
      const lineCost = unitCost * qty;

      // Multi-company (mig 0083/0091): company_id is NOT NULL with a HOUZS
      // DEFAULT — an unstamped insert silently books the line to HOUZS, so the
      // ADD line explicitly inherits the SO header's company.
      const { error: insErr } = await sb.from('mfg_sales_order_items').insert({
        ...(soCompanyId != null ? { company_id: soCompanyId } : {}),
        doc_no:                  docNo,
        line_date:              new Date().toISOString().slice(0, 10),
        item_group:             itemGroup,
        item_code:              itemCode,
        uom:                    'UNIT',
        qty,
        unit_price_centi:       unit,
        discount_centi:         0,
        total_centi:            lineTotal,
        total_inc_centi:        lineTotal,
        balance_centi:          lineTotal,
        variants,
        unit_cost_centi:        unitCost,
        line_cost_centi:        lineCost,
        line_margin_centi:      lineTotal - lineCost,
        divan_price_sen:        rec.divan_price_sen,
        leg_price_sen:          rec.leg_price_sen,
        special_order_price_sen: rec.special_order_sen,
        custom_specials:        rec.custom_specials ?? null,
        stock_status:           'PENDING',
      });
      if (insErr) throw new Error(`applySoAmendment: ADD insert failed: ${insErr.message}`);
      touched.push({ change, itemCode, qty });
      continue;
    }

    // SPEC / QTY — mutate an existing line in place, then recompute it.
    if (!diff.sales_order_item_id) continue;

    const { data: existing, error: exErr } = await sb
      .from('mfg_sales_order_items')
      .select('*')
      .eq('id', diff.sales_order_item_id)
      .eq('doc_no', docNo)
      .maybeSingle();
    if (exErr) throw new Error(`applySoAmendment: line load failed: ${exErr.message}`);
    if (!existing) continue; // line already gone — nothing to amend

    const row = existing as Record<string, unknown>;
    const itemCode = change === 'SPEC' && diff.new_item_code
      ? String(diff.new_item_code).trim()
      : String(row.item_code ?? '');
    const itemGroup = String(row.item_group ?? 'others').toLowerCase();
    const qty = diff.new_qty != null ? Math.max(1, Number(diff.new_qty)) : Math.max(1, Number(row.qty ?? 1));
    // SPEC carries new variants; QTY leaves the existing variants untouched.
    const variants = change === 'SPEC' && diff.new_variants != null
      ? (diff.new_variants as Record<string, unknown>)
      : (row.variants as Record<string, unknown> | null) ?? null;
    // The operator-authored selling price (if the diff supplies one) is fed as
    // the client unitPriceCenti; the recompute returns the authoritative figure
    // (catalog / sofa module price) for a priced line, else carries it through.
    const clientUnit = diff.new_unit_price_sen != null
      ? Number(diff.new_unit_price_sen)
      : Number(row.unit_price_centi ?? 0);

    const rec = await recomputeOneLine(sb, {
      itemCode,
      itemGroup,
      qty,
      unitPriceCenti: clientUnit,
      variants: (variants as MfgItemForRecompute['variants']) ?? null,
    }, cachedConfig, soCompanyId);

    const unit = rec.unit_price_sen;
    const discount = Number(row.discount_centi ?? 0);
    const lineTotal = (qty * unit) - discount;
    const unitCost = rec.unit_cost_sen;
    const lineCost = unitCost * qty;

    const { error: updErr } = await sb.from('mfg_sales_order_items').update({
      item_code:               itemCode,
      qty,
      variants,
      unit_price_centi:        unit,
      total_centi:             lineTotal,
      total_inc_centi:         lineTotal,
      balance_centi:           lineTotal,
      unit_cost_centi:         unitCost,
      line_cost_centi:         lineCost,
      line_margin_centi:       lineTotal - lineCost,
      divan_price_sen:         rec.divan_price_sen,
      leg_price_sen:           rec.leg_price_sen,
      special_order_price_sen: rec.special_order_sen,
      custom_specials:         rec.custom_specials ?? null,
    }).eq('id', diff.sales_order_item_id);
    if (updErr) throw new Error(`applySoAmendment: ${change} update failed for line ${diff.sales_order_item_id}: ${updErr.message}`);
    touched.push({ change, itemCode, qty });
  }

  /* (4b) Apply the HEADER half of the amendment (mig 0119, Owner 2026-07-16).
     These are the columns the processing lock FREEZES, so the direct header
     PATCH refuses them once the SO is locked — approving the amendment is the
     only way they ever change, and this is where that happens.

     Runs BEFORE rederiveDeliveryFee below because the delivery fee is computed
     from the SO's state/location: a state change must be on the row before the
     fee is re-derived, or the SO would keep a fee priced for the old state.

     Every key is re-checked against AMENDABLE_HEADER_FIELDS — the create route
     already rejects an unlisted key, this is defence in depth on the last step
     before the write. */
  const headerChanges = amendment.header_changes ?? null;
  const headerApplied: string[] = [];
  if (headerChanges && Object.keys(headerChanges).length > 0) {
    const headerUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(headerChanges)) {
      // hasOwnProperty, NOT `in` / a bare lookup — a stored key of "constructor"
      // would otherwise resolve to an inherited value and write a garbage column.
      if (!Object.prototype.hasOwnProperty.call(AMENDABLE_HEADER_FIELDS, key)) continue;
      const col = AMENDABLE_HEADER_FIELDS[key];
      headerUpdates[col] = value === '' ? null : value;
      headerApplied.push(`${col}=${value ?? 'cleared'}`);
    }

    /* State cascade — mirrors the header PATCH (mfg-sales-orders.ts) exactly:
       customer_country + sales_location follow the new State. Reuses the SAME
       exported derive helpers rather than re-deriving, so the mapping can't
       drift between the two write paths. */
    if ('customerState' in headerChanges) {
      const newState = headerChanges['customerState'] ?? null;
      headerUpdates['customer_country'] = await deriveCountryFromState(sb, newState);
      /* `c` is optional on this function's signature (it threads the active
         company into the scoped reads) — the only caller, the approve-so route,
         always passes it, but deriveSalesLocationFromState dereferences it, so
         guard rather than throw mid-apply. */
      if (c) {
        const derivedLocation = await deriveSalesLocationFromState(sb, newState, c);
        if (derivedLocation) headerUpdates['sales_location'] = derivedLocation;
      }
    }

    if (Object.keys(headerUpdates).length > 0) {
      const { error: hUpdErr } = await sb
        .from('mfg_sales_orders')
        .update(headerUpdates)
        .eq('doc_no', docNo);
      if (hUpdErr) throw new Error(`applySoAmendment: header change apply failed: ${hUpdErr.message}`);
    }

    /* Delivery-date master-follower cascade — mirrors the header PATCH: when the
       header's customer_delivery_date moves, EVERY line takes the new date and
       its per-line override flag clears, so MRP's order-by derivation (which
       reads line_delivery_date) stays accurate. Without this an approved date
       amendment would move the header but leave every line on the old date. */
    if ('customerDeliveryDate' in headerChanges) {
      const { error: cascErr } = await sb.from('mfg_sales_order_items')
        .update({
          line_delivery_date: headerChanges['customerDeliveryDate'] ?? null,
          line_delivery_date_overridden: false,
        })
        .eq('doc_no', docNo);
      if (cascErr) {
        // eslint-disable-next-line no-console
        console.error('[so-amendment] delivery-date line cascade failed (non-fatal):', cascErr.message);
      }
    }

    /* State -> per-line warehouse rebind. The State is frozen by the lock
       PRECISELY because it drives each line's warehouse_id and that warehouse is
       what the PO ships from (Owner 2026-06-16) — so an APPROVED state change
       must move the lines too, otherwise approving it would produce the exact
       warehouse/PO desync the lock exists to prevent. The bound PO is then
       re-derived from these lines at the approve-po gate.

       NOTE this is deliberately BROADER than the header PATCH's rebind, which
       only backfills lines whose warehouse_id is NULL (it must not clobber a
       per-line override during a routine edit). Here the change has passed a
       supplier confirmation + an explicit approval, so every non-cancelled line
       follows the approved address. FLAGGED in BUG-HISTORY for owner review. */
    if ('customerState' in headerChanges && c) {
      const reboundWh = await deriveWarehouseIdFromState(sb, headerChanges['customerState'] ?? null, c);
      if (reboundWh) {
        const { error: whErr } = await sb
          .from('mfg_sales_order_items')
          .update({ warehouse_id: reboundWh })
          .eq('doc_no', docNo)
          .eq('cancelled', false);
        if (whErr) {
          // eslint-disable-next-line no-console
          console.error('[so-amendment] warehouse rebind failed (non-fatal):', whErr.message);
        }
      }
    }
  }

  /* (4-continued) Re-derive the delivery fee (rebuilds SVC-DELIVERY* lines on
     the authoritative computeSoDeliveryFee) AND fold header totals — the same
     helper the create + add-line paths call after a line change; it internally
     runs recomputeTotals. Best-effort (logs, never throws). */
  try {
    await rederiveDeliveryFee(sb, docNo, c);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[so-amendment] rederiveDeliveryFee failed (non-fatal):', e);
  }

  // (5) Bump the SO's revision + updated_at.
  const { error: bumpErr } = await sb
    .from('mfg_sales_orders')
    .update({ revision: nextRevision, updated_at: new Date().toISOString() })
    .eq('doc_no', docNo);
  if (bumpErr) throw new Error(`applySoAmendment: revision bump failed: ${bumpErr.message}`);

  // (6) Audit — best-effort, keyed on the SO doc_no like every other SO mutation.
  await recordSoAudit(sb, {
    docNo,
    action: 'AMENDMENT_SO_APPROVED',
    actorId: userId,
    fieldChanges: [
      { field: 'amendment_id', to: amendmentId },
      { field: 'revision', from: nextRevision - 1, to: nextRevision },
      { field: 'lines_applied', to: touched.length },
      ...(headerApplied.length > 0 ? [{ field: 'header_applied', to: headerApplied.join(', ') }] : []),
    ],
    note: `Amendment applied: ${[
      touched.map((t) => `${t.change} ${t.itemCode}`).join('; ') || null,
      headerApplied.length > 0 ? `header ${headerApplied.join(', ')}` : null,
    ].filter(Boolean).join('; ') || 'no diffs'}`,
  });

  return { soDocNo: docNo, revision: nextRevision };
}

/* ── snapshotPo ─────────────────────────────────────────────────────────────
   Mirror of snapshotSo for a Purchase Order. Freeze the PO's CURRENT state
   (header + all items) into a `po_revisions` row at the PO's CURRENT `revision`,
   so the version being replaced stays immutable. Returns the NEXT revision
   number (current + 1) for the caller to stamp on the PO after re-deriving.

   Idempotent-safe: the `uq_po_revision (po_id, revision)` unique index means a
   re-run at the same revision no-ops on conflict (ignoreDuplicates). */
export async function snapshotPo(
  sb: Sb,
  poId: string,
  amendmentId?: string | null,
  userId?: string | null,
  c?: Context<any>,
): Promise<number> {
  const { data: header, error: hErr } = await sb
    .from('purchase_orders')
    .select('*')
    .eq('id', poId)
    .maybeSingle();
  if (hErr) throw new Error(`snapshotPo: header load failed: ${hErr.message}`);
  if (!header) throw new Error(`snapshotPo: PO ${poId} not found`);

  const currentRevision =
    typeof (header as { revision?: unknown }).revision === 'number'
      ? (header as { revision: number }).revision
      : 1;

  const { data: lines, error: lErr } = await sb
    .from('purchase_order_items')
    .select('*')
    .eq('purchase_order_id', poId)
    .order('created_at', { ascending: true, nullsFirst: true });
  if (lErr) throw new Error(`snapshotPo: lines load failed: ${lErr.message}`);

  const snapshot = {
    header,
    lines: lines ?? [],
    snapshotAt: new Date().toISOString(),
  };

  const { error: insErr } = await sb
    .from('po_revisions')
    .upsert(
      {
        po_id:        poId,
        revision:     currentRevision,
        snapshot,
        amendment_id: amendmentId ?? null,
        created_by:   userId ?? null,
        // company_id: active company (mig 0080 nullable column); no-op pre-activation.
        company_id:   c ? activeCompanyId(c) : undefined,
      },
      { onConflict: 'po_id,revision', ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`snapshotPo: revision insert failed: ${insErr.message}`);

  return currentRevision + 1;
}

/* ── reviseBoundPo ──────────────────────────────────────────────────────────
   The Approve-PO engine. For an amendment whose SO has already been revised
   (Approve-SO ran first), re-derive every bound PO's lines from the NOW-REVISED
   SO lines using the SAME derivation "Create PO from SO" uses: each PO line is
   1:1 with a SO line via `purchase_order_items.so_item_id`, and carries the SO
   line's qty / variants / item_group / description2 / per-line warehouse +
   delivery date. We re-read each PO line's source SO line and rewrite exactly
   those carried fields, AND re-derive the supplier COST (`unit_price_centi`)
   from the revised spec — a fabric/spec swap usually costs differently, so the
   revised PO's cost must re-anchor off the new spec, NOT carry over the old
   figure (deriveMfgPoUnitCost: the supplier binding's price_matrix + fabric tier
   + maintenance surcharges via computeMfgPoUnitCost). Scope note: the create
   path additionally re-spreads a SOFA-COMBO total across a matched module set;
   that group-level step is NOT reproduced on a per-line revision.

   Houzs note: the SO line's per-line delivery date column is `line_delivery_date`
   (2990's was `delivery_date`); the bound PO line's own column stays
   `delivery_date`.

   Bound PO discovery: SO line ids → purchase_order_items.so_item_id → distinct
   purchase_order_id → purchase_orders (NON-cancelled). No bound PO ⇒ NO-OP.

   Received floor: BEFORE mutating anything, any PO line whose revised SO qty
   would drop below that PO line's already-received_qty ABORTS the whole revision
   (receivedFloorViolation) — you can't revise a PO down past goods already
   received against it. */
export type ReviseBoundPoResult = {
  revisedPoIds: string[];
  perPo: Array<{ poId: string; poNumber: string; revision: number; linesRederived: number }>;
};

export class ReceivedFloorError extends Error {
  code = 'received_floor' as const;
  poItemId: string;
  revisedQty: number;
  receivedQty: number;
  constructor(poItemId: string, revisedQty: number, receivedQty: number) {
    super(
      `Revised qty ${revisedQty} for PO line ${poItemId} drops below the ${receivedQty} already received.`,
    );
    this.name = 'ReceivedFloorError';
    this.poItemId = poItemId;
    this.revisedQty = revisedQty;
    this.receivedQty = receivedQty;
  }
}

export async function reviseBoundPo(
  sb: Sb,
  amendmentId: string,
  userId: string | null,
  c?: Context<any>,
): Promise<ReviseBoundPoResult> {
  // (1) Load amendment → SO doc_no.
  const { data: amdRow, error: amdErr } = await sb
    .from('so_amendments')
    .select('id, so_doc_no, status')
    .eq('id', amendmentId)
    .maybeSingle();
  if (amdErr) throw new Error(`reviseBoundPo: amendment load failed: ${amdErr.message}`);
  if (!amdRow) throw new Error('reviseBoundPo: amendment not found');
  const docNo = (amdRow as AmendmentRow).so_doc_no;
  assertNotMirrored(docNo, 'reviseBoundPo');

  // (2) Resolve the bound PO(s): SO line ids → purchase_order_items.so_item_id →
  //     distinct non-cancelled purchase_orders. Empty ⇒ light branch (no-op).
  const { data: soItemRows, error: soItemErr } = await sb
    .from('mfg_sales_order_items')
    .select('id')
    .eq('doc_no', docNo);
  if (soItemErr) throw new Error(`reviseBoundPo: SO items load failed: ${soItemErr.message}`);
  const soItemIds = ((soItemRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (soItemIds.length === 0) return { revisedPoIds: [], perPo: [] };

  const { data: poItemRows, error: poItemErr } = await sb
    .from('purchase_order_items')
    .select('id, purchase_order_id, so_item_id, qty, received_qty')
    .in('so_item_id', soItemIds);
  if (poItemErr) throw new Error(`reviseBoundPo: PO items load failed: ${poItemErr.message}`);
  const allPoItems = (poItemRows ?? []) as Array<{
    id: string;
    purchase_order_id: string | null;
    so_item_id: string | null;
    qty: number | null;
    received_qty: number | null;
  }>;
  const candidatePoIds = [...new Set(
    allPoItems.map((r) => r.purchase_order_id).filter((x): x is string => Boolean(x)),
  )];
  if (candidatePoIds.length === 0) return { revisedPoIds: [], perPo: [] };

  const { data: poHeaders, error: poHeadErr } = await sb
    .from('purchase_orders')
    .select('id, po_number, status, revision, supplier_id')
    .in('id', candidatePoIds);
  if (poHeadErr) throw new Error(`reviseBoundPo: PO headers load failed: ${poHeadErr.message}`);
  // Exclude cancelled POs — a cancelled PO is not a live obligation to revise.
  const livePos = ((poHeaders ?? []) as Array<{
    id: string; po_number: string; status: string; revision: number | null; supplier_id: string | null;
  }>).filter((p) => String(p.status).toUpperCase() !== 'CANCELLED');
  if (livePos.length === 0) return { revisedPoIds: [], perPo: [] };
  const livePoIds = new Set(livePos.map((p) => p.id));

  // (3) Re-read the NOW-REVISED SO lines keyed by id (the derivation source).
  //     Houzs: the per-line delivery date column is `line_delivery_date`.
  const { data: revisedSoRows, error: revErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, variants, warehouse_id, line_delivery_date')
    .in('id', soItemIds);
  if (revErr) throw new Error(`reviseBoundPo: revised SO lines load failed: ${revErr.message}`);
  const revisedById = new Map<string, {
    item_code: string | null;
    item_group: string | null;
    qty: number | null;
    variants: Record<string, unknown> | null;
    warehouse_id: string | null;
    line_delivery_date: string | null;
  }>();
  for (const r of (revisedSoRows ?? []) as Array<Record<string, unknown>>) {
    revisedById.set(String(r.id), {
      item_code:          (r.item_code as string | null) ?? null,
      item_group:         (r.item_group as string | null) ?? null,
      qty:                r.qty == null ? null : Number(r.qty),
      variants:           (r.variants as Record<string, unknown> | null) ?? null,
      warehouse_id:       (r.warehouse_id as string | null) ?? null,
      line_delivery_date: (r.line_delivery_date as string | null) ?? null,
    });
  }

  // Only the PO items belonging to a LIVE bound PO whose SO line still exists.
  const targetPoItems = allPoItems.filter(
    (pi) => pi.purchase_order_id && livePoIds.has(pi.purchase_order_id)
      && pi.so_item_id && revisedById.has(pi.so_item_id),
  );

  // (4) RECEIVED-FLOOR PRE-CHECK — abort BEFORE any mutation. For each bound PO
  //     line, the revised SO qty must not drop below what's already received.
  for (const pi of targetPoItems) {
    const revised = revisedById.get(pi.so_item_id as string)!;
    const receivedQty = Number(pi.received_qty ?? 0);
    if (receivedFloorViolation({ newQty: revised.qty }, { receivedQty })) {
      throw new ReceivedFloorError(pi.id, Number(revised.qty), receivedQty);
    }
  }

  // (5) Snapshot each live bound PO, then rewrite its derived lines from the
  //     revised SO lines, recompute totals + expected_at, bump revision, audit.
  const perPo: ReviseBoundPoResult['perPo'] = [];
  const itemsByPo = new Map<string, typeof targetPoItems>();
  for (const pi of targetPoItems) {
    const key = pi.purchase_order_id as string;
    const arr = itemsByPo.get(key) ?? [];
    arr.push(pi);
    itemsByPo.set(key, arr);
  }

  for (const po of livePos) {
    const nextRevision = await snapshotPo(sb, po.id, amendmentId, userId, c);
    const poItems = itemsByPo.get(po.id) ?? [];
    let linesRederived = 0;

    for (const pi of poItems) {
      const revised = revisedById.get(pi.so_item_id as string)!;
      // Read the existing PO line's discount + material_code (the SKU the
      // supplier binding is keyed on).
      const { data: existing, error: exErr } = await sb
        .from('purchase_order_items')
        .select('material_code, discount_centi')
        .eq('id', pi.id)
        .maybeSingle();
      if (exErr) throw new Error(`reviseBoundPo: PO line load failed: ${exErr.message}`);
      const discountCenti = Number((existing as { discount_centi?: number } | null)?.discount_centi ?? 0);
      const qty = revised.qty != null ? Math.max(1, revised.qty) : Number(pi.qty ?? 1);
      const itemGroup = revised.item_group;
      const variants = revised.variants;
      // Re-derive the revised PO line's supplier cost from the NOW-REVISED SO
      // line's spec (SAME cost-anchor "Create PO from SO" runs). The SKU the cost
      // is keyed on = the revised SO line's item_code (a SPEC change may swap it),
      // falling back to the PO line's existing material_code.
      const materialCode = revised.item_code
        ?? String((existing as { material_code?: string } | null)?.material_code ?? '');
      const unitPriceCenti = await deriveMfgPoUnitCost(sb, {
        supplierId: po.supplier_id ?? '',
        itemCode:   materialCode,
        itemGroup,
        variants:   variants ?? null,
      });

      const { error: updErr } = await sb.from('purchase_order_items').update({
        qty,
        unit_price_centi: unitPriceCenti,
        line_total_centi: qty * unitPriceCenti - discountCenti,
        item_group:       itemGroup,
        variants,
        description2:     buildVariantSummary(String(itemGroup ?? ''), variants ?? null) || null,
        warehouse_id:     revised.warehouse_id,
        delivery_date:    revised.line_delivery_date,
      }).eq('id', pi.id);
      if (updErr) throw new Error(`reviseBoundPo: PO line update failed for ${pi.id}: ${updErr.message}`);
      linesRederived += 1;
    }

    // Recompute PO subtotal/total from the live lines and the header expected_at
    // = earliest non-null line delivery_date (mirrors recomputePoTotals /
    // recomputePoExpectedAt in mfg-purchase-orders.ts).
    /* The roll-up zeroing shape (BUG-HISTORY 2026-07-17, fix/zeroing-twins) — this
       is a 16th instance of it, reached from the amendment engine rather than a
       line route. `?? []` folds a failed read to subtotal 0, and the update below
       is unconditional: the PO's subtotal_centi AND total_centi go to 0 and
       expected_at to null while its lines sit there intact and priced.
       Throws rather than logging-and-skipping, unlike the 15 — the contract here
       is the opposite one and it is stated in this function's own docblock. Every
       other load and write in it throws; the approve-po route catches, returns 500
       and deliberately does NOT advance the amendment status, so the operator
       retries and snapshotPo's upsert is idempotent on (po_id, revision). The
       retry cannot duplicate a document the way a re-POSTed create can (#657/#658)
       — it is a PATCH on one amendment id behind a status-transition guard. And
       the bump 12 lines below already throws, stranding the identical half-revised
       PO, so this adds no new failure state — it only refuses to write a zero. */
    const { data: liveLines, error: liveErr } = await sb
      .from('purchase_order_items')
      .select('line_total_centi, delivery_date')
      .eq('purchase_order_id', po.id);
    if (liveErr) throw new Error(`reviseBoundPo: PO lines re-read failed for ${po.id}: ${liveErr.message}`);
    const rows = (liveLines ?? []) as Array<{ line_total_centi: number | null; delivery_date: string | null }>;
    const subtotal = rows.reduce((s, r) => s + Number(r.line_total_centi ?? 0), 0);
    const dates = rows.map((r) => r.delivery_date).filter((d): d is string => Boolean(d)).sort();

    const { error: bumpErr } = await sb.from('purchase_orders').update({
      subtotal_centi: subtotal,
      total_centi:    subtotal,
      expected_at:    dates[0] ?? null,
      revision:       nextRevision,
      updated_at:     new Date().toISOString(),
    }).eq('id', po.id);
    if (bumpErr) throw new Error(`reviseBoundPo: PO revision bump failed for ${po.id}: ${bumpErr.message}`);

    // Audit — best-effort, keyed on the SO doc_no like every other amendment step.
    await recordSoAudit(sb, {
      docNo,
      action: 'AMENDMENT_PO_REVISED',
      actorId: userId,
      fieldChanges: [
        { field: 'amendment_id', to: amendmentId },
        { field: 'po_number', to: po.po_number },
        { field: 'po_revision', from: nextRevision - 1, to: nextRevision },
        { field: 'lines_rederived', to: linesRederived },
      ],
      note: `PO ${po.po_number} re-derived from revised SO ${docNo} (rev ${nextRevision})`,
    });

    perPo.push({ poId: po.id, poNumber: po.po_number, revision: nextRevision, linesRederived });
  }

  return { revisedPoIds: perPo.map((p) => p.poId), perPo };
}
