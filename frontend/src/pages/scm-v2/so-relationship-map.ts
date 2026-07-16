// so-relationship-map — the ONE builder for the Sales Order's 5-node
// Relationship Map chain (Customer PO → Sales Order → Delivery Order → GRN →
// Sales Invoice) and for what each node does when it is clicked.
//
// Why it exists: the chain + its click handling were written twice — once in
// SalesOrderDetailV2 (the read-only page) and once in SalesOrderDetail (the
// ?edit=1 editor) — and immediately drifted. #600 taught the V2 copy to resolve
// the real downstream DO / SI and navigate to them; the editor copy was left with
// a hard-coded "Not created" chain and `onNodeClick={(n) => void n}`, so on the
// page the owner actually sits on while amending an order, EVERY node was dead
// and the DO / SI nodes lied about not existing. Both pages now call this hook,
// so there is one chain and one set of destinations (owner rule: one logic
// layer, never per-surface).
//
// Owner 2026-07-16: "每個點了都要有反應可以看到文件的" — a node that paints as
// Linked must answer when it is clicked. Nodes with a real document navigate to
// it; the ones that cannot (see below) say why in-app instead of doing nothing.

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useDocumentFlow, type FlowNode } from '../../vendor/scm/lib/flow-queries';
import type { ChainNode } from '../../components/scm-v2/DocumentRelationshipMapModal';

/** The header columns the chain reads. Loose on purpose — the two SO detail
 *  pages carry their own (differently-typed) SoHeader. */
export type SoRelationshipHeader = {
  doc_no: string;
  po_doc_no?: string | null;
  customer_so_no?: string | null;
  ref?: string | null;
};

/* What a "Customer PO" IS on a Houzs SO — read this before wiring it to a file.
   It is a REFERENCE STRING and nothing else. PR #140 (commander 2026-05-26,
   "customer PO 不需要") dropped the whole Customer PO card — PO No / PO ID / PO
   Date / PO image — so no Houzs surface writes po_doc_no or customer_po*; the
   columns survive only because the SCM schema was vendored from 2990. The value
   this node shows is therefore almost always `customer_so_no`, the customer's own
   ERP reference typed into the Customer card ("Customer SO Ref"). The one image
   column that exists, customer_po_image_b64, is never written by any Houzs code
   path — SELECTed and audit-mapped, never inserted.
   The files an SO does own — slip_image_key (the handwritten ORDER SLIP) and
   receipt_image_key (the PAYMENT RECEIPT) — are OUR documents from the scan flow,
   not the customer's PO, and the detail page already shows them in their own
   sections. Pointing this node at them would mislabel our slip as their PO.
   So: no file exists, and the honest response is to say so rather than sit dead. */
export function useCustomerPoNotice() {
  const notify = useNotify();
  return useCallback(
    (poRef: string) => {
      void notify({
        title: `Customer PO ${poRef}`.trim(),
        body:
          `${poRef} is the customer's own reference for this order. It is their ` +
          `document, not ours, so there is no file here to open.`,
      });
    },
    [notify],
  );
}

const flowNodesOf = (data: { nodes: FlowNode[] } | undefined, type: FlowNode['type']) =>
  (data?.nodes ?? []).filter((n) => n.type === type);

/** Builds the SO chain and returns the click handler both SO detail pages pass
 *  straight to <DocumentRelationshipMapModal>. `onNodeClick` returns TRUE when the
 *  click navigated away, so the caller knows to close the map — an in-app notice
 *  must render OVER the map instead of dismissing it. */
