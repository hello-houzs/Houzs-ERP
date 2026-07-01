import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileConvertWizard — mobile CREATE-by-CONVERT flow for the four downstream
 * documents that the desktop only ever creates by converting a source doc:
 *
 *   target "do"  → New Delivery Order  from a Sales Order   (line + qty picker)
 *   target "si"  → New Sales Invoice   from a Delivery Order (line + qty picker)
 *   target "grn" → New Goods Receipt   from PO(s)            (whole-PO, 1 supplier)
 *   target "po"  → New Purchase Order  from a Sales Order    (line + qty picker)
 *
 * A full-height, .hz-m-scoped flow with three steps:
 *   1. pick a SOURCE document (or, for GRN, one-or-more POs of ONE supplier)
 *   2. pick the convertible LINES + qty (skipped for GRN — it receives all)
 *   3. create — POST the confirmed convert endpoint, then onCreated(newDocNo)
 *
 * Presentation ports the owner's mobile design classes VERBATIM (mobile.css):
 * the header is .hdr + .ey eyebrow; the source picker rows reuse the SO-list
 * idiom (.so-row / .so-row-head / .so-row-name / .so-grid / .so-k / .so-v /
 * .spill); the GRN supplier filters are .sochip; the line/qty step uses .card
 * rows with .fld / .fld-i qty inputs; the GRN review uses the .so-card /
 * .so-hd / .so-ti / .so-bd / .fld form idiom; and the create action is a
 * sticky .actbar / .btn. No redesign — same markup, owner's classes.
 *
 * Convertible lines come from the SAME per-line "remaining" GETs the desktop
 * pickers use (verified against backend/src/scm/routes):
 *   SO→DO / SO→PO : GET /delivery-orders-mfg/deliverable-so-lines?docNos=<docNo>
 *                   → { lines:[{ soItemId, docNo, itemCode, description, qty,
 *                       remaining, unitPriceCenti, debtorName, ... }] }
 *   DO→SI         : GET /sales-invoices/invoiceable-do-lines?doIds=<id>
 *                   → { lines:[{ doItemId, doNumber, itemCode, description,
 *                       remaining, unitPriceCenti, debtorName, ... }] }
 *
 * Create responses (the new doc number we hand to onCreated):
 *   DO  POST /delivery-orders-mfg/from-sos   → { id, doNumber, movementErrors? }
 *   SI  POST /sales-invoices/from-dos        → { id, invoiceNumber, ... }
 *   GRN POST /grns/from-pos                  → { id, grnNumber, poCount, ... }
 *   PO  POST /mfg-purchase-orders/from-sos   → { created:[{ poNumber, ... }], total }
 *
 * Short-stock handling (DO): authedFetch already intercepts the 409 short_stock
 * body, shows the in-app "Ship anyway?" confirm (serviceConfirm), and replays
 * with confirmShortStock:true — so we simply call it and let that run.
 * ------------------------------------------------------------------------- */

export type ConvertTarget = "do" | "si" | "grn" | "po";

type SourceKind = "so" | "do" | "po";

/* Per-target wiring: which source list to pick from, the eyebrow/title copy,
   and whether the flow has a line-level qty picker (GRN receives all). */
const META: Record<
  ConvertTarget,
  { title: string; eyebrow: string; source: SourceKind; sourceNoun: string; hasLinePicker: boolean }
> = {
  do: { title: "New Delivery Order", eyebrow: "Logistics", source: "so", sourceNoun: "Sales Order", hasLinePicker: true },
  si: { title: "New Sales Invoice", eyebrow: "Finance", source: "do", sourceNoun: "Delivery Order", hasLinePicker: true },
  grn: { title: "New Goods Receipt", eyebrow: "Procurement", source: "po", sourceNoun: "Purchase Order", hasLinePicker: false },
  po: { title: "New Purchase Order", eyebrow: "Procurement", source: "so", sourceNoun: "Sales Order", hasLinePicker: true },
};

