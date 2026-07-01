import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { MODULE_CONFIGS } from "./MobileModuleList";
import "./mobile.css";

// ── Field-ops parity (owner "现场为主") ──────────────────────────────────────
// Two capabilities added to the generic document detail so the mobile app is a
// full field companion, sharing the SAME backend + the SAME desktop PDF
// generators:
//   1) Print / Share PDF — a header icon button that re-fetches the full
//      document bundle (header + items, identical to what the desktop detail
//      page feeds its generator) then calls the matching generate*Pdf helper
//      from ../vendor/scm/lib. No PDF layout is reimplemented here.
//   2) Header Edit / Save — an in-detail edit sheet for the SIMPLE header fields
//      (dates / references / notes) each desktop page PATCHes to {path}/:id.
//      Complex customer / supplier / warehouse / line edits stay desktop-only;
//      the lock rules mirror each desktop page's isLocked gating so a posted /
//      cancelled / child-bearing document is never editable on mobile.

// ---------------------------------------------------------------------------
// MobileModuleDetail — ONE generic, read-only DETAIL screen behind the generic
// MobileModuleList. Given the module key + the already-loaded list `row`, it
// renders a clean full detail: a header card (doc number, party, status pill,
// date, money stats) plus — for document modules — a line-items list fetched by
// id. Simple (non-document) modules just render a tidy key/value dump of the
// row already handed in. Header + card idiom is a 1:1 match of MobileSODetail /
// MobilePMS (safe-area header, hz-scroll paddingBottom:120, status pill via
// color-mix, kv grid, .money numerals). Everything degrades: a missing field is
// an em-dash, never undefined / null / NaN.
//
// Document `:id` endpoints + shapes wired (read from backend/src/scm/routes):
//   delivery-orders-mfg  GET /delivery-orders-mfg/:id → { deliveryOrder, items }
//   sales-invoices       GET /sales-invoices/:id       → { salesInvoice,  items }
//   grns                 GET /grns/:id                 → { grn,           items }
//   mfg-purchase-orders  GET /mfg-purchase-orders/:id  → { purchaseOrder, items }
// ---------------------------------------------------------------------------

const rm = (centi: unknown) => {
  const n = Number(centi);
  return (Number.isFinite(n) ? n / 100 : 0).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};
const money = (centi: unknown) => `RM ${rm(centi)}`;

/** DD MMM YYYY, or em-dash when absent / unparseable. */
const dmy = (d: unknown) => {
  if (d == null || d === "") return "—";
  const dt = new Date(String(d));
  if (isNaN(+dt)) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/** Coerce anything to a safe display string; blanks / nullish → "". */
const s = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v;
  return "";
};

const join = (...parts: unknown[]) => parts.map(s).map((p) => p.trim()).filter(Boolean).join(" · ");

/** Run a config accessor (primary / pill) against a row, swallowing throws. */
const safeCall = (fn: ((row: any) => string) | undefined, row: any): string => {
  if (!fn) return "";
  try { return fn(row) ?? ""; } catch { return ""; }
};

/** first non-empty string of the candidates, else "—". */
const firstOf = (...vals: unknown[]): string => {
  for (const v of vals) {
    const str = s(v).trim();
    if (str) return str;
  }
  return "—";
};