export function useSoRelationshipMap(salesOrder: SoRelationshipHeader | null): {
  nodes: ChainNode[];
  onNodeClick: (n: ChainNode) => boolean;
} {
  const navigate = useNavigate();
  const notify = useNotify();
  const showCustomerPo = useCustomerPoNotice();
  const { can, pageAccess } = useAuth();

  const docNo = salesOrder?.doc_no ?? null;
  // Downstream docs generated from this SO. Company-scoped server-side.
  const flow = useDocumentFlow('so', docNo);
  const doNodes = useMemo(() => flowNodesOf(flow.data, 'do'), [flow.data]);
  const siNodes = useMemo(() => flowNodesOf(flow.data, 'si'), [flow.data]);
  const grnNodes = useMemo(() => flowNodesOf(flow.data, 'grn'), [flow.data]);

  /* GRN sits behind the procurement guard — App.tsx mounts /scm/grns/:id as
     <ScmGuard area="scm.procurement.grn"> with NO allowSales — so mirror that
     route gate here rather than handing a salesperson a node that navigates
     straight into <Forbidden>. Same OR-shape as the Guard itself. */
  const canOpenGrn = can('scm.access') || pageAccess('scm.procurement.grn') !== 'none';

  const poRef = (
    salesOrder?.po_doc_no ||
    salesOrder?.customer_so_no ||
    salesOrder?.ref ||
    ''
  ).trim();

  const nodes: ChainNode[] = useMemo(() => {
    if (!salesOrder) return [];
    return [
      {
        type: 'Customer PO',
        doc: poRef || 'Not linked',
        // Reference only — no file exists (see useCustomerPoNotice above).
        meta: poRef ? "Customer's own doc" : '—',
        state: poRef ? 'done' : 'pending',
      },
      {
        type: 'Sales Order',
        doc: salesOrder.doc_no,
        meta: 'This document',
        state: 'current',
      },
      {
        type: 'Delivery Order',
        doc:
          doNodes.length === 0
            ? 'Not created'
            : doNodes.length === 1
              ? doNodes[0]!.label
              : `${doNodes.length} delivery orders`,
        meta:
          doNodes.length === 0
            ? 'After confirmation'
            : doNodes.length === 1
              ? 'Tap to open'
              : 'Tap to view all',
        state: doNodes.length > 0 ? 'done' : 'pending',
      },
      {
        type: 'GRN',
        doc:
          grnNodes.length === 0
            ? 'Not created'
            : grnNodes.length === 1
              ? grnNodes[0]!.label
              : `${grnNodes.length} GRNs`,
        meta:
          grnNodes.length === 0
            ? 'After delivery'
            : !canOpenGrn
              ? 'Procurement document'
              : grnNodes.length === 1
                ? 'Tap to open'
                : 'Tap to list',
        state: grnNodes.length > 0 ? 'done' : 'pending',
      },
      {
        type: 'Sales Invoice',
        doc:
          siNodes.length === 0
            ? 'Not created'
            : siNodes.length === 1
              ? siNodes[0]!.label
              : `${siNodes.length} invoices`,
        meta:
          siNodes.length === 0
            ? 'On completion'
            : siNodes.length === 1
              ? 'Tap to open'
              : 'Tap to view all',
        state: siNodes.length > 0 ? 'done' : 'pending',
      },
    ];
  }, [salesOrder, poRef, doNodes, siNodes, grnNodes, canOpenGrn]);

  const onNodeClick = useCallback(
    (n: ChainNode): boolean => {
      // One match → its detail page; several → the list filtered by this SO's
      // doc no (the chain has a single slot per doc type, so a split
      // delivery/invoice lands on the filtered list).
      if (n.type === 'Delivery Order' && doNodes.length > 0) {
        navigate(
          doNodes.length === 1
            ? `/scm/delivery-orders/${doNodes[0]!.id}`
            : `/scm/delivery-orders?q=${encodeURIComponent(salesOrder?.doc_no ?? '')}`,
        );
        return true;
      }
      if (n.type === 'Sales Invoice' && siNodes.length > 0) {
        navigate(
          siNodes.length === 1
            ? `/scm/sales-invoices/${siNodes[0]!.id}`
            : `/scm/sales-invoices?q=${encodeURIComponent(salesOrder?.doc_no ?? '')}`,
        );
        return true;
      }
      if (n.type === 'GRN' && grnNodes.length > 0) {
        if (!canOpenGrn) {
          void notify({
            title: 'Goods Received is not open to you',
            body:
              `This order's goods were received on ${grnNodes.map((g) => g.label).join(', ')}. ` +
              `Opening a GRN needs Procurement access — ask an admin if you need it.`,
          });
          return false;
        }
        if (grnNodes.length === 1) {
          navigate(`/scm/grns/${grnNodes[0]!.id}`);
          return true;
        }
        /* Several GRNs and one slot to show them in. The GRN list searches its
           OWN refs (supplier / PO / GRN no) and knows nothing about an SO doc
           no, so ?q=<SO no> would land on an empty list — name them instead. */
        void notify({
          title: 'Received on more than one GRN',
          body:
            `This order's goods were received on ${grnNodes.map((g) => g.label).join(', ')}. ` +
            `Open Goods Received to view them.`,
        });
        return false;
      }
      if (n.type === 'Customer PO' && n.state === 'done') {
        showCustomerPo(n.doc);
      }
      return false;
    },
    [navigate, notify, showCustomerPo, salesOrder?.doc_no, doNodes, siNodes, grnNodes, canOpenGrn],
  );

  return { nodes, onNodeClick };
}