// ── Money / helpers ────────────────────────────────────────────────────────
const rm = (centi: number | null | undefined) =>
  ((Number(centi) || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dm = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(+dt)) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};
/** First defined-and-non-empty of the candidates (pg driver camelCases result
 *  columns; snake_case is the raw shape — always dual-read). */
const pick = (row: any, ...keys: string[]) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
};
const str = (v: unknown): string => (v == null ? "" : String(v));
/** Clamp a typed qty to 1..max integer (guards NaN / out-of-range). */
const clampQty = (raw: string, max: number): number => {
  const n = Math.floor(Number(String(raw).replace(/[^\d.]/g, "")));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (max > 0 && n > max) return max;
  return n;
};

// ── Source-list row shapes (only the fields we read) ─────────────────────────
type SoListRow = {
  doc_no: string; debtor_name: string | null; status: string | null;
  so_date: string | null; local_total_centi: number | null; total_revenue_centi: number | null;
};
type DoListRow = {
  id: string; do_number: string; debtor_name: string | null; status: string | null;
  do_date: string | null; local_total_centi: number | null;
};
type PoListRow = {
  id: string; po_number: string; status: string | null; po_date: string | null;
  total_centi: number | null; supplier?: { id?: string; code?: string; name?: string } | null;
};

// ── Convertible-line shapes (from the remaining GETs) ────────────────────────
type SoDeliverableLine = {
  soItemId: string; docNo: string; itemCode: string; description: string | null;
  qty: number; remaining: number; unitPriceCenti: number; debtorName: string | null;
};
type DoInvoiceableLine = {
  doItemId: string; doNumber: string; itemCode: string; description: string | null;
  remaining: number; unitPriceCenti: number; debtorName: string | null;
};

// A picker line in the local UI (unified across the two GET shapes).
type PickLine = {
  lineId: string;        // soItemId | doItemId
  label: string;         // item code / description
  remaining: number;
  unitPriceCenti: number;
  checked: boolean;
  qty: string;           // as typed
};

