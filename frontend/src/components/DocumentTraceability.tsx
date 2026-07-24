// DocumentTraceability — read-only cross-document strip rendered above the
// per-line breakdown when a PO / GRN / PI row is expanded. It answers the
// owner's question "which Sales-side documents did this purchase document's
// items end up assigned to" (2026-07-24 live testing) by REUSING the existing
// /document-flow/:type/:id relationship graph — the same SAP-B1-style read the
// PO detail's Relationship Map already renders. No new backend linkage: the
// graph resolves the family from the real stored FKs
// (purchase_order_items.so_item_id, grns.purchase_order_id,
// purchase_invoices.grn_id, delivery_orders.so_doc_no, sales_invoices.*), and
// it is company-scoped + read-only server-side.
//
// IMPORTANT (honesty of the linkage): the SO/DO/SI shown here are the DOCUMENT
// RELATIONSHIP the purchase doc descends from — NOT a physical batch/lot trace
// of the exact units. The floating MRP coverage (mrp.ts computeMrp) is a
// separate, live-only view that evaporates once a line is delivered, so it is
// deliberately NOT the source here; see docs/modules/document-traceability.md.

import { useDocumentFlow, type FlowNode } from "../vendor/scm/lib/flow-queries";
import { cn } from "../lib/utils";

type TraceType = "po" | "grn" | "pi";

// The sales-side documents the owner asked to surface, in flow order. DO/SI are
// naturally empty until the covering SO has shipped / been invoiced — the empty
// stage is simply omitted so the strip only shows what actually exists.
const STAGES: Array<{ type: FlowNode["type"]; label: string }> = [
  { type: "so", label: "Sales Order" },
  { type: "do", label: "Delivery Order" },
  { type: "si", label: "Sales Invoice" },
];

export function DocumentTraceability({ type, id }: { type: TraceType; id: string }) {
  const flowQ = useDocumentFlow(type, id);
  const nodes = flowQ.data?.nodes ?? [];

  // Group resolved documents by stage, excluding the anchor document itself.
  const byType = (t: FlowNode["type"]): FlowNode[] =>
    nodes.filter((n) => n.type === t && !n.isAnchor);

  const stages = STAGES
    .map((s) => ({ ...s, docs: byType(s.type) }))
    .filter((s) => s.docs.length > 0);

  const wrap = "rounded-lg border border-border bg-surface-2 px-4 py-2.5";

  if (flowQ.isLoading) {
    return (
      <div className={cn(wrap, "text-[11px] text-ink-muted")}>
        Resolving linked documents…
      </div>
    );
  }
  if (flowQ.isError) {
    // Fail-soft: the lines below still render; the strip just steps aside.
    return null;
  }
  if (stages.length === 0) {
    return (
      <div className={cn(wrap, "text-[11px] text-ink-muted")}>
        Not yet linked to a Sales Order.
      </div>
    );
  }

  return (
    <div className={cn(wrap, "flex flex-wrap items-center gap-x-5 gap-y-2")}>
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        Assigned to
      </span>
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
  );
}

export default DocumentTraceability;
