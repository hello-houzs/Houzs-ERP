// ----------------------------------------------------------------------------
// Shared helpers for jspdf-based document PDFs. Avoids copy-pasting the
// company header / footer across SI / PI / GRN / PR / DR PDFs.
//
// VENDORED from 2990's apps/backend/src/lib/pdf-common.ts (verbatim layout/logic)
// for the Houzs SCM module. ONLY change vs. source: the COMPANY letterhead block
// now carries HOUZS's registered entity (see below), not 2990's.
// ----------------------------------------------------------------------------

import { fmtDate } from '@2990s/shared';

/* HOUZS letterhead — name / reg no / address taken VERBATIM from the existing
   Houzs print templates (backend/src/routes/assr_print.ts +
   projects_print.ts letterhead block, the real registered entity).

   TODO_HOUZS_* — these fields are NOT present anywhere in the Houzs codebase
   (the HTML letterhead prints no TIN / tel / email). OWNER TO FILL: replace
   each placeholder with the real value before these PDFs are sent externally.
   Leaving them blank in COMPANY below means they simply don't print. */
export const TODO_HOUZS_TIN = ''; // OWNER TO FILL — tax identification number
export const TODO_HOUZS_TEL = ''; // OWNER TO FILL — company telephone
export const TODO_HOUZS_EMAIL = ''; // OWNER TO FILL — company email

export const COMPANY = {
  name: 'HOUZS CENTURY SDN. BHD.',
  reg: '202201031135 (1476832-W)',
  addressLines: [
    '1831-B, Jalan KPB 1, Kawasan Perindustrian Balakong,',
    '43300 Seri Kembangan, Selangor.',
  ],
  portalLabel: 'Houzs ERP',
} as const;

/* ── Amount in words (AutoCount footer convention) ─────────────────────
   "RINGGIT MALAYSIA ONE THOUSAND TWO HUNDRED THIRTY-FOUR AND SEN
    FIFTY-SIX ONLY" — integer ringgit + sen, both spelled out. */
const ONES = [
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
] as const;
const TENS = [
  '', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY',
] as const;

const below1000ToWords = (n: number): string => {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h > 0) parts.push(`${ONES[h]} HUNDRED`);
  if (r >= 20) {
    const t = TENS[Math.floor(r / 10)];
    const o = r % 10;
    parts.push(o > 0 ? `${t}-${ONES[o]}` : (t as string));
  } else if (r > 0) {
    parts.push(ONES[r] as string);
  }
  return parts.join(' ');
};

/** Spell a non-negative integer in English words (caps), up to billions. */
export const intToWords = (n: number): string => {
  const v = Math.max(0, Math.floor(n));
  if (v === 0) return 'ZERO';
  const scales: Array<[number, string]> = [
    [1_000_000_000, 'BILLION'],
    [1_000_000, 'MILLION'],
    [1_000, 'THOUSAND'],
  ];
  const parts: string[] = [];
  let rest = v;
  for (const [div, label] of scales) {
    if (rest >= div) {
      parts.push(`${below1000ToWords(Math.floor(rest / div))} ${label}`);
      rest %= div;
    }
  }
  if (rest > 0) parts.push(below1000ToWords(rest));
  return parts.join(' ');
};

/** Centi amount → "RINGGIT MALAYSIA … AND SEN … ONLY" (AutoCount footer). */
export const amountInWordsMyr = (centi: number | null | undefined): string => {
  const v = Math.max(0, Math.round(centi ?? 0));
  const rm = Math.floor(v / 100);
  const sen = v % 100;
  const senPart = sen > 0 ? ` AND SEN ${intToWords(sen)}` : '';
  return `RINGGIT MALAYSIA ${intToWords(rm)}${senPart} ONLY`;
};

export const fmtRm = (centi: number | null, currency = 'MYR'): string => {
  if (centi == null) return '—';
  return `${currency} ${(centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

/** Document date → "31/05/2026". Null-safe ("—"). Delegates to the shared
 *  {@link fmtDate} so PDFs and the SPA share ONE date format (no 2nd source). */
export const fmtDocDate = (d: string | null | undefined): string => {
  if (d == null || d === '') return '—';
  const date = new Date(d);
  if (!Number.isFinite(date.getTime())) return String(d);
  return fmtDate(date);
};

/** Generated-stamp timestamp → "31/05/2026, 11:20 AM". */
export const fmtDocStamp = (d: Date = new Date()): string => {
  const time = d.toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${fmtDate(d)}, ${time}`;
};

