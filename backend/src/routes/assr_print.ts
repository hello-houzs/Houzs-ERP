import { Hono } from "hono";
import type { Env } from "../types";
import { getAssrDetail } from "../services/assr";

// Formal service-case document modeled on a standard Malaysian business
// invoice/service report:
//   · Letterhead with company name, registration no., and address
//   · Plain document title + reference metadata
//   · Two-column labeled customer / service details (no boxes)
//   · Minimal itemised list separated by horizontal rules
//   · Plain numbered sections
//   · Black & white, light use of a single accent rule
// No coloured backgrounds, no pills, no zebra rows, no decorative blocks.

const app = new Hono<{ Bindings: Env }>();

function esc(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    const parts = s.slice(0, 10).split("-");
    if (parts.length === 3 && parts[0].length === 4) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return s.slice(0, 10);
  }
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 16).replace("T", " ");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

const STAGE_LABEL: Record<string, string> = {
  registration: "Pending Review",
  triage: "Under Verification",
  action: "Pending Solution",
  logistics: "Pending Logistics",
  resolution: "Pending Completion",
  closed: "Completed",
};

const RESOLUTION_LABEL: Record<string, string> = {
  replace_unit: "Replace Unit",
  supplier_repair: "Supplier Repair (Workshop)",
  field_service_own: "Field Service (Own Team)",
  field_service_supplier: "Field Service (Supplier)",
  return_visit: "Return Visit",
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
    );
  }
  return btoa(binary);
}

async function fetchAsDataUri(env: Env, key: string, fallbackMime = "image/png"): Promise<string | null> {
  try {
    const obj = await env.POD_BUCKET.get(key);
    if (!obj) return null;
    const buf = new Uint8Array(await obj.arrayBuffer());
    const mime = obj.httpMetadata?.contentType || fallbackMime;
    return `data:${mime};base64,${bytesToBase64(buf)}`;
  } catch (e) {
    console.warn(`[print] failed to load ${key}`, e);
    return null;
  }
}

