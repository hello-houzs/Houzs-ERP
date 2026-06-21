// Delivery Return PDF — printable for the customer to sign on collection.
//
// 2026-06-19 — adopts the unified "Hookka-tidy" layout shared with SO/PO/DO/SI:
// real letterhead header, the drawInfoColumns info block (FROM CUSTOMER
// label-gutter + RETURN DETAILS colon-aligned), and the consistent footer (doc
// no · portal · page n of m) on every page. A4 portrait, pure B&W. No field
// dropped.
//
// 2026-06-19 — split into renderDeliveryReturnInto (draws ONE return into a
// shared doc) + generateDeliveryReturnPdf (single file, unchanged output) +
// generateCombinedDeliveryReturnPdf (several returns → ONE file, each on its
// own page) for the batch "Export PDF" action on the Delivery Returns list.
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '@2990s/shared/so-line-display';
import { COMPANY, drawHeader, drawInfoColumns, drawSignatureBoxes, fmtRm, safeName, fmtDocDate } from './pdf-common';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';

type DrHeader = {
  return_number: string; status: string; return_date: string;
  debtor_code: string | null; debtor_name: string;
  reason: string | null; refund_centi: number; notes: string | null;
  delivery_order_id: string | null; sales_invoice_id: string | null;
};
type DrItem = {
  item_code: string; description: string | null;
  qty_returned: number; condition: string | null;
  unit_price_centi: number; refund_centi: number;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

type DrOpts = { docTitle?: string; docNoLabel?: string; amountLabel?: string; totalLabel?: string };

/* Draw ONE delivery return's content into `doc` (letterhead → info → table →
   total → signature → footer). Reused by ConsignmentReturnDetail via opts
   (docTitle / docNoLabel / amountLabel / totalLabel). The footer numbers only
   the pages THIS return added (startPage…pageCount) so several returns can
   share one doc without renumbering earlier ones. */
export async function renderDeliveryReturnInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: DrHeader,
  items: DrItem[],
  opts?: DrOpts,
): Promise<void> {
  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  let y = drawHeader(doc, {
    docTitle: opts?.docTitle ?? 'DELIVERY RETURN',
    rightMeta: [
      { label: opts?.docNoLabel ?? 'DR No', value: header.return_number },
      { label: 'Date', value: fmtDocDate(header.return_date) },
    ],
  });

  const statusText = header.status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  y = drawInfoColumns(doc, y,
    {
      title: 'FROM CUSTOMER',
      rows: [
        ['Company', header.debtor_name],
        ['Code', header.debtor_code],
        ['Reason', header.reason],
        ['Note', header.notes],
      ],
    },
    {
      title: 'RETURN DETAILS',
      rows: [
        [opts?.docNoLabel ?? 'DR No', header.return_number],
        ['Date', fmtDocDate(header.return_date)],
        ['Status', statusText],
      ],
    },
  );

  const fabric = await loadCustomerFabricMaps(items);
  /* Canonical SKU/build order — mirror the sales side for consistency. DR rows
     expose `item_code` natively (no shim). NOTE: DR rows carry no persisted
     variants / item_group, so both the build walk and the category rank are
     a harmless NO-OP here; applied anyway so the purchase family is uniform. */
  const orderedItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(items, (r) => r.item_group as string | null | undefined),
  );
  const rows = orderedItems.map((it, idx) => [
    String(idx + 1),
    it.item_code,
    [it.description, docVariantLine(it, fabric.ext, fabric.desc)].filter(Boolean).join('\n') || '—',
    String(it.qty_returned),
    it.condition ?? '—',
    fmtRm(it.unit_price_centi),
    fmtRm(it.refund_centi),
  ]);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Item', 'Description', 'Qty', 'Condition', 'Unit Price', opts?.amountLabel ?? 'Refund']],
    body: rows,
    theme: 'striped',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8.5, cellPadding: 2, valign: 'top' },
    headStyles: { fillColor: [34, 31, 32], textColor: 250, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 24 },
      2: { cellWidth: 60 },
      3: { cellWidth: 14, halign: 'right' },
      4: { cellWidth: 22 },
      5: { cellWidth: 24, halign: 'right' },
      6: { cellWidth: 26, halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });
  const lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  const totalsX = pageW - margin - 70;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(opts?.totalLabel ?? 'TOTAL REFUND', totalsX, lastY + 2);
  doc.text(fmtRm(header.refund_centi), pageW - margin, lastY + 2, { align: 'right' });

  const ty = drawSignatureBoxes(doc, lastY + 12, 'Customer Confirms Return', `${COMPANY.name} Received By`);

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  doc.text('Note: By signing above, both parties confirm the return of the items listed above.', margin, ty);
  doc.setTextColor(0);

  // Footer: doc no · portal · page n of m — only on the pages THIS return added.
  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.return_number, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.return_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/* Single delivery return → its own file (unchanged behaviour). */
export async function generateDeliveryReturnPdf(
  header: DrHeader,
  items: DrItem[],
  opts?: DrOpts,
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderDeliveryReturnInto(doc, autoTable, header, items, opts);
  doc.save(`${header.return_number}-${safeName(header.debtor_name)}.pdf`);
}

/* Several delivery returns → ONE combined file, each return starting on a new
   page. For the batch "Export PDF" action on the Delivery Returns list. */
export async function generateCombinedDeliveryReturnPdf(
  docs: Array<{ header: DrHeader; items: DrItem[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; amountLabel?: string; totalLabel?: string },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderDeliveryReturnInto(doc, autoTable, docs[i]!.header, docs[i]!.items, opts);
  }
  doc.save(opts?.fileName ?? 'delivery-returns.pdf');
}
