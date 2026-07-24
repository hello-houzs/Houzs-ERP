// ----------------------------------------------------------------------------
// /po-so-coverage/:type/:id — ADVISORY floating "assigned Sales Order" view for
// a purchase document (PO / GRN / PI).
//
// Owner ask (2026-07-24 live testing): on every Purchase Order, GRN and Purchase
// Invoice, show which Sales Order each line is floating-assigned to — matched BY
// SKU — and that SO line's delivery date. Today a PO expansion just says "Not
// yet linked to a Sales Order", which is misleading for a floating PO: the PO
// carries no stored SO link, but the MRP engine IS currently pooling its stock
// against outstanding SO lines.
//
// This is the REVERSE of the forward SO→PO coverage in mrp.ts (computeMrp →
// mrpLineCoverage). It reuses that ONE allocation via mrpReverseCoverage — it
// does NOT re-implement coverage — so this view, the MRP page and the SO
// drill-down can never disagree.
//
// ADVISORY, NOT A BINDING (the whole reason it lives apart from document-flow's
// stored-FK graph). The coverage is linkage A: a pooled, read-time allocation
// that shifts as demand/supply move and evaporates the moment a line ships. The
// owner raises POs against the PO, not the SO ("我拿货是根据PO而不是看SO"), so
// the UI must label this as advisory, never as a hard PO↔SO link. The stable
// document RELATIONSHIP (so_item_id / GRN→PO→SO FKs) is what /document-flow
// shows; the two are surfaced side by side.
//
// Read-only + company-scoped: every doc read is scopeToCompany'd (a foreign id
// resolves to nothing), and computeMrp is called with the active company id, so
// a caller in company A never sees company B's demand. Mounted on the coarse SCM
// read gate alongside /document-flow — same sensitivity class (it already
// exposes the SO doc numbers a purchase doc descends from).
//
//   GET /po-so-coverage/po/:id
//   GET /po-so-coverage/grn/:id   (resolves grns.purchase_order_id → PO)
//   GET /po-so-coverage/pi/:id    (resolves purchase_invoices.grn_id → GRN → PO)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { buildVariantSummary } from '../shared';
import { computeMrp, mrpReverseCoverage, type PoCoverageAssignment } from './mrp';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import type { Env, Variables } from '../env';

export const poSoCoverage = new Hono<{ Bindings: Env; Variables: Variables }>();
poSoCoverage.use('*', supabaseAuth);

const TYPES = new Set(['po', 'grn', 'pi']);

/* Resolve any of the three purchase-doc types down to its Purchase Order
   (id + number). Company-scoped throughout: a foreign / unknown id returns null,
   which the handler turns into an empty (but honest) coverage response. */
async function resolvePo(
  sb: any,
  c: Context<any>,
  type: string,
  id: string,
): Promise<{ poId: string; poNumber: string } | null> {
  if (type === 'po') {
    const { data } = await scopeToCompany(
      sb.from('purchase_orders').select('id, po_number').eq('id', id), c,
    ).maybeSingle();
    return data?.id ? { poId: data.id, poNumber: data.po_number ?? '' } : null;
  }
  if (type === 'grn') {
    const { data } = await scopeToCompany(
      sb.from('grns').select('purchase_order_id').eq('id', id), c,
    ).maybeSingle();
    return data?.purchase_order_id ? resolvePo(sb, c, 'po', data.purchase_order_id) : null;
  }
  // pi → grn → po
  const { data } = await scopeToCompany(
    sb.from('purchase_invoices').select('grn_id').eq('id', id), c,
  ).maybeSingle();
  return data?.grn_id ? resolvePo(sb, c, 'grn', data.grn_id) : null;
}

type SkuCoverage = {
  itemCode: string;
  variantLabel: string | null;
  assignments: Array<Omit<PoCoverageAssignment, 'itemCode' | 'variantLabel'> & { variantLabel: string | null }>;
};

poSoCoverage.get('/:type/:id', async (c) => {
  const type = c.req.param('type');
  const id = c.req.param('id');
  if (!TYPES.has(type)) return c.json({ error: 'bad_type' }, 400);

  const sb = c.get('supabase');
  try {
    const po = await resolvePo(sb, c, type, id);
    // No PO behind this doc (manual PI, unresolved id, foreign company): honest
    // empty — the UI shows "Floating stock — not yet assigned to a Sales Order".
    if (!po) {
      return c.json({ advisory: true as const, poNumber: null, poId: null, skus: [] as SkuCoverage[] });
    }

    // The covering PO's own lines — so a SKU with NO floating assignment still
    // appears (as "not yet assigned"), rather than silently vanishing.
    const { data: poLines } = await scopeToCompany(
      sb.from('purchase_order_items').select('material_code, item_group, variants'), c,
    ).eq('purchase_order_id', po.poId);

    // The single shared allocation, company-scoped. includeUndated so a PO
    // covering an as-yet-undated SO line still shows its assignment.
    const result = await computeMrp(sb, {
      catFilter: null,
      whFilter: null,
      includeUndated: true,
      companyId: activeCompanyId(c),
      leadBuffers: await loadLeadBuffers(c.env.DB),
    });
    const forPo = mrpReverseCoverage(result).get(po.poNumber) ?? [];

    // Group the PO's SKUs, attach the floating assignments matched by SKU.
    const bySku = new Map<string, SkuCoverage>();
    for (const l of (poLines ?? []) as Array<{ material_code: string | null; item_group: string | null; variants: Record<string, unknown> | null }>) {
      const code = l.material_code ?? '';
      if (!code) continue;
      if (!bySku.has(code)) {
        bySku.set(code, {
          itemCode: code,
          variantLabel: buildVariantSummary(l.item_group, l.variants) || null,
          assignments: [],
        });
      }
    }
    for (const a of forPo) {
      const entry = bySku.get(a.itemCode)
        ?? { itemCode: a.itemCode, variantLabel: a.variantLabel, assignments: [] };
      entry.assignments.push({
        soItemId: a.soItemId,
        soDocNo: a.soDocNo,
        deliveryDate: a.deliveryDate,
        debtorName: a.debtorName,
        warehouseName: a.warehouseName,
        qty: a.qty,
        variantLabel: a.variantLabel,
      });
      bySku.set(a.itemCode, entry);
    }

    // Earliest delivery date first within a SKU; assigned SKUs before bare ones.
    const skus = [...bySku.values()].map((s) => ({
      ...s,
      assignments: s.assignments.sort((x, y) => {
        if (x.deliveryDate === y.deliveryDate) return x.soDocNo.localeCompare(y.soDocNo);
        if (!x.deliveryDate) return 1;
        if (!y.deliveryDate) return -1;
        return x.deliveryDate < y.deliveryDate ? -1 : 1;
      }),
    })).sort((a, b) => {
      if ((b.assignments.length > 0 ? 1 : 0) !== (a.assignments.length > 0 ? 1 : 0)) {
        return (b.assignments.length > 0 ? 1 : 0) - (a.assignments.length > 0 ? 1 : 0);
      }
      return a.itemCode.localeCompare(b.itemCode);
    });

    return c.json({ advisory: true as const, poNumber: po.poNumber, poId: po.poId, skus });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default poSoCoverage;