export function MobileConvertWizard({
  target,
  onBack,
  onCreated,
}: {
  target: ConvertTarget;
  onBack: () => void;
  onCreated: (docNo: string) => void;
}) {
  const meta = META[target];
  const qc = useQueryClient();
  const notify = useNotify();

  // step 1 → source picked ; step 2 → lines/qty (or GRN supplier confirm) ; step 3 handled by submit.
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null); // doc_no (SO) or id (DO/PO)
  // GRN: multi-PO of one supplier.
  const [selectedPoIds, setSelectedPoIds] = useState<string[]>([]);
  const [supplierFilter, setSupplierFilter] = useState<string | null>(null); // supplier id, GRN only
  const [lines, setLines] = useState<PickLine[]>([]);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deliveryNoteRef, setDeliveryNoteRef] = useState(""); // GRN optional
  const [notes, setNotes] = useState(""); // GRN optional

  const step: 1 | 2 = meta.source === "po"
    ? (selectedPoIds.length > 0 ? 2 : 1)
    : (selectedSourceId ? 2 : 1);

  // ── Source list query ──────────────────────────────────────────────────────
  const sourceQuery = useQuery<any>({
    queryKey: ["convert-source", meta.source],
    queryFn: () => {
      if (meta.source === "so") return authedFetch<{ salesOrders?: SoListRow[] }>("/mfg-sales-orders?limit=200");
      if (meta.source === "do") return authedFetch<{ deliveryOrders?: DoListRow[] }>("/delivery-orders-mfg?limit=200");
      return authedFetch<{ purchaseOrders?: PoListRow[] }>("/mfg-purchase-orders?limit=200");
    },
    staleTime: 30_000,
  });

  // Only offer processible sources (not DRAFT / CANCELLED). GRN drops fully
  // received / cancelled POs (only open / partially_received can be received).
  const sources = useMemo(() => {
    const data = sourceQuery.data as any;
    const isProcessible = (status: string | null) => {
      const s = str(status).toUpperCase();
      return s !== "DRAFT" && s !== "CANCELLED";
    };
    const isReceivablePo = (status: string | null) => {
      const s = str(status).toUpperCase();
      return s !== "DRAFT" && s !== "CANCELLED" && s !== "RECEIVED" && s !== "CLOSED";
    };
    const needle = q.trim().toLowerCase();
    if (meta.source === "so") {
      return ((data?.salesOrders ?? []) as SoListRow[])
        .filter((r) => isProcessible(r.status))
        .filter((r) => !needle || `${str(r.debtor_name)} ${r.doc_no}`.toLowerCase().includes(needle));
    }
    if (meta.source === "do") {
      return ((data?.deliveryOrders ?? []) as DoListRow[])
        .filter((r) => isProcessible(r.status))
        .filter((r) => !needle || `${str(r.debtor_name)} ${r.do_number}`.toLowerCase().includes(needle));
    }
    // PO (GRN): filter to one supplier at a time so /grns/from-pos never 400s
    // on mixed_suppliers. Once a supplier is chosen, show only that supplier.
    return ((data?.purchaseOrders ?? []) as PoListRow[])
      .filter((r) => isReceivablePo(r.status))
      .filter((r) => !supplierFilter || str(r.supplier?.id) === supplierFilter)
      .filter((r) => !needle || `${str(r.supplier?.name)} ${r.po_number}`.toLowerCase().includes(needle));
  }, [sourceQuery.data, meta.source, q, supplierFilter]);

  // Distinct suppliers for the GRN supplier chips (from receivable POs).
  const suppliers = useMemo(() => {
    if (meta.source !== "po") return [];
    const data = sourceQuery.data as any;
    const seen = new Map<string, string>();
    for (const r of (data?.purchaseOrders ?? []) as PoListRow[]) {
      const s = str(r.status).toUpperCase();
      if (s === "DRAFT" || s === "CANCELLED" || s === "RECEIVED" || s === "CLOSED") continue;
      const id = str(r.supplier?.id);
      if (id) seen.set(id, str(r.supplier?.name) || str(r.supplier?.code) || id);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [sourceQuery.data, meta.source]);

  // ── Convertible-lines query (SO→DO/PO, DO→SI). GRN has no line picker. ──────
  const linesQuery = useQuery({
    enabled: meta.hasLinePicker && !!selectedSourceId,
    queryKey: ["convert-lines", target, selectedSourceId],
    queryFn: async () => {
      if (meta.source === "so") {
        const res = await authedFetch<{ lines?: SoDeliverableLine[] }>(
          `/delivery-orders-mfg/deliverable-so-lines?docNos=${encodeURIComponent(selectedSourceId!)}`,
        );
        return (res.lines ?? []).map<PickLine>((l) => ({
          lineId: l.soItemId,
          label: str(pick(l, "description")) || str(pick(l, "itemCode")) || "—",
          remaining: Number(l.remaining) || 0,
          unitPriceCenti: Number(l.unitPriceCenti) || 0,
          checked: true,
          qty: String(Number(l.remaining) || 0),
        }));
      }
      // DO → SI (source is a DO id).
      const res = await authedFetch<{ lines?: DoInvoiceableLine[] }>(
        `/sales-invoices/invoiceable-do-lines?doIds=${encodeURIComponent(selectedSourceId!)}`,
      );
      return (res.lines ?? []).map<PickLine>((l) => ({
        lineId: l.doItemId,
        label: str(pick(l, "description")) || str(pick(l, "itemCode")) || "—",
        remaining: Number(l.remaining) || 0,
        unitPriceCenti: Number(l.unitPriceCenti) || 0,
        checked: true,
        qty: String(Number(l.remaining) || 0),
      }));
    },
    staleTime: 15_000,
  });

  // Seed local editable lines when the query resolves (default qty = remaining).
  useEffect(() => {
    if (linesQuery.data) setLines(linesQuery.data);
  }, [linesQuery.data]);

  const setLine = (id: string, patch: Partial<PickLine>) =>
    setLines((prev) => prev.map((l) => (l.lineId === id ? { ...l, ...patch } : l)));

  const picks = useMemo(
    () => lines.filter((l) => l.checked && clampQty(l.qty, l.remaining) >= 1),
    [lines],
  );
  const pickedTotalCenti = useMemo(
    () => picks.reduce((a, l) => a + l.unitPriceCenti * clampQty(l.qty, l.remaining), 0),
    [picks],
  );

  // ── Submit (step 3) ─────────────────────────────────────────────────────────
  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      let newDocNo = "";

      if (target === "do") {
        const body = { picks: picks.map((l) => ({ soItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        // authedFetch handles the short_stock 409 in-app (Ship anyway? → replay).
        const res = await authedFetch<{ doNumber?: string }>("/delivery-orders-mfg/from-sos", {
          method: "POST",
          body: JSON.stringify(body),
        });
        newDocNo = str(res?.doNumber);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else if (target === "si") {
        const body = { picks: picks.map((l) => ({ doItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        const res = await authedFetch<{ invoiceNumber?: string }>("/sales-invoices/from-dos", {
          method: "POST",
          body: JSON.stringify(body),
        });
        newDocNo = str(res?.invoiceNumber);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else if (target === "po") {
        const body = { picks: picks.map((l) => ({ soItemId: l.lineId, qty: clampQty(l.qty, l.remaining) })) };
        const res = await authedFetch<{ created?: Array<{ poNumber?: string }> }>("/mfg-purchase-orders/from-sos", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const created = res?.created ?? [];
        newDocNo = created.map((p) => str(p.poNumber)).filter(Boolean).join(", ");
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      } else {
        // GRN — receives all lines of the selected POs (one supplier).
        const body: Record<string, unknown> = { purchaseOrderIds: selectedPoIds };
        if (deliveryNoteRef.trim()) body.deliveryNoteRef = deliveryNoteRef.trim();
        if (notes.trim()) body.notes = notes.trim();
        const res = await authedFetch<{ grnNumber?: string }>("/grns/from-pos", {
          method: "POST",
          body: JSON.stringify(body),
        });
        newDocNo = str(res?.grnNumber);
        await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      }

      onCreated(newDocNo);
    } catch (e) {
      // A declined short-stock / drop-ship confirm surfaces as a thrown marker;
      // treat any non-success as a plain in-app error (never a naked alert).
      const msg = e instanceof Error ? e.message : "Couldn't create the document.";
      if (!/^declined_/.test(msg)) {
        await notify({ title: `Couldn't create ${meta.title.replace(/^New /, "")}`, body: humanize(msg), tone: "error" });
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Can we submit? DO/SI/PO need >=1 pick; GRN needs >=1 selected PO.
  const canCreate = meta.hasLinePicker ? picks.length > 0 : selectedPoIds.length > 0;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span
            onClick={onBack}
            style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}
          >
            <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> Back
          </span>
          <span style={{ fontSize: 11, color: "#767b6e" }}>Step {step} of 2</span>
        </div>
        <div className="ey" style={{ color: "#a16a2e", marginTop: 6 }}>{meta.eyebrow}</div>
        <div style={{ fontSize: 19, fontWeight: 800, color: "#11140f", marginTop: 2 }}>{meta.title}</div>
        <div style={{ fontSize: 11.5, color: "#767b6e", marginTop: 3 }}>
          {step === 1
            ? `Convert from ${meta.source === "po" ? "one or more Purchase Orders" : `a ${meta.sourceNoun}`}`
            : meta.hasLinePicker
              ? "Choose the lines and quantities to convert"
              : "Review — the receipt takes every line of the selected orders"}
        </div>
        {/* Search (source step only) */}
        {step === 1 && (
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, background: "#f4f6f3", border: "1px solid #d6d9d2", borderRadius: 10, padding: "8px 11px" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${meta.sourceNoun.toLowerCase()}`} style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontFamily: "inherit", fontSize: 13, color: "#11140f" }} />
          </div>
        )}
        {/* GRN supplier chips (source step only) */}
        {step === 1 && meta.source === "po" && suppliers.length > 0 && (
          <div style={{ display: "flex", gap: 7, overflowX: "auto", marginTop: 10, paddingBottom: 2 }}>
            <button onClick={() => setSupplierFilter(null)} className={!supplierFilter ? "sochip on" : "sochip"}>All suppliers</button>
            {suppliers.map((s) => (
              <button key={s.id} onClick={() => setSupplierFilter(s.id)} className={supplierFilter === s.id ? "sochip on" : "sochip"}>{s.name}</button>
            ))}
          </div>
        )}
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 130 }}>
        {step === 1 ? (
          <SourceStep
            kind={meta.source}
            loading={sourceQuery.isLoading}
            error={!!sourceQuery.error}
            rows={sources}
            selectedPoIds={selectedPoIds}
            supplierFilter={supplierFilter}
            onPickSingle={(id) => setSelectedSourceId(id)}
            onTogglePo={(row) => {
              // First PO pins the supplier filter (enforces one-supplier GRN).
              const sid = str(row.supplier?.id);
              setSelectedPoIds((prev) => {
                if (prev.includes(row.id)) {
                  const next = prev.filter((x) => x !== row.id);
                  if (next.length === 0) setSupplierFilter(null);
                  return next;
                }
                if (prev.length === 0 && sid) setSupplierFilter(sid);
                return [...prev, row.id];
              });
            }}
          />
        ) : meta.hasLinePicker ? (
          <LinesStep
            loading={linesQuery.isLoading}
            error={!!linesQuery.error}
            lines={lines}
            target={target}
            onSetLine={setLine}
            onChangeSource={() => { setSelectedSourceId(null); setLines([]); }}
          />
        ) : (
          <GrnReviewStep
            count={selectedPoIds.length}
            deliveryNoteRef={deliveryNoteRef}
            notes={notes}
            onRef={setDeliveryNoteRef}
            onNotes={setNotes}
            onChangeSource={() => { setSelectedPoIds([]); setSupplierFilter(null); }}
          />
        )}
      </div>

      {/* Sticky footer — only shown on step 2 (the create action). */}
      {step === 2 && (
        <footer className="actbar">
          {meta.hasLinePicker && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
              <span style={{ fontSize: 11.5, color: "#767b6e" }}>{picks.length} {picks.length === 1 ? "line" : "lines"}</span>
              <span className="money" style={{ fontSize: 17, fontWeight: 800, color: "#0c3f39" }}>MYR {rm(pickedTotalCenti)}</span>
            </div>
          )}
          <button
            className="btn"
            disabled={!canCreate || submitting}
            onClick={submit}
            style={{ opacity: !canCreate || submitting ? 0.55 : 1 }}
          >
            {submitting ? "Creating…" : `Create ${meta.title.replace(/^New /, "")}`}
          </button>
        </footer>
      )}
    </div>
  );
}

// ── Step 1: source picker ────────────────────────────────────────────────────
function SourceStep({
  kind, loading, error, rows, selectedPoIds, supplierFilter, onPickSingle, onTogglePo,
}: {
  kind: SourceKind;
  loading: boolean;
  error: boolean;
  rows: any[];
  selectedPoIds: string[];
  supplierFilter: string | null;
  onPickSingle: (id: string) => void;
  onTogglePo: (row: PoListRow) => void;
}) {
  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <Muted danger>Couldn't load the source documents. Please try again.</Muted>;
  if (!rows.length) return <Muted>No convertible documents to show.</Muted>;

  if (kind === "po") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {supplierFilter && selectedPoIds.length > 0 && (
          <div style={{ fontSize: 11, color: "#a16a2e", padding: "0 2px" }}>
            One supplier per Goods Receipt — tap more of this supplier's POs to combine.
          </div>
        )}
        {(rows as PoListRow[]).map((r) => {
          const on = selectedPoIds.includes(r.id);
          return (
            <div key={r.id} onClick={() => onTogglePo(r)} className="so-row" style={{ position: "relative", borderColor: on ? "var(--teal)" : undefined }}>
              <div className="so-row-head">
                <span className="so-row-name" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {str(r.supplier?.name) || str(r.po_number)}
                </span>
                <span className="spill" style={{ background: on ? "#e1efed" : "#f4f6f3", color: on ? "#0c3f39" : "#767b6e", border: on ? "none" : "1px solid #e3e6e0", flex: "none" }}>
                  {on ? "Selected" : str(r.status) || "—"}
                </span>
              </div>
              <div className="so-grid">
                <span className="so-k">Order</span>
                <span className="so-v money" style={{ fontWeight: 700, color: "#0c3f39" }}>{str(r.po_number) || "—"}</span>
                <span className="so-k">Date</span>
                <span className="so-v">{dm(r.po_date)}</span>
                <span className="so-k">Total</span>
                <span className="so-v money" style={{ fontSize: 14, fontWeight: 800, color: "#11140f" }}>RM {rm(r.total_centi)}</span>
              </div>
              {on && <Check />}
            </div>
          );
        })}
      </div>
    );
  }

  // SO / DO — single-source tap.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {rows.map((r: any) => {
        const id = kind === "so" ? str(r.doc_no) : str(r.id);
        const docNo = kind === "so" ? str(r.doc_no) : str(r.do_number);
        const date = kind === "so" ? r.so_date : r.do_date;
        const totalC = kind === "so"
          ? (r.local_total_centi ?? r.total_revenue_centi)
          : r.local_total_centi;
        return (
          <div key={id} onClick={() => onPickSingle(id)} className="so-row">
            <div className="so-row-head">
              <span className="so-row-name" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {str(r.debtor_name) || docNo}
              </span>
              {r.status && (
                <span className="spill" style={{ background: "#f4f6f3", color: "#767b6e", border: "1px solid #e3e6e0", flex: "none" }}>{str(r.status)}</span>
              )}
            </div>
            <div className="so-grid">
              <span className="so-k">{kind === "so" ? "Order" : "Delivery"}</span>
              <span className="so-v money" style={{ fontWeight: 700, color: "#0c3f39" }}>{docNo || "—"}</span>
              <span className="so-k">Date</span>
              <span className="so-v">{dm(date)}</span>
              <span className="so-k">Total</span>
              <span className="so-v money" style={{ fontSize: 14, fontWeight: 800, color: "#11140f" }}>RM {rm(totalC)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Step 2 (line picker): SO→DO/PO, DO→SI ────────────────────────────────────
function LinesStep({
  loading, error, lines, target, onSetLine, onChangeSource,
}: {
  loading: boolean;
  error: boolean;
  lines: PickLine[];
  target: ConvertTarget;
  onSetLine: (id: string, patch: Partial<PickLine>) => void;
  onChangeSource: () => void;
}) {
  if (loading) return <Muted>Loading lines…</Muted>;
  if (error) return <Muted danger>Couldn't load the convertible lines. Please try again.</Muted>;

  const noun = target === "si" ? "invoice" : target === "po" ? "purchase" : "deliver";
  if (!lines.length) {
    return (
      <>
        <ChangeSource onClick={onChangeSource} />
        <Muted>Nothing left to {noun} on this document.</Muted>
      </>
    );
  }

  return (
    <>
      <ChangeSource onClick={onChangeSource} />
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {lines.map((l) => {
          const qtyNum = clampQty(l.qty, l.remaining);
          return (
            <div key={l.lineId} className="card" style={{ padding: "11px 12px", borderColor: l.checked ? "var(--teal)" : undefined }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={l.checked}
                  onChange={(e) => onSetLine(l.lineId, { checked: e.target.checked })}
                  style={{ marginTop: 2, width: 16, height: 16, flex: "none", accentColor: "#16695f" }}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#11140f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.label}</span>
                  <span className="money" style={{ display: "block", marginTop: 3, fontSize: 11, color: "#767b6e" }}>
                    Remaining {l.remaining} · RM {rm(l.unitPriceCenti)} each
                  </span>
                </span>
              </label>
              {l.checked && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 9, paddingTop: 9, borderTop: "1px solid #eceee9" }}>
                  <label className="fld" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <span className="fld-l">Qty</span>
                    <input
                      className="fld-i"
                      inputMode="numeric"
                      value={l.qty}
                      onChange={(e) => onSetLine(l.lineId, { qty: e.target.value })}
                      onBlur={() => onSetLine(l.lineId, { qty: String(clampQty(l.qty, l.remaining)) })}
                      style={{ width: 62, textAlign: "center" }}
                    />
                    <span style={{ fontSize: 10.5, color: "#9aa093" }}>/ {l.remaining}</span>
                  </label>
                  <span className="money" style={{ fontSize: 13, fontWeight: 800, color: "#0c3f39" }}>RM {rm(l.unitPriceCenti * qtyNum)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Step 2 (GRN): whole-PO review, no line picker ────────────────────────────
function GrnReviewStep({
  count, deliveryNoteRef, notes, onRef, onNotes, onChangeSource,
}: {
  count: number;
  deliveryNoteRef: string;
  notes: string;
  onRef: (v: string) => void;
  onNotes: (v: string) => void;
  onChangeSource: () => void;
}) {
  return (
    <>
      <ChangeSource onClick={onChangeSource} label="Change selection" />
      <div className="so-card">
        <div className="so-hd"><h2 className="so-ti">Receiving {count} Purchase {count === 1 ? "Order" : "Orders"}</h2></div>
        <div className="so-bd">
          <div style={{ fontSize: 11.5, color: "#767b6e" }}>
            Every line of the selected order{count === 1 ? "" : "s"} is received in full. Adjust quantities from the Goods Receipt detail afterwards if needed.
          </div>
          <label className="fld">
            <span className="fld-l">Delivery Note Ref</span>
            <input className="fld-i" value={deliveryNoteRef} onChange={(e) => onRef(e.target.value)} placeholder="Supplier DN number (optional)" />
          </label>
          <label className="fld">
            <span className="fld-l">Notes</span>
            <input className="fld-i" value={notes} onChange={(e) => onNotes(e.target.value)} placeholder="Optional" />
          </label>
        </div>
      </div>
    </>
  );
}

// ── Small shared UI ──────────────────────────────────────────────────────────
function Muted({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return <div style={{ textAlign: "center", color: danger ? "#b23a3a" : "#9aa093", fontSize: 12, padding: "26px 0" }}>{children}</div>;
}
function ChangeSource({ onClick, label = "Change source" }: { onClick: () => void; label?: string }) {
  return (
    <span
      onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, marginBottom: 11, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}
    >
      <span style={{ fontSize: 15, lineHeight: 1 }}>{"‹"}</span> {label}
    </span>
  );
}
function Check() {
  return (
    <span style={{ position: "absolute", top: 10, right: 10, width: 18, height: 18, borderRadius: "50%", background: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
    </span>
  );
}

/** Turn a raw error code / server reason into plain English for the notify. */
function humanize(msg: string): string {
  const map: Record<string, string> = {
    picks_required: "Select at least one line to convert.",
    mixed_customers: "All picked lines must belong to the same customer.",
    mixed_suppliers: "All selected Purchase Orders must be from the same supplier.",
    over_remaining: "One of the quantities is more than what's left to convert. Refresh and try again.",
    not_authenticated: "Your session expired. Please sign in again.",
    load_failed: "Couldn't load the source data. Please try again.",
    invalid_json: "Something went wrong preparing the request. Please try again.",
  };
  return map[msg] ?? msg;
}
