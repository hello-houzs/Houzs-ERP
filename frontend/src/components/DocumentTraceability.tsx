// DocumentTraceability — read-only cross-document strip rendered above the
// per-line breakdown when a PO / GRN / PI row is expanded. It answers the
// owner's question "which Sales Order is this purchase document assigned to, and
// when is that SO due" (2026-07-24 live testing) with TWO complementary reads,
// each labelled for what it is:
//
//  1. ASSIGNED SALES ORDER (advisory · floating MRP coverage) — the REVERSE of
//     mrp.ts computeMrp: which outstanding SO line(s) this document's supply is
//     currently pooled against, matched BY SKU, with that SO line's delivery
//     date. This is what fills the owner's frustrating "Not yet linked" gap for
//     a floating PO. It is ADVISORY, NOT a hard binding: the coverage is a
//     read-time pool that shifts as demand/supply move and evaporates once a
//     line ships — the owner buys against the PO, not the SO
//     ("我拿货是根据PO而不是看SO"). Backend: GET /po-so-coverage/:type/:id.
//
//  2. DOCUMENT RELATIONSHIP — the stable SAP-B1 graph from the real stored FKs
//     (purchase_order_items.so_item_id, grns.purchase_order_id,
//     purchase_invoices.grn_id, delivery_orders.so_doc_no, sales_invoices.*),
//     reusing the existing /document-flow/:type/:id read. This is a DOCUMENT
//     lineage, not a physical-unit trace; see docs/modules/document-traceability.md.
//
// Both are company-scoped + read-only server-side.

import { useNavigate } from "react-router-dom";
import { useDocumentFlow, usePoSoCoverage, type FlowNode } from "../vendor/scm/lib/flow-queries";
import { cn, formatDate } from "../lib/utils";

type TraceType = "po" | "grn" | "pi";

// The sales-side documents (stored relationship), in flow order. DO/SI are
// naturally empty until the covering SO has shipped / been invoiced — the empty
// stage is simply omitted so the strip only shows what actually exists.
const STAGES: Array<{ type: FlowNode["type"]; label: string }> = [
  { type: "so", label: "Sales Order" },
  { type: "do", label: "Delivery Order" },
  { type: "si", label: "Sales Invoice" },
];

const wrap = "rounded-lg border border-border bg-surface-2 px-4 py-2.5";
const eyebrow = "font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted";

export function DocumentTraceability({ type, id }: { type: TraceType; id: string }) {
  const navigate = useNavigate();
  const flowQ = useDocumentFlow(type, id);
  const covQ = usePoSoCoverage(type, id);

  const nodes = flowQ.data?.nodes ?? [];
  const byType = (t: FlowNode["type"]): FlowNode[] =>
    nodes.filter((n) => n.type === t && !n.isAnchor);
  const stages = STAGES
    .map((s) => ({ ...s, docs: byType(s.type) }))
    .filter((s) => s.docs.length > 0);

  // Advisory floating coverage — only the SKUs that ARE floating-assigned.
  const coveredSkus = (covQ.data?.skus ?? []).filter((s) => s.assignments.length > 0);
  const hasCoverage = coveredSkus.length > 0;

  const loading = flowQ.isLoading || covQ.isLoading;
  if (loading) {
    return (
      <div className={cn(wrap, "text-[11px] text-ink-muted")}>
        Resolving linked documents…
      </div>
    );
  }

  // Precise empty state: neither a floating assignment NOR a stored relationship.
  // "Floating stock" (not "Not yet linked") is the honest phrasing — the goods
  // exist and simply aren't pooled against any outstanding SO line right now.
  if (!hasCoverage && stages.length === 0) {
    return (
      <div className={cn(wrap, "text-[11px] text-ink-muted")}>
        Floating stock — not yet assigned to a Sales Order.
      </div>
    );
  }

  return (
    <div className={cn(wrap, "flex flex-col gap-2.5")}>
      {hasCoverage && (
        <div className="flex flex-col gap-1.5">
          <span className={eyebrow} title="A read-time MRP pooling of this purchase document's stock against outstanding Sales-Order demand, matched by SKU. Advisory — not a hard PO to SO binding.">
            Assigned Sales Order · advisory (floating MRP coverage)
          </span>
          {coveredSkus.map((s) => (
            <div key={s.itemCode} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-ink-muted">
                {s.itemCode}
              </span>
              {s.assignments.map((a) => (
                <button
                  type="button"
                  key={a.soItemId}
                  onClick={() => navigate(`/scm/sales-orders/${encodeURIComponent(a.soDocNo)}`)}
                  className="group flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2 py-0.5 text-[11.5px] hover:border-accent hover:bg-accent-soft"
                  title={a.debtorName ? `${a.debtorName}${a.warehouseName ? ` · ${a.warehouseName}` : ""}` : undefined}
                >
                  <span className="font-semibold text-ink group-hover:text-accent">{a.soDocNo}</span>
                  <span className="text-[10.5px] text-ink-muted">
                    {a.deliveryDate ? formatDate(a.deliveryDate) : "no delivery date"}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {stages.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className={eyebrow}>Document relationship</span>
          {stages.map((s) => (
            <span key={s.type} className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                {s.label}
              </span>
              {s.docs.map((d) => (
                <span
                  key={d.key}
                  className="rounded-md border border-border-subtle bg-surface px-2 py-0.5 text-[11.5px] font-semibold text-ink"
                >
                  {d.label}
                </span>
              ))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default DocumentTraceability;
