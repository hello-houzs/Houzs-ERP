import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { getAssrDetail } from "../services/assr";
import { renderStageTrackerHtml, STAGE_TRACKER_CSS } from "../services/printTracker";
import { qrSvg, getOrIssueCustomerPortalToken, customerPortalUrlFor } from "../services/printQr";

// Formal service-case document modeled on a standard Malaysian business
// invoice/service report:
//   · Letterhead with company name, registration no., and address
//   · Plain document title + reference metadata
//   · Two-column labeled customer / service details (no boxes)
//   · Minimal itemised list separated by horizontal rules
//   · Plain numbered sections
//   · Black & white, light use of a single accent rule
// No coloured backgrounds, no pills, no zebra rows, no decorative blocks.
//
// Three variants share the same chrome; differ in which sections they
// include and what extras (tracker SVG, QR code, acknowledgement) ride
// along. Variant chosen via `?variant=customer|supplier|office`.
// Default `office` preserves the legacy single-template behaviour.

const app = new Hono<{ Bindings: Env }>();

type Variant = "office" | "customer" | "supplier";

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
  pending_review: "Pending Review",
  under_verification: "Under Verification",
  pending_solution: "Pending Solution",
  pending_inspection: "Pending Inspection",
  pending_item_pickup: "Pending Item Pickup",
  pending_supplier_pickup: "Pending Supplier Pickup",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Pending Delivery / Service",
  completed: "Completed",
  registration: "Pending Review",
  triage: "Under Verification",
  action: "Pending Solution",
  logistics: "Pending Item Pickup",
  resolution: "Pending Delivery / Service",
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

/**
 * Compute the on-paper "Target Completion" for the supplier variant.
 * Uses `stage_entered_at + stage_target_days` for the case's CURRENT
 * stage — i.e. the supplier sees how long they've got from now to
 * the next handoff, not the case's e2e deadline.
 */
function supplierTargetDateIso(stageEnteredAt: string | null, stageTargetDays: number | null | undefined): string | null {
  if (!stageEnteredAt || !stageTargetDays) return null;
  const iso = stageEnteredAt.endsWith("Z") ? stageEnteredAt : stageEnteredAt + "Z";
  const t0 = new Date(iso).getTime();
  if (isNaN(t0)) return null;
  return new Date(t0 + stageTargetDays * 24 * 60 * 60 * 1000).toISOString();
}