app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.text("Invalid ID", 400);

  const detail = await getAssrDetail(c.env, id);
  if (!detail) return c.text("Not found", 404);

  const { case: cs, items, attachments, activity, logistics } = detail;

  const logoUri = await fetchAsDataUri(c.env, "static/logo-wordmark.png");

  const imageAttachments = attachments.filter((a: any) =>
    (a.content_type || "").startsWith("image/")
  );
  const otherAttachments = attachments.filter(
    (a: any) => !(a.content_type || "").startsWith("image/")
  );
  const inlinedImages: Array<{ category: string; file_name: string | null; data_url: string }> = [];
  for (const att of imageAttachments as any[]) {
    const uri = await fetchAsDataUri(c.env, att.r2_key as string, att.content_type || "image/jpeg");
    if (!uri) continue;
    inlinedImages.push({
      category: String(att.category ?? ""),
      file_name: att.file_name ? String(att.file_name) : null,
      data_url: uri,
    });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Service Report — ${esc(cs.assr_no)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    /* A4 paper margin — the printable frame around every page.
       Header & footer get repeated on each page via the CSS
       table-group technique below; they live INSIDE this frame. */
    @page {
      size: A4;
      margin: 12mm 10mm 12mm 10mm;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    html, body { margin: 0; padding: 0; }

    body {
      font-family: "Google Sans", "Product Sans", "Roboto", "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: #000;
      font-size: 10pt;
      line-height: 1.5;
      background: #fff;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    /* ── Running header / footer via a real <table> element ───
       Chrome only reliably paginates thead/tfoot when they sit
       inside an actual <table>, not a <div display:table>. We
       use a single-column table: thead for the letterhead,
       tbody for the body content, tfoot for the computer-
       generated notice. Browsers repeat thead + tfoot on every
       printed page automatically — same mechanism that wraps
       long HTML tables across page breaks. */
    table.sheet {
      width: 210mm;
      margin: 0 auto;
      border-collapse: collapse;
      background: #fff;
    }
    table.sheet td,
    table.sheet th { padding: 0; }

    /* Stretch the full chain: html → body → table → tbody so a
       filler row at the end of tbody can soak up leftover page
       height and keep tfoot glued to the page bottom on short
       content. Without explicit heights at every level, the
       filler collapses to 0 and tfoot floats right after
       content. */
    html, body { height: 100%; }
    table.sheet { height: 100%; }
    table.sheet > tbody > tr > td { vertical-align: top; }

    @media screen {
      body { background: #d9d6cf; padding: 24px 0; height: auto; min-height: 100%; }
      table.sheet {
        box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 12px 36px rgba(0,0,0,0.14);
        min-height: 297mm;
        height: 297mm;
      }
    }
    @media print {
      body { background: #fff !important; }
      table.sheet {
        box-shadow: none !important;
        margin: 0 !important;
        width: 100% !important;
      }
    }

    /* Cell padding — keeps content off the left/right edges
       of the printable area. Kept tight because @page margin
       already provides outer whitespace. */
    table.sheet > thead > tr > td { padding: 2mm 10mm 3mm 10mm; }
    table.sheet > tbody > tr > td { padding: 2mm 10mm 2mm 10mm; }
    table.sheet > tfoot > tr > td { padding: 2mm 10mm 2mm 10mm; }
    /* Filler row — absorbs leftover vertical space on the last
       page so the tfoot sticks to the page bottom. */
    table.sheet > tbody > tr.filler > td {
      padding: 0 !important;
      height: 100%;
    }

    /* ── Letterhead layout (inside .lh-cell) ──────────────────
       Logo left, company particulars right, separated from the
       body content by a single bold rule. */
    .letterhead {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 4mm;
      border-bottom: 1.5pt solid #000;
    }
    .letterhead .logo {
      max-height: 46px;
      max-width: 210px;
      object-fit: contain;
      display: block;
    }
    .letterhead .logo-fallback {
      font-weight: 700;
      font-size: 18pt;
      letter-spacing: 1.2pt;
      color: #000;
      text-transform: uppercase;
    }
    .letterhead .company {
      text-align: right;
      font-size: 8.5pt;
      line-height: 1.4;
      color: #000;
      max-width: 95mm;
    }
    .letterhead .company .co-name {
      font-weight: 700;
      font-size: 10pt;
      letter-spacing: 0.3pt;
      text-transform: uppercase;
    }
    .letterhead .company .reg-no {
      font-family: "Roboto Mono", monospace;
      font-size: 8pt;
      margin-top: 0.5pt;
    }

    /* ── Document title ─────────────────────────────────────
       Plain, centered, all caps, tracked. The way every formal
       document names itself (INVOICE, DELIVERY ORDER, etc.). */
    .doc-title {
      text-align: center;
      margin: 0 0 8mm 0;
    }
    .doc-title h1 {
      margin: 0;
      font-size: 14pt;
      font-weight: 500;
      letter-spacing: 4pt;
      text-transform: uppercase;
    }
    .doc-title .ref {
      margin-top: 3mm;
      font-family: "Roboto Mono", monospace;
      font-size: 10pt;
    }

    /* ── Info rows (Customer / Service Details) ────────────
       Two columns of labeled key/value lines — no borders,
       no boxes. Customer on left, document metadata on right. */
    .info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10mm;
      margin-bottom: 10mm;
    }
    .info .col .label {
      font-size: 8pt;
      letter-spacing: 1pt;
      text-transform: uppercase;
      color: #555;
      border-bottom: 0.5pt solid #000;
      padding-bottom: 1.5mm;
      margin-bottom: 2.5mm;
      font-weight: 700;
    }
    .info .col .line {
      display: flex;
      gap: 4mm;
      padding: 2mm 0;
      border-bottom: 0.4pt solid #d0d0d0;
      font-size: 10pt;
    }
    .info .col .line:last-child { border-bottom: none; }
    .info .col .line .k {
      flex: 0 0 26mm;
      color: #555;
    }
    .info .col .line .v {
      flex: 1;
      color: #000;
      font-weight: 500;
    }
    .info .col .name-line {
      font-size: 11pt;
      font-weight: 700;
      margin-bottom: 1mm;
    }

    /* ── Section heading ────────────────────────────────────
       Small-caps label followed by a thin full-width rule.
       Clean sectioning used in invoices and service reports. */
    section { margin-top: 8mm; page-break-inside: avoid; }
    h2.sec {
      font-size: 9.5pt;
      font-weight: 700;
      letter-spacing: 2pt;
      text-transform: uppercase;
      margin: 0 0 3mm 0;
      padding-bottom: 2mm;
      border-bottom: 0.8pt solid #000;
    }

    /* ── Items list ────────────────────────────────────────
       Invoice-style list: thin rules only, no fills, no zebra.
       Header row uses bold uppercase, body is plain. */
    .items {
      width: 100%;
      border-collapse: collapse;
    }
    .items th {
      text-align: left;
      font-size: 8pt;
      letter-spacing: 1pt;
      text-transform: uppercase;
      font-weight: 700;
      padding: 2mm 2mm;
      color: #555;
      border-bottom: 0.4pt solid #d0d0d0;
    }
    .items td {
      font-size: 10pt;
      padding: 2mm 2mm;
      border-bottom: 0.4pt solid #d0d0d0;
      vertical-align: top;
    }
    .items tr:last-child td { border-bottom: 0.4pt solid #d0d0d0; }
    .items .num { text-align: right; font-variant-numeric: tabular-nums; font-family: "Roboto Mono", monospace; }
    .items .code { font-family: "Roboto Mono", monospace; font-size: 9.5pt; }

    /* ── Labeled info rows (used inside sections) ──────────
       Simple two-column list, one label per line. Used for
       Issue Details / Resolution / Cost / Closure blocks. */
    .rows .row {
      display: flex;
      gap: 4mm;
      padding: 2mm 0;
      border-bottom: 0.4pt solid #d0d0d0;
      font-size: 10pt;
    }
    .rows .row:last-child { border-bottom: none; }
    .rows .row .k {
      flex: 0 0 48mm;
      color: #555;
    }
    .rows .row .v {
      flex: 1;
      color: #000;
      font-weight: 500;
    }
    .rows .row .v.mono { font-family: "Roboto Mono", monospace; }
    .rows-2col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 10mm;
    }
    .rows-2col .row .k { flex-basis: 38mm; }

    /* ── Paragraph-style descriptive text ──────────────────
       No colored backgrounds or bordered blocks — plain
       indented paragraphs with a preceding caption, like the
       "Remarks:" or "Particulars:" section on an invoice. */
    .para { margin-top: 2mm; font-size: 10pt; line-height: 1.6; }
    .para .cap {
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 1pt;
      text-transform: uppercase;
      color: #555;
      margin-bottom: 1mm;
    }
    .para .body { white-space: pre-line; }

    /* ── Photo grid ────────────────────────────────────────
       Plain bordered photos with a small caption. */
    .photos {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 3mm;
    }
    .photo {
      border: 0.5pt solid #000;
      page-break-inside: avoid;
    }
    .photo img { width: 100%; height: 44mm; object-fit: cover; display: block; }
    .photo .cap {
      padding: 2mm 2mm;
      font-size: 7.5pt;
      letter-spacing: 0.8pt;
      text-transform: uppercase;
      color: #555;
      border-top: 0.4pt solid #000;
      text-align: center;
    }

    /* ── Timeline (simple two-column list) ─────────────────
       Left: timestamp. Right: action description. */
    .timeline .entry {
      display: grid;
      grid-template-columns: 40mm 1fr;
      gap: 5mm;
      padding: 2mm 0;
      border-bottom: 0.4pt solid #d0d0d0;
      font-size: 10pt;
      page-break-inside: avoid;
    }
    .timeline .entry:last-child { border-bottom: none; }
    .timeline .when {
      font-family: "Roboto Mono", monospace;
      font-size: 8.5pt;
      color: #333;
    }
    .timeline .who {
      font-weight: 700;
      color: #000;
      margin-right: 3pt;
    }

    /* ── Totals line ───────────────────────────────────────
       Right-aligned, single row above a heavy rule — like
       the total on an invoice. */
    .total-line {
      margin-top: 4mm;
      display: flex;
      justify-content: flex-end;
    }
    .total-line .row {
      display: flex;
      justify-content: space-between;
      gap: 18mm;
      min-width: 80mm;
      padding: 2mm 0;
      border-top: 1pt solid #000;
      border-bottom: 1.5pt solid #000;
      font-size: 11pt;
      font-weight: 700;
      letter-spacing: 0.5pt;
      text-transform: uppercase;
    }
    .total-line .v { font-family: "Roboto Mono", monospace; }

    /* ── Footer layout (inside .ft-cell) ──────────────────────
       One-line computer-generated notice. Repeats on every
       page via table-footer-group. */
    .foot {
      padding-top: 2mm;
      border-top: 0.5pt solid #000;
      text-align: center;
      font-size: 8pt;
      color: #555;
      letter-spacing: 0.5pt;
    }

    /* ── Screen-only action bar ────────────────────────── */
    .print-bar {
      position: fixed;
      top: 14px; right: 14px;
      display: flex;
      gap: 8px;
      align-items: center;
      z-index: 100;
      padding: 6px;
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(6px);
      border-radius: 3pt;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    }
    .print-bar .tip {
      max-width: 260px;
      padding: 0 8px;
      font-size: 10.5px;
      line-height: 1.4;
      color: #444;
    }
    .print-bar .tip strong { color: #000; }
    .print-bar .tip em { font-style: normal; background: #f2ead9; padding: 0 3px; border-radius: 2px; }
    .print-bar button {
      padding: 8pt 14pt;
      background: #000;
      color: #fff;
      border: none;
      border-radius: 2pt;
      font-family: "Google Sans", "Roboto", Helvetica, Arial, sans-serif;
      font-size: 8.5pt;
      font-weight: 700;
      letter-spacing: 1.5pt;
      text-transform: uppercase;
      cursor: pointer;
    }
    .print-bar button.secondary {
      background: #fff; color: #000; border: 0.5pt solid #000;
    }
    @media print { .print-bar { display: none !important; } }

    .muted { color: #555; }
    .small { font-size: 8.5pt; }
  </style>
</head>
<body>
  <div class="print-bar">
    <div class="tip">
      <strong>Tip:</strong> in the print dialog, open
      <em>More settings</em> and untick <em>Headers and footers</em>
      to hide the browser's URL/date line.
    </div>
    <button class="secondary" onclick="window.close()">Close</button>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>

  <table class="sheet">

    <!-- ═══ Running letterhead (thead repeats every page) ═══ -->
    <thead><tr><td>
      <div class="letterhead">
        <div>
          ${logoUri
            ? `<img src="${logoUri}" alt="Houzs Century" class="logo" />`
            : `<div class="logo-fallback">Houzs&nbsp;Century</div>`}
        </div>
        <div class="company">
          <div class="co-name">HOUZS CENTURY SDN. BHD.</div>
          <div class="reg-no">202201031135 (1476832-W)</div>
          <div>1831-B, Jalan KPB 1, Kawasan Perindustrian Balakong,</div>
          <div>43300 Seri Kembangan, Selangor.</div>
        </div>
      </div>
    </td></tr></thead>

    <!-- ═══ Main content ═══ -->
    <tbody><tr><td>

    <!-- Title -->
    <div class="doc-title">
      <h1>After-Sales Service Report</h1>
      <div class="ref">Report No. ${esc(cs.assr_no)}</div>
    </div>

    <!-- Customer / Report metadata -->
    <div class="info">
      <div class="col">
        <div class="label">Customer</div>
        <div class="name-line">${esc(cs.customer_name || "—")}</div>
        <div class="line"><span class="k">Phone</span><span class="v">${esc(cs.phone || "—")}</span></div>
        <div class="line"><span class="k">Location</span><span class="v">${esc(cs.location || "—")}</span></div>
        ${cs.addr1 ? `<div class="line"><span class="k">Address</span><span class="v">${esc([cs.addr1, cs.addr2, cs.addr3, cs.addr4].filter(Boolean).join(", "))}</span></div>` : ""}
        <div class="line"><span class="k">Sales Agent</span><span class="v">${esc(cs.sales_agent || "—")}</span></div>
      </div>
      <div class="col">
        <div class="label">Report Details</div>
        <div class="line"><span class="k">Date</span><span class="v">${fmtDate(cs.complained_date)}</span></div>
        <div class="line"><span class="k">SO No.</span><span class="v">${esc(cs.doc_no)}</span></div>
        ${cs.po_no ? `<div class="line"><span class="k">PO No.</span><span class="v">${esc(cs.po_no)}</span></div>` : ""}
        <div class="line"><span class="k">Status</span><span class="v">${esc(STAGE_LABEL[cs.stage] || cs.stage)}</span></div>
        <div class="line"><span class="k">Priority</span><span class="v" style="text-transform: capitalize;">${esc(cs.priority || "normal")}</span></div>
        ${cs.deadline_at ? `<div class="line"><span class="k">Deadline</span><span class="v">${fmtDateTime(cs.deadline_at)}</span></div>` : ""}
        <div class="line"><span class="k">Prepared By</span><span class="v">${esc(cs.created_by_name || "—")}</span></div>
      </div>
    </div>

    <!-- 1. Items -->
    <section>
      <h2 class="sec">1. Items Under Service</h2>
      <table class="items">
        <thead>
          <tr>
            <th style="width: 8%">No.</th>
            <th style="width: 24%">Item Code</th>
            <th>Description</th>
            <th style="width: 10%" class="num">Qty</th>
          </tr>
        </thead>
        <tbody>
          ${items.length === 0 ? `<tr><td colspan="4" class="muted">No items recorded.</td></tr>` : items.map((it: any, i: number) => `
          <tr>
            <td class="num">${i + 1}</td>
            <td class="code">${esc(it.item_code)}</td>
            <td>${esc(it.item_description || "—")}</td>
            <td class="num">${esc(it.qty ?? 1)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>

    <!-- 2. Reported Issue -->
    <section>
      <h2 class="sec">2. Reported Issue</h2>
      <div class="rows rows-2col">
        <div class="row"><span class="k">Issue Category</span><span class="v">${esc(cs.issue_category || "—")}</span></div>
        <div class="row"><span class="k">NCR Category</span><span class="v">${esc(cs.ncr_category || "—")}</span></div>
        <div class="row"><span class="k">Service Category</span><span class="v">${esc(cs.service_category || "—")}</span></div>
        <div class="row"><span class="k">Priority Level</span><span class="v" style="text-transform: capitalize;">${esc(cs.priority || "normal")}</span></div>
      </div>
      <div class="para">
        <div class="cap">Complaint Description</div>
        <div class="body">${esc(cs.complaint_issue || "—")}</div>
      </div>
    </section>

    <!-- 3. Resolution Plan -->
    <section>
      <h2 class="sec">3. Resolution Plan</h2>
      <div class="rows rows-2col">
        <div class="row"><span class="k">Resolution Method</span><span class="v">${esc(cs.resolution_method ? (RESOLUTION_LABEL[cs.resolution_method] || cs.resolution_method) : "—")}</span></div>
        <div class="row"><span class="k">Assigned To</span><span class="v">${esc(cs.assigned_to_name || "—")}</span></div>
        <div class="row"><span class="k">Supplier</span><span class="v">${esc(cs.supplier_name || cs.supplier || "—")}</span></div>
        <div class="row"><span class="k">Supplier Contact</span><span class="v">${esc(cs.supplier_phone || "—")}</span></div>
        <div class="row"><span class="k">PO Number</span><span class="v mono">${esc(cs.po_no || "—")}</span></div>
        <div class="row"><span class="k">Target Completion</span><span class="v">${fmtDate(cs.completion_date)}</span></div>
      </div>
      ${cs.action_remark ? `
      <div class="para">
        <div class="cap">Action Remarks</div>
        <div class="body">${esc(cs.action_remark)}</div>
      </div>` : ""}
    </section>

    ${logistics.length > 0 ? `
    <section>
      <h2 class="sec">4. Logistics Schedule</h2>
      <table class="items">
        <thead>
          <tr>
            <th>Type</th>
            <th>Scheduled Date</th>
            <th>Time Window</th>
            <th>Assigned</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${logistics.map((l: any) => `
          <tr>
            <td style="text-transform: capitalize;">${esc(l.type)}</td>
            <td>${fmtDate(l.scheduled_date)}</td>
            <td>${esc(l.scheduled_time_range || "—")}</td>
            <td>${esc(l.assigned_to_name || "—")}</td>
            <td style="text-transform: capitalize;">${esc(l.status)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>
    ` : ""}

    ${(cs.po_amount != null || cs.supplier_invoice_ref || cs.cost_notes) ? `
    <section>
      <h2 class="sec">${logistics.length > 0 ? "5." : "4."} Cost &amp; Reconciliation</h2>
      <div class="rows rows-2col">
        <div class="row"><span class="k">Supplier Invoice Ref</span><span class="v mono">${esc(cs.supplier_invoice_ref || "—")}</span></div>
        <div class="row"><span class="k">PO Amount</span><span class="v mono">${cs.po_amount != null ? "MYR " + esc(Number(cs.po_amount).toFixed(2)) : "—"}</span></div>
      </div>
      ${cs.cost_notes ? `
      <div class="para">
        <div class="cap">Notes</div>
        <div class="body">${esc(cs.cost_notes)}</div>
      </div>` : ""}
      ${cs.po_amount != null ? `
      <div class="total-line">
        <div class="row"><span class="k">Total</span><span class="v">MYR ${esc(Number(cs.po_amount).toFixed(2))}</span></div>
      </div>` : ""}
    </section>
    ` : ""}

    ${inlinedImages.length > 0 ? `
    <section>
      <h2 class="sec">Supporting Evidence</h2>
      <div class="photos">
        ${inlinedImages.map((a) => `
        <div class="photo">
          <img src="${a.data_url}" alt="${esc(a.file_name || "")}" />
          <div class="cap">${esc(a.category)}</div>
        </div>`).join("")}
      </div>
    </section>
    ` : ""}

    ${otherAttachments.length > 0 ? `
    <section>
      <h2 class="sec">Additional Attachments</h2>
      <ul style="padding-left: 16pt; font-size: 9.5pt; margin: 2mm 0;">
        ${otherAttachments.map((a: any) => `<li>${esc(a.file_name || a.r2_key)} <span class="muted small">(${esc(a.category)})</span></li>`).join("")}
      </ul>
    </section>
    ` : ""}

    <section>
      <h2 class="sec">Case Timeline</h2>
      <div class="timeline">
        ${activity.length === 0 ? `<div class="entry"><span class="when">—</span><div class="muted">No activity recorded.</div></div>` : activity.slice().reverse().map((a: any) => {
          let body = "";
          if (a.action === "stage_change") body = `Stage advanced from <em>${esc(STAGE_LABEL[a.from_value] || a.from_value || "—")}</em> to <em>${esc(STAGE_LABEL[a.to_value] || a.to_value || "—")}</em>`;
          else if (a.action === "note") body = esc(a.note || "");
          else if (a.action === "created") body = "Case registered.";
          else if (a.action === "approval") body = `Quality review: ${esc(a.to_value === "passed" ? "Passed" : "Reviewed")}${a.note ? ` — ${esc(a.note)}` : ""}`;
          else if (a.action === "po_generated") body = `Purchase order generated: <em>${esc(a.to_value || "")}</em>`;
          else if (a.action === "assignment") body = `Case assigned to user #${esc(a.to_value || "")}`;
          else body = `${esc(a.action)} ${esc(a.to_value || "")}`;
          return `
          <div class="entry">
            <span class="when">${fmtDateTime(a.created_at)}</span>
            <div><span class="who">${esc(a.user_name || "System")}.</span>${body}${a.note && a.action === "stage_change" ? ` <span class="muted">(${esc(a.note)})</span>` : ""}</div>
          </div>`;
        }).join("")}
      </div>
    </section>

    ${cs.stage === "closed" ? `
    <section>
      <h2 class="sec">Case Closure</h2>
      <div class="rows rows-2col">
        <div class="row"><span class="k">Closed At</span><span class="v">${fmtDateTime(cs.closed_at)}</span></div>
        <div class="row"><span class="k">Satisfaction Rating</span><span class="v">${cs.satisfaction_rating ? `${esc(cs.satisfaction_rating)} / 5` : "—"}</span></div>
        ${cs.approved_at ? `<div class="row"><span class="k">Quality Review</span><span class="v">${esc(cs.approved_by_name || `User #${cs.approved_by}`)} · ${fmtDateTime(cs.approved_at)}${cs.quality_review_passed === 1 ? " · Passed" : ""}</span></div>` : ""}
      </div>
      ${cs.satisfaction_notes ? `
      <div class="para">
        <div class="cap">Customer Feedback</div>
        <div class="body">${esc(cs.satisfaction_notes)}</div>
      </div>` : ""}
    </section>
    ` : ""}

    </td></tr>
    <!-- Filler row: absorbs extra vertical space on the last
         page so the tfoot stays anchored to the page bottom
         even when content is short. -->
    <tr class="filler"><td>&nbsp;</td></tr>
    </tbody>

    <!-- ═══ Running footer (tfoot repeats every page) ═══ -->
    <tfoot><tr><td>
      <div class="foot">
        This is a computer-generated document and does not require a signature.
        Generated ${fmtDateTime(new Date().toISOString())}.
      </div>
    </td></tr></tfoot>

  </table>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

export default app;
