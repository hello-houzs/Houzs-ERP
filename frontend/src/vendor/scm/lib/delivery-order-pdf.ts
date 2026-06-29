// ----------------------------------------------------------------------------
// Delivery Order PDF — customer-facing signed POD. Driver / vehicle / expected
// date in the DELIVERY DETAILS column; dashed signature boxes for the customer
// to sign at delivery.
//
// 2026-06-19 — adopts the unified "Hookka-tidy" layout shared with the Sales
// Order / Purchase Order PDFs: real letterhead header, the drawInfoColumns
// info block (DELIVER TO label-gutter + DELIVERY DETAILS colon-aligned), and a
// consistent footer (doc no · portal · page n of m) on every page. A4 portrait,
// pure black & white for printing. No field dropped from the previous layout.
// ----------------------------------------------------------------------------

import { formatPhone } from '@2990s/shared/phone';
import {
  COMPANY,
  drawHeader,
  drawInfoColumns,
  drawSignatureBoxes,
  fmtDocDate,
  safeName,
} from './pdf-common';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';

type DoHeader = {
  do_number: string;
  status: string;
  do_date: string;
  so_doc_no: string | null;
  debtor_code: string | null;
  debtor_name: string;
  expected_delivery_at: string | null;
  dispatched_at: string | null;
  signed_at: string | null;
  delivered_at: string | null;
  driver_name: string | null;
  vehicle: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  notes: string | null;
  m3_total_milli: number | null;
};

type DoItem = {
  item_code: string;
  description: string | null;
  qty: number;
  m3_milli: number | null;
  unit_price_centi: number;
  /* Variant info snapshotted from the SO (migration 0058) — drives the unified
     variant line so DO/Consignment Note read like SO/PO/etc. */
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

/* Draw ONE delivery order's content into `doc` (letterhead → info block →
   items → signature → footer). Does NOT create the doc or save — the caller
   finalizes, so several DOs can share one doc (batch "Export PDF"). The footer
   loop starts at the page this DO began on (startPage) so combined docs keep
   each DO's own "page n of m" footer scoped to the run's pages. */
export async function renderDeliveryOrderInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: DoHeader,
  items: DoItem[],
  opts?: { docTitle?: string; docNoLabel?: string },
): Promise<void> {
  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  // ── Header (shared pdf-common letterhead) ─────────────────────────
  let y = drawHeader(doc, {
    docTitle: opts?.docTitle ?? 'DELIVERY ORDER',
    rightMeta: [
      { label: opts?.docNoLabel ?? 'DO No', value: header.do_number },
      { label: 'Date', value: fmtDocDate(header.do_date) },
    ],
  });

  // ── DELIVER TO + DELIVERY DETAILS (unified Hookka-tidy info block) ─
  const addressValue = [
    header.address1,
    header.address2,
    [header.postcode, header.city, header.state]
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .join(' '),
  ]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(', ');
  const statusText = header.status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const volumeText = header.m3_total_milli ? `${(header.m3_total_milli / 1000).toFixed(3)} m³` : null;
  y = drawInfoColumns(doc, y,
    {
      title: 'DELIVER TO',
      rows: [
        ['Company', header.debtor_name],
        ['Code', header.debtor_code],
        ['Address', addressValue],
        ['Tel', header.phone ? formatPhone(header.phone) : null],
        ['Note', header.notes],
      ],
    },
    {
      title: 'DELIVERY DETAILS',
      rows: [
        [opts?.docNoLabel ?? 'DO No', header.do_number],
        ['SO Ref', header.so_doc_no],
        ['Date', fmtDocDate(header.do_date)],
        ['Expected', header.expected_delivery_at ? fmtDocDate(header.expected_delivery_at) : null],
        ['Driver', header.driver_name],
        ['Vehicle', header.vehicle],
        ['Volume', volumeText],
        ['Status', statusText],
      ],
    },
  );

  // ── Line items ────────────────────────────────────────────────────
  // Description cell = SKU description + the UNIFIED variant line (same composer
  // as SO/DR/SI/consignment), so the line reads identically on every customer
  // document (Commander 2026-06-16).
  const fabric = await loadCustomerFabricMaps(items);
  // DO is QUANTITY-only (Owner 2026-06-26) — the Unit Price column was removed
  // from the DO PDF; a delivery doc shows quantity / volume, not money. The
  // underlying unit_price_centi still flows to the Sales Invoice.
  const rows = items.map((it, idx) => [
    String(idx + 1),
    it.item_code,
    [it.description, docVariantLine(it, fabric.ext, fabric.desc)].filter(Boolean).join('\n') || '—',
    String(it.qty),
    it.m3_milli != null ? (it.m3_milli / 1000).toFixed(3) : '—',
  ]);

  autoTable(doc, {
    startY: y,
    head: [['#', 'Item Code', 'Description', 'Qty', 'm³']],
    body: rows,
    theme: 'striped',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8.5, cellPadding: 2, valign: 'top' },
    headStyles: { fillColor: [34, 31, 32], textColor: 250, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 8, halign: 'right', fontSize: 7.5 },
      1: { cellWidth: 30 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 14, halign: 'right', fontSize: 7.5 },
      4: { cellWidth: 18, halign: 'right', fontSize: 7.5 },
    },
    margin: { left: margin, right: margin },
  });
  const lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  // ── Signature boxes: customer + driver (shared pdf-common layout) ──
  const ty = drawSignatureBoxes(doc, lastY, 'Customer Acknowledged Receipt', `${COMPANY.name} Driver Signature`);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  doc.text('Note: By signing above, the customer confirms receipt of the items listed in good order and condition.', margin, ty);
  doc.setTextColor(0);

  // ── Footer: doc no · portal · page n of m on every page ───────────
  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.do_number, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.do_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/* Single DO → its own file (unchanged behaviour). */
export async function generateDeliveryOrderPdf(
  header: DoHeader,
  items: DoItem[],
  opts?: { docTitle?: string; docNoLabel?: string },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderDeliveryOrderInto(doc, autoTable, header, items, opts);
  doc.save(`${header.do_number}-${safeName(header.debtor_name || 'customer')}.pdf`);
}

/* Several DOs → ONE combined file, each DO starting on a new page. For the
   batch "Export PDF" action (download a customer's DOs in one attachment). */
export async function generateCombinedDeliveryOrderPdf(
  docs: Array<{ header: DoHeader; items: DoItem[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderDeliveryOrderInto(doc, autoTable, docs[i]!.header, docs[i]!.items, opts);
  }
  doc.save(opts?.fileName ?? 'delivery-orders.pdf');
}