// Draw the company header (top-left brand) + doc title + meta block on the right.
// Returns the y position where the body should continue.
export function drawHeader(
  doc: import('jspdf').jsPDF,
  opts: {
    docTitle: string;       // e.g. "SALES INVOICE"
    rightMeta: Array<{ label: string; value: string }>;
  },
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = margin;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.text(COMPANY.name, margin, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); y += 5;
  doc.text(COMPANY.reg, margin, y);
  for (const line of COMPANY.addressLines) {
    y += 4;
    doc.text(line, margin, y);
  }

  let rightY = margin;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(opts.docTitle, pageW - margin, rightY, { align: 'right' });
  rightY += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  for (const m of opts.rightMeta) {
    doc.text(`${m.label}: ${m.value}`, pageW - margin, rightY, { align: 'right' });
    rightY += 5;
  }

  y = Math.max(y, rightY) + 6;
  doc.setDrawColor(180); doc.line(margin, y, pageW - margin, y);
  return y + 4;
}

// Two-column info block (e.g. "BILL TO" + "DETAILS")
export function drawTwoColInfo(
  doc: import('jspdf').jsPDF,
  startY: number,
  leftTitle: string,
  rightTitle: string,
  leftLines: Array<string | null | undefined>,
  rightLines: Array<string | null | undefined>,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = startY;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text(leftTitle, margin, y);
  doc.text(rightTitle, pageW / 2, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  const lefts = leftLines.filter(Boolean) as string[];
  const rights = rightLines.filter(Boolean) as string[];
  const top = y;
  lefts.forEach((l, i) => doc.text(l, margin, top + i * 4));
  rights.forEach((l, i) => doc.text(l, pageW / 2, top + i * 4));
  return top + Math.max(lefts.length, rights.length, 1) * 4 + 4;
}

/* Unified document info block (Commander 2026-06-19 — Hookka-tidy layout):
   LEFT = "BILL TO" with a label gutter (Company / Address / Tel …); the value
   wraps. RIGHT = a colon-aligned key:value list ("SO No : … / Date : …").
   Blank values are skipped. Returns the Y to continue below the taller column.
   Black-and-white only (no fills) so it prints clean. */
export function drawInfoColumns(
  doc: import('jspdf').jsPDF,
  startY: number,
  left: { title: string; rows: Array<[string, string | null | undefined]> },
  right: { title: string; rows: Array<[string, string | null | undefined]> },
  marginX = 14,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = marginX;
  const midX = pageW / 2 + 2;
  const leftW = midX - margin - 6;
  const gutter = 20;
  const rValX = midX + 33;
  const lh = 4;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text(left.title, margin, startY);
  doc.text(right.title, midX, startY);
  let ly = startY + 4.6;
  let ry = startY + 4.6;

  doc.setFontSize(8.5);
  for (const [label, value] of left.rows) {
    const v = (value ?? '').toString().trim();
    if (!v) continue;
    doc.setFont('helvetica', 'normal');
    if (label) {
      doc.setTextColor(110); doc.text(label, margin, ly); doc.setTextColor(0);
      const wrapped = doc.splitTextToSize(v, leftW - gutter) as string[];
      doc.text(wrapped, margin + gutter, ly);
      ly += Math.max(1, wrapped.length) * lh;
    } else {
      const wrapped = doc.splitTextToSize(v, leftW) as string[];
      doc.text(wrapped, margin, ly);
      ly += Math.max(1, wrapped.length) * lh;
    }
  }
  for (const [label, value] of right.rows) {
    const v = (value ?? '').toString().trim();
    if (!v) continue;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110); doc.text(label, midX, ry); doc.setTextColor(0);
    doc.text(`: ${v}`, rValX, ry);
    ry += lh;
  }
  return Math.max(ly, ry) + 4;
}

// Two dashed signature boxes side by side
export function drawSignatureBoxes(
  doc: import('jspdf').jsPDF,
  startY: number,
  leftLabel: string,
  rightLabel: string,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let ty = startY;
  if (ty > 240) { doc.addPage(); ty = margin; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text(leftLabel, margin, ty);
  doc.text(rightLabel, pageW / 2 + 5, ty);
  ty += 2;
  doc.setLineDashPattern([1.5, 1.5], 0);
  doc.setDrawColor(120);
  doc.rect(margin, ty, (pageW - margin * 2) / 2 - 5, 22);
  doc.rect(pageW / 2 + 5, ty, (pageW - margin * 2) / 2 - 5, 22);
  doc.setLineDashPattern([], 0);
  return ty + 28;
}

// Safe filename: keep alphanum + - and _
export const safeName = (s: string, maxLen = 32): string =>
  (s || 'doc').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, maxLen);