app.get("/:id", requirePermission("service_cases.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.text("Invalid ID", 400);

  const rawVariant = (c.req.query("variant") || "office").toLowerCase();
  const variant: Variant =
    rawVariant === "customer" ? "customer"
    : rawVariant === "supplier" ? "supplier"
    : "office";
  const isCustomer = variant === "customer";
  const isSupplier = variant === "supplier";
  const isOffice = variant === "office";

  const detail = await getAssrDetail(c.env, id);
  if (!detail) return c.text("Not found", 404);

  const { case: cs, items, attachments, activity, logistics } = detail;
  const stageHistory = (detail as any).stage_history ?? [];

  const logoUri = await fetchAsDataUri(c.env, "static/logo-wordmark.png");

  const imageAttachments = attachments.filter((a: any) =>
    (a.content_type || "").startsWith("image/")
  );
  const otherAttachments = attachments.filter(
    (a: any) => !(a.content_type || "").startsWith("image/")
  );
  // Customer print only shows attachments flagged visible_to_customer.
  // Supplier print shows everything that isn't customer-marked-private.
  // Office sees the lot.
  const showImage = (a: any): boolean => {
    if (isOffice) return true;
    if (isCustomer) return a.visible_to_customer === 1 || a.visible_to_customer === true;
    return true; // supplier
  };
  const inlinedImages: Array<{ category: string; file_name: string | null; data_url: string }> = [];
  for (const att of imageAttachments as any[]) {
    if (!showImage(att)) continue;
    const uri = await fetchAsDataUri(c.env, att.r2_key as string, att.content_type || "image/jpeg");
    if (!uri) continue;
    inlinedImages.push({
      category: String(att.category ?? ""),
      file_name: att.file_name ? String(att.file_name) : null,
      data_url: uri,
    });
  }

  // Customer variant — generate (or reuse) a portal token + render QR.
  let customerPortalUrl = "";
  let qrInlineSvg = "";
  if (isCustomer) {
    const token = await getOrIssueCustomerPortalToken(c.env, id);
    customerPortalUrl = customerPortalUrlFor(c.env, token);
    qrInlineSvg = qrSvg(customerPortalUrl, 4);
  }

  // Supplier variant — derive the target-completion date for the
  // current stage from the snapshotted `stage_target_days`.
  const supplierTargetIso = isSupplier
    ? supplierTargetDateIso((cs as any).stage_entered_at, (cs as any).stage_target_days)
    : null;

  const trackerHtml = (isCustomer || isSupplier)
    ? renderStageTrackerHtml({
        history: stageHistory,
        currentStage: cs.stage,
      })
    : "";

  const docTitle =
    isCustomer ? "Customer Service Notice"
    : isSupplier ? "Supplier Service Order"
    : "After-Sales Service Report";

  const docSubtitle =
    isCustomer ? "Customer Copy"
    : isSupplier ? "Supplier Copy — for acknowledgement"
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(docTitle)} — ${esc(cs.assr_no)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    @page { size: A4; margin: 12mm 10mm 12mm 10mm; }

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

    table.sheet {
      width: 210mm;
      margin: 0 auto;
      border-collapse: collapse;
      background: #fff;
    }
    table.sheet td,
    table.sheet th { padding: 0; }

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

    table.sheet > thead > tr > td { padding: 2mm 10mm 3mm 10mm; }
    table.sheet > tbody > tr > td { padding: 2mm 10mm 2mm 10mm; }
    table.sheet > tfoot > tr > td { padding: 2mm 10mm 2mm 10mm; }
    table.sheet > tbody > tr.filler > td { padding: 0 !important; height: 100%; }

    .letterhead {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 4mm;
      border-bottom: 1.5pt solid #000;
    }
    .letterhead .logo { max-height: 46px; max-width: 210px; object-fit: contain; display: block; }
    .letterhead .logo-fallback { font-weight: 700; font-size: 18pt; letter-spacing: 1.2pt; color: #000; text-transform: uppercase; }
    .letterhead .company { text-align: right; font-size: 8.5pt; line-height: 1.4; color: #000; max-width: 95mm; }
    .letterhead .company .co-name { font-weight: 700; font-size: 10pt; letter-spacing: 0.3pt; text-transform: uppercase; }
    .letterhead .company .reg-no { font-family: "Roboto Mono", monospace; font-size: 8pt; margin-top: 0.5pt; }

    /* Design refresh — Plex Serif for the document title, left-aligned
       to sit next to the report meta on the right (the header row is
       still centered by the parent .doc-title container). */
    .doc-title { text-align: left; margin: 0 0 8mm 0; }
    .doc-title h1 { margin: 0; font-family: "IBM Plex Serif", "Georgia", serif; font-size: 22pt; font-weight: 700; letter-spacing: 0.2pt; line-height: 1.05; }
    .doc-title .subtitle { margin-top: 2mm; font-family: "Roboto Mono", monospace; font-size: 8.5pt; letter-spacing: 1.5pt; text-transform: uppercase; color: #555; }
    .doc-title .ref { margin-top: 3mm; font-family: "Roboto Mono", monospace; font-size: 10pt; color: #333; }

    /* Info strip with optional QR panel on the side */
    .info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10mm;
      margin-bottom: 8mm;
    }
    .info.with-qr {
      grid-template-columns: 1fr 1fr 38mm;
    }
    .info .col .label {
      font-size: 8pt; letter-spacing: 1pt; text-transform: uppercase; color: #555;
      border-bottom: 0.5pt solid #000; padding-bottom: 1.5mm; margin-bottom: 2.5mm; font-weight: 700;
    }
    .info .col .line {
      display: flex; gap: 4mm; padding: 2mm 0; border-bottom: 0.4pt solid #d0d0d0; font-size: 10pt;
    }
    .info .col .line:last-child { border-bottom: none; }
    .info .col .line .k { flex: 0 0 26mm; color: #555; }
    .info .col .line .v { flex: 1; color: #000; font-weight: 500; }
    .info .col .name-line { font-size: 11pt; font-weight: 700; margin-bottom: 1mm; }

    .qr-panel {
      border: 0.6pt solid #000; padding: 3mm; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 2mm;
    }
    .qr-panel .qr-cap {
      font-size: 7.5pt; letter-spacing: 1pt; text-transform: uppercase; color: #555; font-weight: 700;
    }
    .qr-panel .qr-svg { width: 32mm; height: 32mm; }
    .qr-panel .qr-svg svg { width: 100%; height: 100%; display: block; }
    .qr-panel .qr-url { font-family: "Roboto Mono", monospace; font-size: 6.5pt; word-break: break-all; line-height: 1.3; color: #333; }

    section { margin-top: 7mm; page-break-inside: avoid; }
    h2.sec {
      font-size: 9.5pt; font-weight: 700; letter-spacing: 2pt; text-transform: uppercase;
      margin: 0 0 3mm 0; padding-bottom: 2mm; border-bottom: 0.8pt solid #000;
    }

    .items { width: 100%; border-collapse: collapse; }
    .items th { text-align: left; font-size: 8pt; letter-spacing: 1pt; text-transform: uppercase; font-weight: 700; padding: 2mm 2mm; color: #555; border-bottom: 0.4pt solid #d0d0d0; }
    .items td { font-size: 10pt; padding: 2mm 2mm; border-bottom: 0.4pt solid #d0d0d0; vertical-align: top; }
    .items tr:last-child td { border-bottom: 0.4pt solid #d0d0d0; }
    .items .num { text-align: right; font-variant-numeric: tabular-nums; font-family: "Roboto Mono", monospace; }
    .items .code { font-family: "Roboto Mono", monospace; font-size: 9.5pt; }

    .rows .row { display: flex; gap: 4mm; padding: 2mm 0; border-bottom: 0.4pt solid #d0d0d0; font-size: 10pt; }
    .rows .row:last-child { border-bottom: none; }
    .rows .row .k { flex: 0 0 48mm; color: #555; }
    .rows .row .v { flex: 1; color: #000; font-weight: 500; }
    .rows .row .v.mono { font-family: "Roboto Mono", monospace; }
    .rows-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10mm; }
    .rows-2col .row .k { flex-basis: 38mm; }

    .para { margin-top: 2mm; font-size: 10pt; line-height: 1.6; }
    .para .cap { font-size: 8pt; font-weight: 700; letter-spacing: 1pt; text-transform: uppercase; color: #555; margin-bottom: 1mm; }
    .para .body { white-space: pre-line; }

    .photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; }
    .photo { border: 0.5pt solid #000; page-break-inside: avoid; }
    .photo img { width: 100%; height: 44mm; object-fit: cover; display: block; }
    .photo .cap { padding: 2mm 2mm; font-size: 7.5pt; letter-spacing: 0.8pt; text-transform: uppercase; color: #555; border-top: 0.4pt solid #000; text-align: center; }

    .timeline .entry { display: grid; grid-template-columns: 40mm 1fr; gap: 5mm; padding: 2mm 0; border-bottom: 0.4pt solid #d0d0d0; font-size: 10pt; page-break-inside: avoid; }
    .timeline .entry:last-child { border-bottom: none; }
    .timeline .when { font-family: "Roboto Mono", monospace; font-size: 8.5pt; color: #333; }
    .timeline .who { font-weight: 700; color: #000; margin-right: 3pt; }

    .total-line { margin-top: 4mm; display: flex; justify-content: flex-end; }
    .total-line .row { display: flex; justify-content: space-between; gap: 18mm; min-width: 80mm; padding: 2mm 0; border-top: 1pt solid #000; border-bottom: 1.5pt solid #000; font-size: 11pt; font-weight: 700; letter-spacing: 0.5pt; text-transform: uppercase; }
    .total-line .v { font-family: "Roboto Mono", monospace; }

    /* Supplier-only PO banner — highlighted across the page */
    .po-banner {
      display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 4mm;
      padding: 3mm 4mm; border: 1.5pt solid #000; margin-top: 4mm;
    }
    .po-banner .col .k {
      font-size: 7.5pt; letter-spacing: 1pt; text-transform: uppercase; color: #555; font-weight: 700;
    }
    .po-banner .col .v {
      font-family: "Roboto Mono", monospace; font-size: 12pt; font-weight: 700; margin-top: 1mm;
    }
    .po-banner .col.deadline .v { color: #b91c1c; }

    /* Supplier-only acknowledgement section */
    .ack { margin-top: 8mm; page-break-inside: avoid; }
    .ack .check-row {
      display: flex; align-items: center; gap: 6mm; padding: 3mm 0;
      border-bottom: 0.4pt solid #d0d0d0; font-size: 10pt;
    }
    .ack .check-row .box {
      width: 5mm; height: 5mm; border: 1pt solid #000; flex-shrink: 0;
    }
    .ack .sig-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10mm 14mm; margin-top: 6mm;
    }
    .ack .sig-grid .sig {
      border-top: 0.6pt solid #000; padding-top: 1.5mm;
      font-size: 8pt; letter-spacing: 1pt; text-transform: uppercase; color: #555; font-weight: 700;
    }
    .ack .sig-grid .sig-box {
      height: 18mm; border-bottom: 0.6pt solid #000;
    }

    /* Design refresh — dual sign-off block for the customer + supplier
       variants. Two side-by-side panels; each has bullet checkboxes
       for what the counter-party is confirming, then a signature line
       and a name+date row. Black-and-white only; prints cleanly on
       mono printers. */
    .signoff {
      margin-top: 8mm; page-break-inside: avoid;
      display: grid; grid-template-columns: 1fr 1fr; border: 0.6pt solid #000;
    }
    .signoff .panel { padding: 5mm 6mm 6mm; }
    .signoff .panel + .panel { border-left: 0.6pt solid #000; }
    .signoff .panel h3 {
      margin: 0 0 4mm 0; font-family: "IBM Plex Serif", "Georgia", serif;
      font-size: 12pt; font-weight: 700;
    }
    .signoff .check {
      display: flex; align-items: flex-start; gap: 4mm; margin-bottom: 3.5mm;
      font-size: 10pt; line-height: 1.4;
    }
    .signoff .check .box {
      width: 4.5mm; height: 4.5mm; border: 0.8pt solid #000; flex-shrink: 0; margin-top: 0.6mm;
    }
    .signoff .sig-rule {
      border-top: 0.6pt solid #000; margin-top: 6mm; padding-top: 2mm;
    }
    .signoff .sig-rule .cap {
      font-family: "Roboto Mono", monospace; font-size: 7.5pt;
      letter-spacing: 0.8pt; text-transform: uppercase; color: #6a6a6a; font-weight: 700;
    }
    .signoff .name-date {
      display: flex; gap: 6mm; margin-top: 6mm;
    }
    .signoff .name-date .cell {
      flex: 1; border-bottom: 0.5pt solid #666; padding-bottom: 1.5mm;
    }
    .signoff .name-date .cell .cap {
      font-family: "Roboto Mono", monospace; font-size: 7.5pt;
      letter-spacing: 0.8pt; text-transform: uppercase; color: #6a6a6a; font-weight: 700;
    }

    .foot { padding-top: 2mm; border-top: 0.5pt solid #000; text-align: center; font-size: 8pt; color: #555; letter-spacing: 0.5pt; }

    .print-bar {
      position: fixed; top: 14px; right: 14px;
      display: flex; gap: 8px; align-items: center; z-index: 100;
      padding: 6px; background: rgba(255,255,255,0.95); backdrop-filter: blur(6px);
      border-radius: 3pt; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    }
    .print-bar .tip { max-width: 260px; padding: 0 8px; font-size: 10.5px; line-height: 1.4; color: #444; }
    .print-bar .tip strong { color: #000; }
    .print-bar .tip em { font-style: normal; background: #f2ead9; padding: 0 3px; border-radius: 2px; }
    .print-bar button {
      padding: 8pt 14pt; background: #000; color: #fff; border: none; border-radius: 2pt;
      font-family: "Google Sans", "Roboto", Helvetica, Arial, sans-serif; font-size: 8.5pt;
      font-weight: 700; letter-spacing: 1.5pt; text-transform: uppercase; cursor: pointer;
    }
    .print-bar button.secondary { background: #fff; color: #000; border: 0.5pt solid #000; }
    @media print { .print-bar { display: none !important; } }

    .muted { color: #555; }
    .small { font-size: 8.5pt; }

    ${STAGE_TRACKER_CSS}
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

    <tbody><tr><td>

    <div class="doc-title">
      <h1>${esc(docTitle)}</h1>
      ${docSubtitle ? `<div class="subtitle">${esc(docSubtitle)}</div>` : ""}
      <div class="ref">Report No. ${esc(cs.assr_no)}</div>
    </div>

    ${trackerHtml}

    <!-- Customer / Report metadata. Customer variant adds a QR panel
         in a third column; Supplier variant keeps the 2-col layout but
         drops customer phone + address from the customer block. -->
    <div class="info${isCustomer ? " with-qr" : ""}">
      <div class="col">
        <div class="label">${isSupplier ? "Bill To" : "Customer"}</div>
        <div class="name-line">${esc(cs.customer_name || "—")}</div>
        ${isSupplier ? "" : `<div class="line"><span class="k">Phone</span><span class="v">${esc(cs.phone || "—")}</span></div>`}
        <div class="line"><span class="k">Location</span><span class="v">${esc(cs.location || "—")}</span></div>
        ${cs.addr1 && !isSupplier ? `<div class="line"><span class="k">Address</span><span class="v">${esc([cs.addr1, cs.addr2, cs.addr3, cs.addr4].filter(Boolean).join(", "))}</span></div>` : ""}
        ${isOffice ? `<div class="line"><span class="k">Sales Agent</span><span class="v">${esc(cs.sales_agent || "—")}</span></div>` : ""}
      </div>
      <div class="col">
        <div class="label">${isSupplier ? "Service Order" : "Report Details"}</div>
        <div class="line"><span class="k">Date</span><span class="v">${fmtDate(cs.complained_date)}</span></div>
        <div class="line"><span class="k">SO No.</span><span class="v">${esc(cs.doc_no)}</span></div>
        ${cs.po_no ? `<div class="line"><span class="k">PO No.</span><span class="v">${esc(cs.po_no)}</span></div>` : ""}
        <div class="line"><span class="k">Status</span><span class="v">${esc(STAGE_LABEL[cs.stage] || cs.stage)}</span></div>
        <div class="line"><span class="k">Priority</span><span class="v" style="text-transform: capitalize;">${esc(cs.priority || "normal")}</span></div>
        ${cs.deadline_at && !isCustomer ? `<div class="line"><span class="k">Deadline</span><span class="v">${fmtDateTime(cs.deadline_at)}</span></div>` : ""}
        ${isOffice ? `<div class="line"><span class="k">Prepared By</span><span class="v">${esc((cs as any).created_by_name || "—")}</span></div>` : ""}
      </div>
      ${isCustomer ? `
      <div class="qr-panel">
        <div class="qr-cap">Track this case</div>
        <div class="qr-svg">${qrInlineSvg}</div>
        <div class="qr-url">${esc(customerPortalUrl)}</div>
      </div>` : ""}
    </div>

    ${isSupplier ? `
    <!-- Supplier PO banner — highlighted PO + creditor + deadline -->
    <div class="po-banner">
      <div class="col">
        <div class="k">Supplier (Creditor)</div>
        <div class="v" style="font-size: 11pt;">${esc((cs as any).creditor_name || (cs as any).creditor_code || "—")}</div>
      </div>
      <div class="col">
        <div class="k">PO Number</div>
        <div class="v">${esc(cs.po_no || "—")}</div>
      </div>
      <div class="col deadline">
        <div class="k">Target Completion</div>
        <div class="v">${supplierTargetIso ? fmtDate(supplierTargetIso) : "—"}</div>
      </div>
    </div>
    ` : ""}

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
        ${isOffice ? `<div class="row"><span class="k">NCR Category</span><span class="v">${esc(cs.ncr_category || "—")}</span></div>` : ""}
        ${isOffice ? `<div class="row"><span class="k">Service Category</span><span class="v">${esc(cs.service_category || "—")}</span></div>` : ""}
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
        ${isCustomer ? "" : `<div class="row"><span class="k">Assigned To</span><span class="v">${esc((cs as any).assigned_to_name || "—")}</span></div>`}
        ${isCustomer ? "" : `<div class="row"><span class="k">Supplier</span><span class="v">${esc((cs as any).supplier_name || (cs as any).supplier || "—")}</span></div>`}
        ${isOffice ? `<div class="row"><span class="k">Supplier Contact</span><span class="v">${esc((cs as any).supplier_phone || "—")}</span></div>` : ""}
        ${isCustomer ? "" : `<div class="row"><span class="k">PO Number</span><span class="v mono">${esc(cs.po_no || "—")}</span></div>`}
        <div class="row"><span class="k">Target Completion</span><span class="v">${fmtDate(cs.completion_date)}</span></div>
      </div>
      ${cs.action_remark && !isCustomer ? `
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

    ${isOffice && (cs.po_amount != null || cs.supplier_invoice_ref || cs.cost_notes) ? `
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

    ${isOffice && otherAttachments.length > 0 ? `
    <section>
      <h2 class="sec">Additional Attachments</h2>
      <ul style="padding-left: 16pt; font-size: 9.5pt; margin: 2mm 0;">
        ${otherAttachments.map((a: any) => `<li>${esc(a.file_name || a.r2_key)} <span class="muted small">(${esc(a.category)})</span></li>`).join("")}
      </ul>
    </section>
    ` : ""}

    ${isOffice ? `
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
    ` : ""}

    ${cs.stage === "completed" && !isSupplier ? `
    <section>
      <h2 class="sec">Case Closure</h2>
      <div class="rows rows-2col">
        <div class="row"><span class="k">Closed At</span><span class="v">${fmtDateTime(cs.closed_at)}</span></div>
        <div class="row"><span class="k">Satisfaction Rating</span><span class="v">${cs.satisfaction_rating ? `${esc(cs.satisfaction_rating)} / 5` : "—"}</span></div>
        ${(cs as any).approved_at && isOffice ? `<div class="row"><span class="k">Quality Review</span><span class="v">${esc((cs as any).approved_by_name || `User #${(cs as any).approved_by}`)} · ${fmtDateTime((cs as any).approved_at)}${(cs as any).quality_review_passed === 1 ? " · Passed" : ""}</span></div>` : ""}
      </div>
      ${cs.satisfaction_notes && isOffice ? `
      <div class="para">
        <div class="cap">Customer Feedback</div>
        <div class="body">${esc(cs.satisfaction_notes)}</div>
      </div>` : ""}
    </section>
    ` : ""}

    ${isCustomer ? `
    <!-- Customer variant sign-off (design refresh) — Customer + Warehouse
         side-by-side, each with tick-box confirmations and signature
         line. Prints in black & white on the same sheet as the case
         report, so the customer + warehouse ack lands together with
         the details they're signing off on. -->
    <section>
      <h2 class="sec">Acknowledgement &amp; Sign-off</h2>
      <div class="signoff">
        <div class="panel">
          <h3>Customer</h3>
          <div class="check">
            <span class="box"></span>
            <span>I confirm the reported issue and details above are correct.</span>
          </div>
          <div class="check">
            <span class="box"></span>
            <span>I have received the serviced / replaced item in good condition.</span>
          </div>
          <div class="sig-rule">
            <span class="cap">Signature</span>
          </div>
          <div class="name-date">
            <div class="cell"><span class="cap">Name</span></div>
            <div class="cell" style="max-width: 44mm"><span class="cap">Date</span></div>
          </div>
        </div>
        <div class="panel">
          <h3>Warehouse</h3>
          <div class="check">
            <span class="box"></span>
            <span>Goods inspected and received in good condition.</span>
          </div>
          <div class="check">
            <span class="box"></span>
            <span>Service / repair completed per the plan above.</span>
          </div>
          <div class="sig-rule">
            <span class="cap">Received &amp; signed</span>
          </div>
          <div class="name-date">
            <div class="cell"><span class="cap">Name</span></div>
            <div class="cell" style="max-width: 44mm"><span class="cap">Date</span></div>
          </div>
        </div>
      </div>
    </section>
    ` : ""}

    ${isSupplier ? `
    <!-- Supplier variant sign-off (design refresh) — Supplier + Houzs
         Century representative, matching the design's Supplier Service
         Order acknowledgement layout. -->
    <section>
      <h2 class="sec">Acknowledgement &amp; Sign-off</h2>
      <div class="signoff">
        <div class="panel">
          <h3>Supplier</h3>
          <div class="check">
            <span class="box"></span>
            <span>Goods inspected and received in good condition.</span>
          </div>
          <div class="check">
            <span class="box"></span>
            <span>Service / repair completed per the resolution plan above.</span>
          </div>
          <div class="sig-rule">
            <span class="cap">Signature</span>
          </div>
          <div class="name-date">
            <div class="cell"><span class="cap">Name</span></div>
            <div class="cell" style="max-width: 44mm"><span class="cap">Date</span></div>
          </div>
        </div>
        <div class="panel">
          <h3>Houzs Century Representative</h3>
          <div class="check">
            <span class="box"></span>
            <span>Verified supplier work meets the resolution plan.</span>
          </div>
          <div class="check">
            <span class="box"></span>
            <span>Handover accepted for return to the warehouse.</span>
          </div>
          <div class="sig-rule">
            <span class="cap">Verified &amp; signed</span>
          </div>
          <div class="name-date">
            <div class="cell"><span class="cap">Name</span></div>
            <div class="cell" style="max-width: 44mm"><span class="cap">Date</span></div>
          </div>
        </div>
      </div>
    </section>
    ` : ""}

    ${isCustomer ? `
    <section>
      <div class="para muted small" style="text-align: center; margin-top: 6mm;">
        Track your case anytime — scan the code above or visit the URL.<br/>
        For questions, contact us at the address on the letterhead.
      </div>
    </section>
    ` : ""}

    </td></tr>
    <tr class="filler"><td>&nbsp;</td></tr>
    </tbody>

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