const pct = (basis: unknown) => {
  const n = Number(basis);
  if (!Number.isFinite(n)) return "—";
  return `${(n / 100).toLocaleString("en-MY", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
};

// ── Status → three-phase pill (mirror MobileSODetail phase()) ────────────────
function phase(status: unknown): "draft" | "cancelled" | "live" {
  const st = s(status).toUpperCase();
  if (st === "DRAFT") return "draft";
  if (st === "CANCELLED" || st === "VOID" || st === "VOIDED") return "cancelled";
  return "live";
}

function StatusPill({ status }: { status: unknown }) {
  const raw = s(status).trim();
  if (!raw) return null;
  const p = phase(status);
  // VERBATIM from MobileSODetail's soPill: Submitted [#e1efed,#0c3f39,none] ·
  // Draft [#f4f6f3,#767b6e,border] · Cancelled [#f8eaea,#b23a3a,none].
  const map: Record<string, [string, string, string]> = {
    live: ["#e1efed", "#0c3f39", "none"],
    draft: ["#f4f6f3", "#767b6e", "1px solid #e3e6e0"],
    cancelled: ["#f8eaea", "#b23a3a", "none"],
  };
  const [bg, fg, border] = map[p];
  const label = raw
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
  return (
    <span className="spill" style={{ background: bg, color: fg, border }}>
      {label}
    </span>
  );
}

// ── Shared little presentational bits (design classes from MobileSODetail) ───
/** One key/value cell as it sits inside a `.pgrid2` grid — `.pkv-l` label over
 *  a `.pkv-v` value (money-monospaced when `mono`). Verbatim SO-detail idiom. */
function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="pkv-l">{label}</div>
      <div className={mono ? "pkv-v money" : "pkv-v"} style={{ wordBreak: "break-word" }}>{value || "—"}</div>
    </div>
  );
}

/** Money stat card — one of the 3 white cards under the header, `.ey` label. */
function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 11, padding: 10, textAlign: "center" }}>
      <div className="money" style={{ fontSize: 13, fontWeight: 800, color }}>{value}</div>
      <div className="ey" style={{ color: "#9aa093", marginTop: 3 }}>{label}</div>
    </div>
  );
}

function Eyebrow({ children }: { children: string }) {
  return <div className="ey" style={{ color: "#767b6e", margin: "4px 2px 6px" }}>{children}</div>;
}

/** Print / Share PDF header icon button — parity with MobileSODetail's Print
 *  button. Fetches the full desktop bundle then calls the matching generator.
 *  Only rendered for the field-ops document types (PRINT_MODULES). */
function PrintButton({ moduleKey, id }: { moduleKey: string; id: string }) {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  if (!PRINT_MODULES[moduleKey] || !id) return null;
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runPrint(moduleKey, id);
    } catch (e) {
      void notify({ title: "Couldn't generate the PDF", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button onClick={() => void run()} disabled={busy} aria-label="Print PDF" className="iconbtn" style={{ opacity: busy ? 0.5 : 1 }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" /></svg>
    </button>
  );
}

/** Header Edit / Save bottom sheet — edits the SIMPLE header fields (dates /
 *  refs / notes) for a field-ops document via PATCH {path}/:id. Edit→Save
 *  discipline: the operator changes fields then taps Save; only the changed
 *  fields are sent. On success the detail + list queries invalidate so the
 *  screen refreshes. Renders a locked note (no form) when the doc is locked. */
function HeaderEditSheet({ moduleKey, id, header, onClose, onSaved }: {
  moduleKey: string; id: string; header: any; onClose: () => void; onSaved: () => void;
}) {
  const notify = useNotify();
  const cfg = EDIT_MODULES[moduleKey];
  const locked = cfg ? cfg.locked(header) : true;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of cfg?.fields ?? []) seed[f.key] = f.get(header);
    return seed;
  });
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!cfg) throw new Error("This document can't be edited here.");
      // Send only the fields the operator actually changed.
      const body: Record<string, unknown> = {};
      for (const f of cfg.fields) {
        const next = values[f.key] ?? "";
        if (next !== f.get(header)) body[f.key] = f.type === "date" ? (next || null) : next;
      }
      if (Object.keys(body).length === 0) return { unchanged: true };
      await authedFetch(`${cfg.path}/${encodeURIComponent(id)}`, { method: cfg.method, body: JSON.stringify(body) });
      return { unchanged: false };
    },
    onSuccess: (r) => {
      if (r?.unchanged) { onClose(); return; }
      onSaved();
      onClose();
      void notify({ title: "Saved" });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't save the changes. Please try again."),
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", height: 42, padding: "0 12px", borderRadius: 10,
    border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 14, color: "var(--ink)",
  };
  const labelStyle: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "#9aa093", marginBottom: 5, display: "block" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2500, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="hz-m" style={{ width: "100%", maxHeight: "88vh", overflowY: "auto", background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(env(safe-area-inset-bottom) + 16px)", boxShadow: "0 -8px 28px rgba(0,0,0,0.16)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>Edit Details</div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 15, fontWeight: 700, color: "var(--teal)", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
        </div>

        {locked || !cfg ? (
          <div style={{ fontSize: 12.5, color: "#9aa093", padding: "8px 0 6px", textAlign: "center" }}>{cfg?.lockedNote ?? "This document can't be edited here."}</div>
        ) : (
          <>
            {cfg.fields.map((f) => (
              <div key={f.key} style={{ marginBottom: 12 }}>
                <label style={labelStyle}>{f.label}</label>
                {f.type === "textarea" ? (
                  <textarea
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    rows={3}
                    style={{ ...inputStyle, height: "auto", padding: "10px 12px", resize: "vertical" }}
                  />
                ) : (
                  <input
                    type={f.type === "date" ? "date" : "text"}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    style={inputStyle}
                  />
                )}
              </div>
            ))}

            {error && <div style={{ fontSize: 11.5, color: "#b23a3a", margin: "2px 0 12px", textAlign: "center" }}>{error}</div>}

            <button
              className="btn"
              disabled={mutation.isPending}
              onClick={() => { setError(null); mutation.mutate(); }}
              style={{ opacity: mutation.isPending ? 0.6 : 1 }}
            >
              {mutation.isPending ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** One `.docrow` line item: name + qty on top, unit price + amount below. */
function LineItem({ name, sub, qty, unitCenti, amountCenti }: {
  name: string; sub?: string; qty: unknown; unitCenti: unknown; amountCenti: unknown;
}) {
  const q = Number(qty);
  const qtyLabel = Number.isFinite(q) ? q : 0;
  return (
    <div className="docrow" style={{ flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "#11140f" }}>
        {name || "—"} <span style={{ color: "#9aa093", fontWeight: 600 }}>{"×"}{qtyLabel}</span>
      </span>
      <span className="money" style={{ fontSize: 12.5, fontWeight: 800, color: "#11140f", flex: "none" }}>{money(amountCenti)}</span>
      <div className="money" style={{ flexBasis: "100%", fontSize: 10.5, color: "#9aa093" }}>
        {sub ? <span style={{ marginRight: 8 }}>{sub}</span> : null}
        <span>@ {money(unitCenti)}</span>
      </div>
    </div>
  );
}

// ── Header card (shared by every module) ────────────────────────────────────
function DetailHeader({ eyebrow, title, subtitle, status, onBack, onEdit, print, onFieldEdit }: {
  eyebrow: string; title: string; subtitle?: string; status?: unknown; onBack: () => void; onEdit?: () => void;
  /** Field-ops Print / Share PDF — rendered as a header icon button. */
  print?: { moduleKey: string; id: string };
  /** Field-ops header Edit / Save — opens the HeaderEditSheet. Distinct from
   *  `onEdit` (which routes to the create-form editor for form modules). */
  onFieldEdit?: () => void;
}) {
  return (
    <header className="hdr">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}>
          <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> Back
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {print && <PrintButton moduleKey={print.moduleKey} id={print.id} />}
          <StatusPill status={status} />
          {onFieldEdit && (
            <button className="tinybtn" onClick={onFieldEdit} style={{ background: "#e1efed", border: "1px solid #16695f", color: "#0c3f39" }}>
              Edit
            </button>
          )}
          {onEdit && (
            <button className="tinybtn" onClick={onEdit} style={{ background: "#e1efed", border: "1px solid #16695f", color: "#0c3f39" }}>
              Edit
            </button>
          )}
        </div>
      </div>
      {eyebrow ? <div className="money" style={{ fontSize: 11.5, fontWeight: 700, color: "#a16a2e", marginTop: 7 }}>{eyebrow}</div> : null}
      <div style={{ fontSize: 19, fontWeight: 800, color: "#11140f", marginTop: 2, wordBreak: "break-word" }}>{title || "—"}</div>
      {subtitle ? <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{subtitle}</div> : null}
    </header>
  );
}

const scrollStyle: React.CSSProperties = { padding: 14, paddingBottom: 120 };
const wrapStyle: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" };
// Line-items / list card — same white rounded shell as MobileSODetail's item card.
const cardStyle: React.CSSProperties = { background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "2px 12px", marginBottom: 13 };

// ---------------------------------------------------------------------------
// Document detail — fetches header + line items by id, per module.
// ---------------------------------------------------------------------------

type DocMap = {
  path: string;
  headerKey: string;
  eyebrow: (h: any) => string;
  title: (h: any) => string;
  subtitle?: (h: any) => string;
  status: (h: any) => unknown;
  /** KV grid rows: [label, value]. */
  meta: (h: any) => Array<[string, string]>;
  /** [Total, Secondary, Tertiary] stats — each [label, value, color] or null. */
  stats: (h: any) => Array<[string, string, string] | null>;
  line: (it: any) => { name: string; sub?: string; qty: unknown; unitCenti: unknown; amountCenti: unknown };
};

const nested = (v: any) => (Array.isArray(v) ? v[0] : v) ?? null;

const DOC_MODULES: Record<string, DocMap> = {
  "delivery-orders-mfg": {
    path: "/delivery-orders-mfg",
    headerKey: "deliveryOrder",
    eyebrow: (h) => firstOf(h.do_number),
    title: (h) => firstOf(h.debtor_name, h.debtor_code),
    subtitle: (h) => (s(h.so_doc_no).trim() ? `SO ${s(h.so_doc_no)}` : ""),
    status: (h) => h.status,
    meta: (h) => [
      ["DO Date", dmy(h.do_date)],
      ["Delivery", dmy(h.customer_delivery_date ?? h.expected_delivery_at)],
      ["Phone", firstOf(h.phone)],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Reference", firstOf(h.ref, h.po_doc_no)],
      ["Salesperson", firstOf(h.agent)],
    ],
    stats: (h) => [
      ["Total", money(h.local_total_centi), "var(--ink)"],
      ["Cost", money(h.total_cost_centi), "#a16a2e"],
      ["Margin", money(h.total_margin_centi), "#2f8a5b"],
    ],
    line: (it) => ({
      name: firstOf(it.description, it.item_code),
      sub: join(it.item_code, it.warehouse_code, dmy(it.line_delivery_date) !== "—" ? dmy(it.line_delivery_date) : ""),
      qty: it.qty,
      unitCenti: it.unit_price_centi,
      amountCenti: it.line_total_centi,
    }),
  },

  "sales-invoices": {
    path: "/sales-invoices",
    headerKey: "salesInvoice",
    eyebrow: (h) => firstOf(h.invoice_number),
    title: (h) => firstOf(h.debtor_name, h.debtor_code),
    subtitle: (h) => (s(h.so_doc_no).trim() ? `SO ${s(h.so_doc_no)}` : ""),
    status: (h) => h.status,
    meta: (h) => [
      ["Invoice Date", dmy(h.invoice_date)],
      ["Due Date", dmy(h.due_date)],
      ["Phone", firstOf(h.phone)],
      ["Location", firstOf(h.sales_location, h.customer_state, h.state)],
      ["Reference", firstOf(h.ref, h.po_doc_no)],
      ["Salesperson", firstOf(h.agent)],
    ],
    stats: (h) => {
      const totalCenti = Number(h.total_centi ?? h.local_total_centi ?? 0);
      const paidCenti = Number(h.paid_centi ?? 0);
      const bal = Math.max(0, (Number.isFinite(totalCenti) ? totalCenti : 0) - (Number.isFinite(paidCenti) ? paidCenti : 0));
      return [
        ["Total", money(h.total_centi ?? h.local_total_centi), "var(--ink)"],
        ["Paid", money(h.paid_centi), "#2f8a5b"],
        ["Balance", money(bal), bal > 0 ? "#a16a2e" : "var(--ink)"],
      ];
    },
    line: (it) => ({
      name: firstOf(it.description, it.item_code),
      sub: join(it.item_code, it.description2),
      qty: it.qty,
      unitCenti: it.unit_price_centi,
      amountCenti: it.line_total_centi,
    }),
  },

  grns: {
    path: "/grns",
    headerKey: "grn",
    eyebrow: (h) => firstOf(h.grn_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.grn_number),
    subtitle: (h) => {
      const code = s(nested(h.supplier)?.code).trim();
      const po = s(nested(h.purchase_order)?.po_number).trim();
      return join(code, po ? `PO ${po}` : "");
    },
    status: (h) => h.status,
    meta: (h) => [
      ["Received", dmy(h.received_at)],
      ["Delivery Note", firstOf(h.delivery_note_ref)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["Currency", firstOf(h.currency)],
    ],
    stats: (h) => [
      ["Subtotal", money(h.subtotal_centi), "var(--ink)"],
      ["Tax", money(h.tax_centi), "#767b6e"],
      ["Total", money(h.total_centi), "var(--ink)"],
    ],
    line: (it) => ({
      name: firstOf(it.material_name, it.description, it.material_code),
      sub: join(it.material_code, s(it.qty_accepted).trim() ? `Accepted ${s(it.qty_accepted)}` : ""),
      qty: it.qty_received ?? it.qty_accepted,
      unitCenti: it.unit_price_centi,
      amountCenti: it.line_total_centi,
    }),
  },

  "mfg-purchase-orders": {
    path: "/mfg-purchase-orders",
    headerKey: "purchaseOrder",
    eyebrow: (h) => firstOf(h.po_number),
    title: (h) => firstOf(nested(h.supplier)?.name, h.po_number),
    subtitle: (h) => firstOf(nested(h.supplier)?.code) === "—" ? "" : firstOf(nested(h.supplier)?.code),
    status: (h) => h.status,
    meta: (h) => [
      ["PO Date", dmy(h.po_date)],
      ["Expected", dmy(h.expected_at)],
      ["Supplier", firstOf(nested(h.supplier)?.code)],
      ["Contact", firstOf(nested(h.supplier)?.contact_person, nested(h.supplier)?.phone)],
      ["Currency", firstOf(h.currency)],
      ["Submitted", dmy(h.submitted_at)],
    ],
    stats: (h) => [
      ["Subtotal", money(h.subtotal_centi), "var(--ink)"],
      ["Tax", money(h.tax_centi), "#767b6e"],
      ["Total", money(h.total_centi), "var(--ink)"],
    ],
    line: (it) => ({
      name: firstOf(it.material_name, it.description, it.material_code),
      sub: join(it.material_code, s(it.received_qty).trim() ? `Received ${s(it.received_qty)}` : ""),
      qty: it.qty,
      unitCenti: it.unit_price_centi,
      amountCenti: it.line_total_centi,
    }),
  },
};

/** Derive the id to fetch by from the list row. All four detail routes key on
 *  the uuid `id`; fall back to any doc-number field if `id` is ever absent. */
function docId(row: any): string {
  return s(
    row?.id ??
      row?.do_number ??
      row?.invoice_number ??
      row?.grn_number ??
      row?.po_number ??
      row?.return_number,
  );
}

// ---------------------------------------------------------------------------
// PRINT / SHARE PDF — per-doc-type wiring. Each entry re-fetches the SAME full
// bundle (`GET {path}/:id` → { <headerKey>, items }) the desktop detail page
// feeds its generator, then invokes the matching desktop generate*Pdf. The
// desktop generators all call jsPDF's doc.save() internally (no "mode" arg —
// unlike the SO generator), so downloading is their built-in behaviour. The
// active tree's authedFetch already dual-reads camelCase ?? snake_case, so the
// raw snake_case header from these routes reaches the generators intact.
// ---------------------------------------------------------------------------

type PrintMap = {
  /** GET path (relative to /api/scm). */
  path: string;
  /** Response key holding the header object. */
  headerKey: string;
  /** Fetch the bundle → generate the PDF. `enrich` runs an optional pre-pass
   *  (e.g. PO's warehouse deliver-to resolution) mirroring the desktop page. */
  print: (header: any, items: any[]) => Promise<void>;
};

/** Print-config for every field-ops document type. Keyed by moduleKey. */
const PRINT_MODULES: Record<string, PrintMap> = {
  "delivery-orders-mfg": {
    path: "/delivery-orders-mfg",
    headerKey: "deliveryOrder",
    print: async (header, items) => {
      const { generateDeliveryOrderPdf } = await import("../vendor/scm/lib/delivery-order-pdf");
      await generateDeliveryOrderPdf(header, items);
    },
  },
  "sales-invoices": {
    path: "/sales-invoices",
    headerKey: "salesInvoice",
    print: async (header, items) => {
      const { generateSalesInvoicePdf } = await import("../vendor/scm/lib/sales-invoice-pdf");
      await generateSalesInvoicePdf(header, items);
    },
  },
  "mfg-purchase-orders": {
    path: "/mfg-purchase-orders",
    headerKey: "purchaseOrder",
    print: async (header, items) => {
      // Desktop PurchaseOrderDetail.handlePrint pre-resolves the bound
      // warehouse's name + location text (the PDF can't hit the API), so the
      // supplier sees a real deliver-to. Mirror that here via the same
      // /inventory/warehouses list, degrading to nulls when unresolved.
      let purchaseLocationName: string | null = null;
      let deliveryAddress: string | null = null;
      try {
        const whId = header.purchase_location_id ?? header.purchaseLocationId ?? null;
        if (whId) {
          const { warehouses } = await authedFetch<{ warehouses: any[] }>(`/inventory/warehouses`);
          const wh = (warehouses ?? []).find((w) => w.id === whId);
          if (wh) {
            purchaseLocationName = `${wh.code} · ${wh.name}`;
            deliveryAddress = wh.location ?? null;
          }
        }
      } catch { /* deliver-to is optional — never block the print on it */ }
      const headerForPdf = {
        ...header,
        purchase_location_name: purchaseLocationName,
        delivery_address: deliveryAddress,
        your_ref_no: header.your_ref_no ?? null,
        source_so_doc_no: header.source_so_doc_no ?? null,
      };
      const { generatePurchaseOrderPdf } = await import("../vendor/scm/lib/purchase-order-pdf");
      await generatePurchaseOrderPdf(headerForPdf, items);
    },
  },
  grns: {
    path: "/grns",
    headerKey: "grn",
    print: async (header, items) => {
      const { generateGrnPdf } = await import("../vendor/scm/lib/grn-pdf");
      await generateGrnPdf(header, items);
    },
  },
  "purchase-invoices": {
    path: "/purchase-invoices",
    headerKey: "purchaseInvoice",
    print: async (header, items) => {
      const { generatePurchaseInvoicePdf } = await import("../vendor/scm/lib/purchase-invoice-pdf");
      await generatePurchaseInvoicePdf(header, items);
    },
  },
  "purchase-returns": {
    path: "/purchase-returns",
    headerKey: "purchaseReturn",
    print: async (header, items) => {
      const { generatePurchaseReturnPdf } = await import("../vendor/scm/lib/purchase-return-pdf");
      await generatePurchaseReturnPdf(header, items);
    },
  },
  "delivery-returns": {
    path: "/delivery-returns",
    headerKey: "deliveryReturn",
    print: async (header, items) => {
      // DeliveryReturnDetail.handlePrint remaps the header/items into the
      // generator's own vocabulary (refund_centi ← local_total_centi, etc.).
      const { generateDeliveryReturnPdf } = await import("../vendor/scm/lib/delivery-return-pdf");
      await generateDeliveryReturnPdf(
        {
          return_number: header.return_number,
          status: header.status,
          return_date: header.return_date,
          debtor_code: header.debtor_code,
          debtor_name: header.debtor_name,
          reason: header.reason,
          refund_centi: header.local_total_centi,
          notes: header.notes,
          delivery_order_id: header.delivery_order_id,
          sales_invoice_id: null,
        } as never,
        (items ?? []).map((it: any) => ({
          item_code: it.item_code,
          description: it.description,
          qty_returned: it.qty_returned,
          condition: it.condition,
          unit_price_centi: it.unit_price_centi,
          refund_centi: it.line_total_centi,
        })) as never,
      );
    },
  },
};

/** Fetch the full bundle then print — shared by the document + simple details.
 *  Surfaces failures through useNotify, mirroring the desktop pages' catch. */
async function runPrint(moduleKey: string, id: string): Promise<void> {
  const cfg = PRINT_MODULES[moduleKey];
  if (!cfg) return;
  const bundle = await authedFetch<Record<string, unknown>>(`${cfg.path}/${encodeURIComponent(id)}`);
  const header = (bundle[cfg.headerKey] as any) ?? {};
  const items = (bundle.items as any[]) ?? [];
  await cfg.print(header, items);
}

// ---------------------------------------------------------------------------
// HEADER EDIT / SAVE — the SIMPLE header fields each desktop page PATCHes to
// {path}/:id. camelCase body keys (backend maps → snake_case columns). Only the
// text / date fields that don't need a picker component are surfaced on mobile;
// customer / supplier / warehouse / line editing stays desktop-only. Each doc's
// `locked()` mirrors its desktop page's isLocked so a posted / cancelled /
// child-bearing document shows no Edit affordance.
// ---------------------------------------------------------------------------

type EditFieldType = "text" | "date" | "textarea";
type EditField = {
  /** camelCase body key sent to the PATCH endpoint. */
  key: string;
  label: string;
  type: EditFieldType;
  /** Read the current value off the raw (snake_case) header for the form seed. */
  get: (h: any) => string;
};
type EditMap = {
  /** PATCH path (relative to /api/scm) — body is the changed camelCase fields. */
  path: string;
  method: "PATCH";
  fields: EditField[];
  /** true → the header is read-only (mirror desktop isLocked). */
  locked: (h: any) => boolean;
  /** Shown in the Edit sheet when locked instead of the form. */
  lockedNote: string;
};

const dateVal = (v: unknown): string => (v == null ? "" : String(v).slice(0, 10));
const textVal = (v: unknown): string => (v == null ? "" : String(v));
const truthy = (v: unknown): boolean => Boolean(v) && v !== 0 && v !== "0" && v !== "false";

const EDIT_MODULES: Record<string, EditMap> = {
  // DO — locked once INVOICED / CANCELLED or a DR/SI child exists
  // (DeliveryOrderDetail lockedStatuses + has_children).
  "delivery-orders-mfg": {
    path: "/delivery-orders-mfg",
    method: "PATCH",
    locked: (h) => ["INVOICED", "CANCELLED"].includes(s(h?.status).toUpperCase()) || truthy(h?.has_children),
    lockedNote: "Locked — this delivery order is invoiced, cancelled, or has downstream documents.",
    fields: [
      { key: "doDate", label: "DO Date", type: "date", get: (h) => dateVal(h.do_date) },
      { key: "customerDeliveryDate", label: "Delivery Date", type: "date", get: (h) => dateVal(h.customer_delivery_date) },
      { key: "ref", label: "Reference", type: "text", get: (h) => textVal(h.ref) },
      { key: "poDocNo", label: "Customer PO No", type: "text", get: (h) => textVal(h.po_doc_no) },
      { key: "notes", label: "Notes", type: "textarea", get: (h) => textVal(h.notes ?? h.note) },
    ],
  },

  // Sales Invoice — locked only when CANCELLED (SalesInvoiceDetail lockedStatuses).
  "sales-invoices": {
    path: "/sales-invoices",
    method: "PATCH",
    locked: (h) => s(h?.status).toUpperCase() === "CANCELLED",
    lockedNote: "Locked — this invoice is cancelled.",
    fields: [
      { key: "invoiceDate", label: "Invoice Date", type: "date", get: (h) => dateVal(h.invoice_date) },
      { key: "dueDate", label: "Due Date", type: "date", get: (h) => dateVal(h.due_date) },
      { key: "ref", label: "Reference", type: "text", get: (h) => textVal(h.ref) },
      { key: "notes", label: "Notes", type: "textarea", get: (h) => textVal(h.notes ?? h.note) },
    ],
  },

  // GRN — editable only while DRAFT, or POSTED without children
  // (GoodsReceivedDetail: isLocked = !(DRAFT || (POSTED && !hasChildren))).
  grns: {
    path: "/grns",
    method: "PATCH",
    locked: (h) => {
      const st = s(h?.status).toUpperCase();
      return !(st === "DRAFT" || (st === "POSTED" && !truthy(h?.has_children)));
    },
    lockedNote: "Locked — this goods receipt is cancelled, closed, or already invoiced/returned.",
    fields: [
      { key: "receivedAt", label: "Received Date", type: "date", get: (h) => dateVal(h.received_at) },
      { key: "deliveryNoteRef", label: "Delivery Note Ref", type: "text", get: (h) => textVal(h.delivery_note_ref) },
      { key: "notes", label: "Notes", type: "textarea", get: (h) => textVal(h.notes) },
    ],
  },

  // Purchase Order — editable in DRAFT / SUBMITTED / PARTIALLY_RECEIVED without
  // children (PurchaseOrderDetail isEditableStatus && !hasChildren).
  "mfg-purchase-orders": {
    path: "/mfg-purchase-orders",
    method: "PATCH",
    locked: (h) => {
      const st = s(h?.status).toUpperCase();
      const editable = st === "DRAFT" || st === "SUBMITTED" || st === "PARTIALLY_RECEIVED";
      return !editable || truthy(h?.has_children);
    },
    lockedNote: "Locked — this purchase order is received, cancelled, or has goods receipts.",
    fields: [
      { key: "poDate", label: "PO Date", type: "date", get: (h) => dateVal(h.po_date) },
      { key: "expectedAt", label: "Expected Date", type: "date", get: (h) => dateVal(h.expected_at) },
      { key: "notes", label: "Notes", type: "textarea", get: (h) => textVal(h.notes) },
    ],
  },

  // Purchase Invoice — locked when CANCELLED or any payment recorded
  // (PurchaseInvoiceDetail: isLocked = CANCELLED || paid_centi > 0).
  "purchase-invoices": {
    path: "/purchase-invoices",
    method: "PATCH",
    locked: (h) => s(h?.status).toUpperCase() === "CANCELLED" || Number(h?.paid_centi ?? 0) > 0,
    lockedNote: "Locked — this purchase invoice is cancelled or already has a payment.",
    fields: [
      { key: "supplierInvoiceRef", label: "Supplier Invoice Ref", type: "text", get: (h) => textVal(h.supplier_invoice_ref) },
      { key: "invoiceDate", label: "Invoice Date", type: "date", get: (h) => dateVal(h.invoice_date) },
      { key: "dueDate", label: "Due Date", type: "date", get: (h) => dateVal(h.due_date) },
      { key: "notes", label: "Notes", type: "textarea", get: (h) => textVal(h.notes) },
    ],
  },

  // Purchase Return — editable only while POSTED (PurchaseReturnDetail:
  // isLocked = status !== 'POSTED').
  "purchase-returns": {
    path: "/purchase-returns",
    method: "PATCH",
    locked: (h) => s(h?.status).toUpperCase() !== "POSTED",
    lockedNote: "Locked — only a posted purchase return can be edited.",
    fields: [
      { key: "returnDate", label: "Return Date", type: "date", get: (h) => dateVal(h.return_date) },
      { key: "reason", label: "Reason", type: "text", get: (h) => textVal(h.reason) },
      { key: "creditNoteRef", label: "Credit Note Ref", type: "text", get: (h) => textVal(h.credit_note_ref) },
      { key: "notes", label: "Notes", type: "textarea", get: (h) => textVal(h.notes) },
    ],
  },

  // Delivery Return (Sales Return) — locked when REFUNDED / CREDIT_NOTED /
  // CANCELLED (DeliveryReturnDetail lockedStatuses).
  "delivery-returns": {
    path: "/delivery-returns",
    method: "PATCH",
    locked: (h) => ["REFUNDED", "CREDIT_NOTED", "CANCELLED"].includes(s(h?.status).toUpperCase()),
    lockedNote: "Locked — this return is refunded, credit-noted, or cancelled.",
    fields: [
      { key: "returnDate", label: "Return Date", type: "date", get: (h) => dateVal(h.return_date) },
      { key: "reason", label: "Reason", type: "text", get: (h) => textVal(h.reason) },
      { key: "ref", label: "Reference", type: "text", get: (h) => textVal(h.ref) },
      { key: "notes", label: "Notes", type: "textarea", get: (h) => textVal(h.notes ?? h.note) },
    ],
  },
};

// ---------------------------------------------------------------------------
// Per-document ACTIONS — status transitions + Record Payment, rendered as a
// sticky footer over the detail. Every action's transition set is read from the
// backend route's state machine (backend/src/scm/routes/*.ts): only transitions
// VALID from the doc's CURRENT status are offered, so no button ever 409s.
// Destructive actions (Cancel / Void) go through the in-app confirm (danger).
// ---------------------------------------------------------------------------

type ActVariant = "solid" | "outline" | "danger";

/** One footer action button descriptor. */
type DocAction = {
  key: string;
  label: string;
  variant: ActVariant;
  /** POST/PATCH/DELETE request, relative to /api/scm. */
  request: { path: string; method: "PATCH" | "POST" | "DELETE"; body?: unknown };
  /** In-app danger confirm before firing (Cancel / Void / Delete). */
  confirm?: { title: string; body?: string; confirmLabel: string };
  /** When true, the record no longer exists after this action → navigate back
   *  to the list instead of staying on a now-deleted detail. */
  removes?: boolean;
};

/** true when total − paid still leaves a balance (Record Payment worth offering). */
function hasBalance(h: any): boolean {
  const total = Number(h?.total_centi ?? h?.local_total_centi ?? 0);
  const paid = Number(h?.paid_centi ?? 0);
  const t = Number.isFinite(total) ? total : 0;
  const p = Number.isFinite(paid) ? paid : 0;
  return t > 0 && t - p > 0;
}

/** Whether a module's Record Payment sheet should be offered for `status`, and
 *  which payment endpoint + payload shape it uses. Returns null when payments
 *  don't apply (module has no payment route, or status/balance forbids it). */
type PayKind = "si" | "pi";
function paymentKind(moduleKey: string, header: any): PayKind | null {
  const st = s(header?.status).toUpperCase();
  if (st === "CANCELLED" || st === "DRAFT") return null;
  if (!hasBalance(header)) return null;
  if (moduleKey === "sales-invoices") return "si";
  if (moduleKey === "purchase-invoices") return "pi";
  return null;
}

/** Build the valid status actions for a doc from its CURRENT status. Empty when
 *  the doc is terminal (or the module has no status route). */
function statusActionsFor(moduleKey: string, id: string, header: any): DocAction[] {
  const st = s(header?.status).toUpperCase();
  const enc = encodeURIComponent(id);
  const out: DocAction[] = [];
  const cancel = (path: string, docLabel: string): DocAction => ({
    key: "cancel", label: "Cancel", variant: "danger",
    request: { path, method: "PATCH", body: { status: "CANCELLED" } },
    confirm: { title: `Cancel this ${docLabel}?`, body: "This voids the document and cannot be undone via the app.", confirmLabel: "Cancel Document" },
  });

  switch (moduleKey) {
    // DO — PATCH /:id/status. A fresh DO is DRAFT (confirm = DRAFT→DISPATCHED) or
    // DISPATCHED; then DISPATCHED→IN_TRANSIT→SIGNED(→DELIVERED via POD). CANCELLED
    // is final. Offer the NEXT step + Cancel. DELIVERED is the POD screen's job,
    // so it is never offered here.
    case "delivery-orders-mfg": {
      if (st === "CANCELLED" || st === "DELIVERED" || st === "INVOICED") return out;
      const path = `/delivery-orders-mfg/${enc}/status`;
      const next: Record<string, [string, string]> = {
        "": ["DISPATCHED", "Dispatch"],
        DRAFT: ["DISPATCHED", "Confirm"],
        LOADED: ["DISPATCHED", "Dispatch"],
        DISPATCHED: ["IN_TRANSIT", "Mark In Transit"],
        IN_TRANSIT: ["SIGNED", "Mark Signed"],
      };
      const step = next[st];
      if (step) out.push({ key: "next", label: step[1], variant: "solid", request: { path, method: "PATCH", body: { status: step[0] } } });
      out.push({ ...cancel(path, "delivery order"), confirm: { title: "Cancel this delivery order?", body: "This voids the DO and returns any shipped stock to the shelf.", confirmLabel: "Cancel DO" } });
      return out;
    }

    // Sales Invoice — PATCH /:id/status. DRAFT→SENT (Confirm) or Cancel; active
    // (SENT/PARTIALLY_PAID/PAID/OVERDUE)→Cancel; CANCELLED→Reopen (to SENT).
    case "sales-invoices": {
      const path = `/sales-invoices/${enc}/status`;
      if (st === "DRAFT") {
        out.push({ key: "confirm", label: "Confirm Invoice", variant: "solid", request: { path, method: "PATCH", body: { status: "SENT" } } });
        out.push(cancel(path, "invoice"));
        return out;
      }
      if (st === "CANCELLED") {
        out.push({ key: "reopen", label: "Reopen", variant: "outline", request: { path, method: "PATCH", body: { status: "SENT" } } });
        return out;
      }
      out.push(cancel(path, "invoice"));
      return out;
    }

    // Purchase Order — /confirm (DRAFT→SUBMITTED), /cancel, /reopen. RECEIVED is
    // terminal. Receiving into a GRN is a separate flow — not offered here.
    case "mfg-purchase-orders": {
      if (st === "RECEIVED") return out;
      if (st === "DRAFT") {
        out.push({ key: "submit", label: "Submit", variant: "solid", request: { path: `/mfg-purchase-orders/${enc}/confirm`, method: "PATCH" } });
        out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/mfg-purchase-orders/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase order?", body: "This voids the PO and releases its SO lines back to the picker.", confirmLabel: "Cancel PO" } });
        return out;
      }
      if (st === "CANCELLED") {
        out.push({ key: "reopen", label: "Reopen", variant: "outline", request: { path: `/mfg-purchase-orders/${enc}/reopen`, method: "PATCH" } });
        // Desktop parity — a CANCELLED PO offers a hard Delete (DELETE /:id,
        // CANCELLED-only on the backend). Removes the record → navigate back.
        out.push({ key: "delete", label: "Delete", variant: "danger", removes: true, request: { path: `/mfg-purchase-orders/${enc}`, method: "DELETE" }, confirm: { title: "Delete this purchase order?", body: "This permanently removes the cancelled PO. This cannot be undone.", confirmLabel: "Delete PO" } });
        return out;
      }
      // SUBMITTED / PARTIALLY_RECEIVED
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/mfg-purchase-orders/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase order?", body: "This voids the PO and releases its SO lines back to the picker.", confirmLabel: "Cancel PO" } });
      return out;
    }

    // GRN — /post (DRAFT→POSTED), /cancel. CANCELLED / CLOSED are terminal.
    case "grns": {
      if (st === "CANCELLED" || st === "CLOSED") return out;
      if (st === "DRAFT") {
        out.push({ key: "post", label: "Post", variant: "solid", request: { path: `/grns/${enc}/post`, method: "PATCH" } });
      }
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/grns/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this goods receipt?", body: "This voids the GRN and reverses any posted stock.", confirmLabel: "Cancel GRN" } });
      return out;
    }

    // Sales Return (delivery-returns) — PATCH /:id/status. RECEIVED→INSPECTED→
    // REFUNDED; CANCELLED is final. Offer the next hand-walk step + Cancel.
    case "delivery-returns": {
      if (st === "CANCELLED" || st === "REFUNDED") return out;
      const path = `/delivery-returns/${enc}/status`;
      const next: Record<string, [string, string]> = {
        RECEIVED: ["INSPECTED", "Mark Inspected"],
        INSPECTED: ["REFUNDED", "Mark Refunded"],
      };
      const step = next[st];
      if (step) out.push({ key: "next", label: step[1], variant: "solid", request: { path, method: "PATCH", body: { status: step[0] } } });
      out.push({ ...cancel(path, "return"), confirm: { title: "Cancel this sales return?", body: "This voids the return and re-drains its restocked goods.", confirmLabel: "Cancel Return" } });
      return out;
    }

    // Purchase Return — /complete (POSTED→COMPLETED), /cancel. COMPLETED /
    // CANCELLED are terminal. (POST /:id/post only echoes — not a real action.)
    case "purchase-returns": {
      if (st === "COMPLETED" || st === "CANCELLED") return out;
      if (st === "POSTED") {
        out.push({ key: "complete", label: "Mark Completed", variant: "solid", request: { path: `/purchase-returns/${enc}/complete`, method: "PATCH" } });
      }
      out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/purchase-returns/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase return?", body: "This voids the return and reverses its stock movement.", confirmLabel: "Cancel Return" } });
      return out;
    }

    // Purchase Invoice — /post (DRAFT→POSTED), /cancel (blocked once paid).
    // Payment is a separate action (see paymentKind → PI sheet).
    case "purchase-invoices": {
      if (st === "CANCELLED" || st === "PAID") return out;
      if (st === "DRAFT") {
        out.push({ key: "post", label: "Post", variant: "solid", request: { path: `/purchase-invoices/${enc}/post`, method: "PATCH" } });
        out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/purchase-invoices/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase invoice?", body: "This voids the PI and reverses its accounting.", confirmLabel: "Cancel PI" } });
        return out;
      }
      // POSTED / PARTIALLY_PAID — cancel allowed only while unpaid; the backend
      // rejects a cancel once paid_centi > 0, so hide Cancel then.
      const paid = Number(header?.paid_centi ?? 0);
      if (!(Number.isFinite(paid) && paid > 0)) {
        out.push({ key: "cancel", label: "Cancel", variant: "danger", request: { path: `/purchase-invoices/${enc}/cancel`, method: "PATCH" }, confirm: { title: "Cancel this purchase invoice?", body: "This voids the PI and reverses its accounting.", confirmLabel: "Cancel PI" } });
      }
      return out;
    }

    default:
      return out;
  }
}

/** Payment-method options per module's payment route enum. */
const SI_METHODS: Array<{ value: string; label: string }> = [
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Bank Transfer" },
  { value: "merchant", label: "Card / Merchant" },
  { value: "installment", label: "Installment" },
];

// Footer action buttons ride the design's `.btn` (teal solid) and re-skin per
// variant, mirroring the SO-detail actbar (Edit / Cancel = white outline).
function actSkin(variant: ActVariant, disabled: boolean): React.CSSProperties {
  const skin: React.CSSProperties =
    variant === "solid" ? { background: "#16695f", color: "#fff", border: "none" }
    : variant === "danger" ? { background: "#fff", color: "#b23a3a", border: "1.5px solid #f0d4d4" }
    : { background: "#fff", color: "#16695f", border: "1.5px solid #16695f" };
  return { flex: 1, padding: 12, borderRadius: 11, fontSize: 13.5, ...skin, opacity: disabled ? 0.55 : 1 };
}

/** Record-Payment bottom sheet. `kind` picks the endpoint + payload:
 *  si → POST /sales-invoices/:id/payments { paidAt, method, amountCenti, ... }
 *  pi → PATCH /purchase-invoices/:id/payment { amountCenti, notes }. */
function PaymentSheet({ kind, id, header, onClose, onDone }: {
  kind: PayKind; id: string; header: any; onClose: () => void; onDone: () => void;
}) {
  const notify = useNotify();
  const total = Number(header?.total_centi ?? header?.local_total_centi ?? 0);
  const paid = Number(header?.paid_centi ?? 0);
  const balance = Math.max(0, (Number.isFinite(total) ? total : 0) - (Number.isFinite(paid) ? paid : 0));

  const [amount, setAmount] = useState(() => (balance > 0 ? (balance / 100).toFixed(2) : ""));
  const [method, setMethod] = useState("cash");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const amountCenti = Math.round(Number(amount) * 100);
      if (!Number.isFinite(amountCenti) || amountCenti <= 0) throw new Error("Enter a valid amount greater than zero.");
      if (kind === "si") {
        const body: Record<string, unknown> = { paidAt: date, method, amountCenti };
        if (ref.trim()) body.approvalCode = ref.trim();
        await authedFetch(`/sales-invoices/${encodeURIComponent(id)}/payments`, { method: "POST", body: JSON.stringify(body) });
      } else {
        const body: Record<string, unknown> = { amountCenti };
        if (ref.trim()) body.notes = ref.trim();
        await authedFetch(`/purchase-invoices/${encodeURIComponent(id)}/payment`, { method: "PATCH", body: JSON.stringify(body) });
      }
    },
    onSuccess: () => { onDone(); onClose(); void notify({ title: "Payment recorded" }); },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't record the payment. Please try again."),
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", height: 42, padding: "0 12px", borderRadius: 10,
    border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 14, color: "var(--ink)",
  };
  const labelStyle: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "#9aa093", marginBottom: 5, display: "block" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2500, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="hz-m" style={{ width: "100%", background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(env(safe-area-inset-bottom) + 16px)", boxShadow: "0 -8px 28px rgba(0,0,0,0.16)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>Record Payment</div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 15, fontWeight: 700, color: "var(--teal)", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          <Stat label="Total" value={money(total)} color="var(--ink)" />
          <Stat label="Paid" value={money(paid)} color="#2f8a5b" />
          <Stat label="Balance" value={money(balance)} color={balance > 0 ? "#a16a2e" : "var(--ink)"} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Amount (RM)</label>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
        </div>

        {kind === "si" && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none" }}>
              {SI_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
        )}

        {kind === "si" && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>{kind === "si" ? "Reference" : "Note"}</label>
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={kind === "si" ? "Approval / reference" : "Optional note"} style={inputStyle} />
        </div>

        {error && <div style={{ fontSize: 11.5, color: "#b23a3a", marginBottom: 12, textAlign: "center" }}>{error}</div>}

        <button
          className="btn"
          disabled={mutation.isPending}
          onClick={() => { setError(null); mutation.mutate(); }}
          style={{ opacity: mutation.isPending ? 0.6 : 1 }}
        >
          {mutation.isPending ? "Recording…" : "Record Payment"}
        </button>
      </div>
    </div>
  );
}

/** Sticky action footer for a document detail: status transition buttons +
 *  (for SI/PI) a Record Payment action opening the PaymentSheet. Invalidates
 *  the detail + list queries on success; surfaces errors inline. Renders
 *  nothing when there is no valid action from the current status. */
function DocActionFooter({ moduleKey, id, header, invalidate, onPOD, onDeleted }: {
  moduleKey: string; id: string; header: any; invalidate: () => void; onPOD?: () => void;
  /** Called after a `removes` action (e.g. Delete PO) succeeds — navigate back
   *  to the list since the detail's record no longer exists. */
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);

  const statusActions = useMemo(() => statusActionsFor(moduleKey, id, header), [moduleKey, id, header]);
  const payKind = paymentKind(moduleKey, header);

  const refresh = () => {
    invalidate();
    void qc.invalidateQueries({ queryKey: ["mobile-module"] });
  };

  const mutation = useMutation({
    mutationFn: (action: DocAction) =>
      authedFetch(action.request.path, {
        method: action.request.method,
        ...(action.request.body !== undefined ? { body: JSON.stringify(action.request.body) } : {}),
      }),
    onSuccess: (_data, action) => {
      // A `removes` action (Delete) drops the record → refresh the list and pop
      // back to it; every other action stays on the (now-updated) detail.
      if (action.removes) {
        void qc.invalidateQueries({ queryKey: ["mobile-module"] });
        void notify({ title: "Deleted" });
        onDeleted?.();
        return;
      }
      refresh();
      void notify({ title: "Done" });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Something went wrong. Please try again."),
  });

  const run = async (action: DocAction) => {
    if (mutation.isPending) return;
    setError(null);
    if (action.confirm && !(await confirm({ title: action.confirm.title, body: action.confirm.body, confirmLabel: action.confirm.confirmLabel, danger: true }))) return;
    mutation.mutate(action);
  };

  const hasRow = statusActions.length > 0 || !!payKind;
  if (!hasRow && !onPOD) return null;
  const busy = mutation.isPending;

  return (
    <>
      {error && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: hasRow && onPOD ? 130 : 76, padding: "0 16px", textAlign: "center", fontSize: 11.5, color: "#b23a3a" }}>{error}</div>
      )}
      <footer className="actbar" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
        {onPOD && (
          <button className="btn" onClick={onPOD} style={{ marginBottom: hasRow ? 9 : 0 }}>Proof of Delivery</button>
        )}
        {hasRow && (
          <div style={{ display: "flex", gap: 9 }}>
            {payKind && (
              <button className="btn" disabled={busy} onClick={() => { setError(null); setPayOpen(true); }} style={actSkin("solid", busy)}>Record Payment</button>
            )}
            {statusActions.map((a) => (
              <button className="btn" key={a.key} disabled={busy} onClick={() => run(a)} style={actSkin(a.variant, busy)}>{busy ? "Working…" : a.label}</button>
            ))}
          </div>
        )}
      </footer>
      {payOpen && payKind && (
        <PaymentSheet kind={payKind} id={id} header={header} onClose={() => setPayOpen(false)} onDone={refresh} />
      )}
    </>
  );
}

function DocumentDetail({ map, row, moduleKey, onBack, onEdit, onPOD }: { map: DocMap; row: any; moduleKey: string; onBack: () => void; onEdit?: () => void; onPOD?: () => void }) {
  const id = docId(row);
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-module-detail", map.path, id],
    queryFn: () => authedFetch<Record<string, unknown>>(`${map.path}/${encodeURIComponent(id)}`),
    enabled: !!id,
    staleTime: 15_000,
  });

  // While loading / on error, keep the header populated from the list `row` so
  // the screen never flashes empty.
  const header = (data?.[map.headerKey] as any) ?? row ?? {};
  const items = (data?.items as any[]) ?? [];
  const meta = map.meta(header).filter(([, v]) => v && v !== "—");
  const stats = map.stats(header);

  // Field-ops: Print (all doc types) + header Edit (once the full header has
  // loaded, and only when the doc isn't locked). Edit reads the fetched header
  // so its lock gate + field seeds are accurate; hidden until `data` arrives.
  const editCfg = EDIT_MODULES[moduleKey];
  const canFieldEdit = !!id && !!data && !!editCfg && !editCfg.locked(header);
  const invalidateDetail = () => {
    void qc.invalidateQueries({ queryKey: ["mobile-module-detail", map.path, id] });
    void qc.invalidateQueries({ queryKey: ["mobile-module"] });
  };

  // Whether a sticky footer will render — used to reserve scroll padding so it
  // never covers the last line item. A POD button (delivery orders) also counts.
  const hasStatusActions = !!id && (statusActionsFor(moduleKey, id, header).length > 0 || paymentKind(moduleKey, header) !== null);
  const hasFooter = hasStatusActions || !!onPOD;
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["mobile-module-detail", map.path, id] }); };

  return (
    <div className="hz-m" style={{ ...wrapStyle, position: "relative" }}>
      <DetailHeader
        eyebrow={map.eyebrow(header)}
        title={map.title(header)}
        subtitle={map.subtitle?.(header)}
        status={map.status(header)}
        onBack={onBack}
        onEdit={onEdit}
        print={PRINT_MODULES[moduleKey] && id ? { moduleKey, id } : undefined}
        onFieldEdit={canFieldEdit ? () => setEditOpen(true) : undefined}
      />
      <div className="scroll hz-scroll" style={hasFooter ? { ...scrollStyle, paddingBottom: onPOD && hasStatusActions ? 150 : 96 } : scrollStyle}>
        {!id && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't identify this record.</div>}

        {!!id && (
          <>
            {meta.length > 0 && (
              <div className="pgrid2" style={{ marginBottom: 13 }}>
                {meta.map(([label, value]) => (
                  <Kv key={label} label={label} value={value} mono={/date|phone|reference|currency|received|expected|submitted|due/i.test(label)} />
                ))}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 13 }}>
              {stats.map((st, i) => (st ? <Stat key={st[0]} label={st[0]} value={st[1]} color={st[2]} /> : <div key={i} />))}
            </div>

            <Eyebrow>Line items</Eyebrow>
            <div style={cardStyle}>
              {isLoading && <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>Loading{"…"}</div>}
              {!!error && !isLoading && <div style={{ fontSize: 11.5, color: "#b23a3a", padding: "9px 0" }}>Couldn't load line items. Please try again.</div>}
              {!isLoading && !error && (items.length ? items.map((it, i) => {
                const l = map.line(it);
                return <LineItem key={s(it?.id) || i} name={l.name} sub={l.sub} qty={l.qty} unitCenti={l.unitCenti} amountCenti={l.amountCenti} />;
              }) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No line items.</div>)}
            </div>
          </>
        )}
      </div>
      {hasFooter && <DocActionFooter moduleKey={moduleKey} id={id} header={header} invalidate={invalidate} onPOD={onPOD} onDeleted={onBack} />}
      {editOpen && (
        <HeaderEditSheet moduleKey={moduleKey} id={id} header={header} onClose={() => setEditOpen(false)} onSaved={invalidateDetail} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple detail — a tidy key/value dump of the row already provided. No fetch.
// ---------------------------------------------------------------------------

/** Humanize a snake_case / camelCase key into a Title-Case label. */
function humanize(key: string): string {
  return key
    .replace(/_centi$|_sen$/i, "")
    .replace(/_id$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Keys we never surface in a simple dump (internal / noisy). Raw foreign-key
 *  ids (*_id) and color hex are hidden — the joined *_name carries the meaning. */
const HIDDEN_KEYS = /^(id|created_by|updated_by|.*_by|.*_id|.*_color|color|.*_json|variants|custom_specials|password|token)$/i;

type Field = { label: string; value: string; mono: boolean; wide: boolean };

function rowToFields(row: any): Field[] {
  if (!row || typeof row !== "object") return [];
  const out: Field[] = [];
  for (const [key, raw] of Object.entries(row)) {
    if (HIDDEN_KEYS.test(key)) continue;
    if (raw == null || raw === "") continue;
    if (typeof raw === "object") continue; // skip nested objects / arrays
    let value: string;
    let mono = false;
    let wide = false;
    if (/_centi$|_sen$/i.test(key)) {
      value = money(raw);
      mono = true;
    } else if (/_date$|_at$|^date$/i.test(key)) {
      const d = dmy(raw);
      if (d === "—") continue;
      value = d;
      mono = true;
    } else if (typeof raw === "boolean") {
      value = raw ? "Yes" : "No";
    } else {
      value = s(raw);
      if (!value.trim()) continue;
      if (/phone|whatsapp|mobile|email|fax|code|number|no$/i.test(key)) mono = true;
      if (/address|note|remark|website|nature|description/i.test(key) || value.length > 28) wide = true;
    }
    out.push({ label: humanize(key), value, mono, wide });
  }
  return out;
}

const SIMPLE_META: Record<string, { eyebrow: (r: any) => string; title: (r: any) => string; status: (r: any) => unknown }> = {
  suppliers: {
    eyebrow: (r) => firstOf(r.code),
    title: (r) => firstOf(r.name),
    status: (r) => r.status,
  },
  warehouse: {
    eyebrow: (r) => firstOf(r.code),
    title: (r) => firstOf(r.name),
    status: () => "",
  },
  inventory: {
    eyebrow: (r) => firstOf(r.product_code),
    title: (r) => firstOf(r.product_name, r.product_code),
    status: () => "",
  },
  drivers: {
    eyebrow: (r) => firstOf(r.driver_code),
    title: (r) => firstOf(r.name),
    status: (r) => (r.in_house ? "In-house" : "Outsource"),
  },
  helpers: {
    eyebrow: (r) => firstOf(r.helper_code),
    title: (r) => firstOf(r.name),
    status: (r) => (r.in_house ? "In-house" : "Outsource"),
  },
};

function SimpleDetail({ moduleKey, row, title, onBack, onEdit }: { moduleKey: string; row: any; title: string; onBack: () => void; onEdit?: () => void }) {
  // Suppliers carries a richer GET /suppliers/:id ({ supplier, bindings }).
  // Merge that over the list row when available; every other simple module just
  // dumps the row it was handed.
  const wantSupplier = moduleKey === "suppliers";
  const id = s(row?.id);
  const supplierQ = useQuery({
    queryKey: ["mobile-supplier-detail", id],
    queryFn: () => authedFetch<{ supplier: any; bindings: any[] }>(`/suppliers/${encodeURIComponent(id)}`),
    enabled: wantSupplier && !!id,
    staleTime: 30_000,
  });

  // Field-ops doc types routed through SimpleDetail (PI / PR / DR) get their
  // full header fetched so Print + header Edit see the SAME bundle the desktop
  // detail page uses (the list row lacks paid_centi / notes / dates). The 4
  // richer doc types (DO/SI/GRN/PO) never reach here — they use DocumentDetail.
  const printCfg = PRINT_MODULES[moduleKey];
  const editCfg = EDIT_MODULES[moduleKey];
  const wantDoc = !!printCfg && !!id;
  const docQ = useQuery({
    queryKey: ["mobile-module-detail", printCfg?.path ?? moduleKey, id],
    queryFn: () => authedFetch<Record<string, unknown>>(`${printCfg!.path}/${encodeURIComponent(id)}`),
    enabled: wantDoc,
    staleTime: 15_000,
  });
  const [editOpen, setEditOpen] = useState(false);
  const docHeader = (docQ.data?.[printCfg?.headerKey ?? ""] as any) ?? row ?? {};
  const canFieldEdit = wantDoc && !!docQ.data && !!editCfg && !editCfg.locked(docHeader);

  const effectiveRow = useMemo(() => {
    if (wantSupplier && supplierQ.data?.supplier) return { ...row, ...supplierQ.data.supplier };
    if (wantDoc && docQ.data?.[printCfg!.headerKey]) return { ...row, ...(docQ.data[printCfg!.headerKey] as any) };
    return row ?? {};
  }, [wantSupplier, supplierQ.data, wantDoc, docQ.data, printCfg, row]);

  const bindings = wantSupplier ? (supplierQ.data?.bindings ?? []) : [];

  const meta = SIMPLE_META[moduleKey];
  const config = MODULE_CONFIGS[moduleKey];
  // Design-style detail: when the module config declares `fields`, render those
  // labelled rows (so-k / so-v pairs) exactly like the prototype's openDetail;
  // else fall back to the humanized full-row dump.
  const configFields = useMemo(() => {
    if (!config?.fields?.length) return null;
    return config.fields.map(([accessor, label]) => {
      let value = "—";
      try { value = accessor(effectiveRow) || "—"; } catch { value = "—"; }
      return { label, value };
    });
  }, [config, effectiveRow]);

  const eyebrow = meta ? meta.eyebrow(effectiveRow) : (config?.eyebrow ?? "");
  const heading =
    (meta ? meta.title(effectiveRow) : "") ||
    (config ? safeCall(config.primary, effectiveRow) : "") ||
    title ||
    "—";
  const status = meta
    ? meta.status(effectiveRow)
    : config?.pill
      ? safeCall(config.pill, effectiveRow)
      : "";
  const dumpFields = rowToFields(effectiveRow);

  // Status action bar for the DOC-like simple modules (Sales/Purchase Returns,
  // Purchase Invoices) — driven off the list row's id + status. Other simple
  // modules (suppliers, drivers, …) have no status route → no footer.
  const qc = useQueryClient();
  const actionRow = row ?? {};
  const actionId = s(row?.id);
  const hasFooter = !!actionId && (statusActionsFor(moduleKey, actionId, actionRow).length > 0 || paymentKind(moduleKey, actionRow) !== null);
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["mobile-module"] }); };
  const invalidateDoc = () => {
    if (printCfg) void qc.invalidateQueries({ queryKey: ["mobile-module-detail", printCfg.path, id] });
    void qc.invalidateQueries({ queryKey: ["mobile-module"] });
  };

  return (
    <div className="hz-m" style={{ ...wrapStyle, position: "relative" }}>
      <DetailHeader
        eyebrow={eyebrow === "—" ? "" : eyebrow}
        title={heading}
        status={status}
        onBack={onBack}
        onEdit={onEdit}
        print={wantDoc ? { moduleKey, id } : undefined}
        onFieldEdit={canFieldEdit ? () => setEditOpen(true) : undefined}
      />
      <div className="scroll hz-scroll" style={hasFooter ? { ...scrollStyle, paddingBottom: 96 } : scrollStyle}>
        <Eyebrow>Details</Eyebrow>
        {configFields ? (
          <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 13, overflow: "hidden", marginBottom: 13, padding: "0 12px" }}>
            {configFields.map((f) => (
              <div className="docrow" key={f.label} style={{ justifyContent: "space-between" }}>
                <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{f.label}</span>
                <span className="money" style={{ fontSize: 13.5, fontWeight: 600, color: "#11140f", textAlign: "right", wordBreak: "break-word" }}>{f.value}</span>
              </div>
            ))}
          </div>
        ) : dumpFields.length ? (
          <div className="pgrid2" style={{ marginBottom: 13 }}>
            {dumpFields.map((f) => (
              <div key={f.label} style={f.wide ? { gridColumn: "1 / -1" } : undefined}>
                <Kv label={f.label} value={f.value} mono={f.mono} />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...cardStyle, padding: 13 }}>
            <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No details to show.</div>
          </div>
        )}

        {wantSupplier && (
          <>
            <Eyebrow>Assigned materials</Eyebrow>
            <div style={cardStyle}>
              {supplierQ.isLoading && <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>Loading{"…"}</div>}
              {!supplierQ.isLoading && (bindings.length ? bindings.map((b: any, i: number) => (
                <div className="docrow" key={s(b?.id) || i} style={{ justifyContent: "space-between" }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "#11140f" }}>
                    {firstOf(b.material_name, b.material_code)}
                    {s(b.material_code).trim() ? <span className="money" style={{ color: "#9aa093", fontWeight: 600 }}> {"·"} {s(b.material_code)}</span> : null}
                  </span>
                  {Number.isFinite(Number(b.unit_price_centi)) && Number(b.unit_price_centi) > 0
                    ? <span className="money" style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-2)", flex: "none" }}>{money(b.unit_price_centi)}</span>
                    : null}
                </div>
              )) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No materials assigned.</div>)}
            </div>
          </>
        )}
      </div>
      {hasFooter && <DocActionFooter moduleKey={moduleKey} id={actionId} header={actionRow} invalidate={invalidate} onDeleted={onBack} />}
      {editOpen && (
        <HeaderEditSheet moduleKey={moduleKey} id={id} header={docHeader} onClose={() => setEditOpen(false)} onSaved={invalidateDoc} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public entry — routes by moduleKey to the document or the simple detail.
// ---------------------------------------------------------------------------

export function MobileModuleDetail({ moduleKey, row, title, onBack, onPOD, onEdit }: {
  moduleKey: string; row: any; title: string; onBack: () => void; onPOD?: () => void;
  /** Wired by the parent when the module's form supports edit (updatePath).
   *  The header "Edit" button calls this. MobileApp passes the current row's
   *  id + the module's FormSchema through to MobileModuleForm. */
  onEdit?: () => void;
}) {
  // Only offer Edit for modules whose form declares an updatePath (create-only
  // modules like Warehouse show no Edit button even when onEdit is passed).
  const editable = !!MODULE_CONFIGS[moduleKey]?.form?.updatePath;
  const editHandler = editable ? onEdit : undefined;
  const doc = DOC_MODULES[moduleKey];
  // Document modules host their own sticky footer (status actions + Record
  // Payment, plus the Proof-of-Delivery entry for Delivery Orders). Simple
  // modules (Sales/Purchase Returns, Purchase Invoices) get a status action bar
  // driven off the list row's id + status.
  if (doc) {
    return <DocumentDetail map={doc} row={row} moduleKey={moduleKey} onBack={onBack} onEdit={editHandler} onPOD={onPOD} />;
  }
  return <SimpleDetail moduleKey={moduleKey} row={row} title={title} onBack={onBack} onEdit={editHandler} />;
}
