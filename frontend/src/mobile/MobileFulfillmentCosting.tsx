import { useMemo, useState } from "react";
import {
  useFulfillmentCosting,
  type FulfilmentCostingDimension,
  type FulfilmentCostingFilters,
  type FulfilmentCostingRow,
  type FulfilmentCostingGroup,
  type FulfilmentCostingSummary,
} from "../vendor/scm/lib/reports-queries";
import { fmtAmt } from "../lib/scm";
import "./mobile.css";

/*
 * MobileFulfillmentCosting — the phone surface of Finance > Fulfillment Costing
 * (the desktop pages/scm-v2/FulfillmentCosting.tsx, shipped #800). It is the
 * three-way per-line cost comparison — Order-time (①) vs DO ship-time FIFO (②)
 * vs SI landed store-card (③) — grouped By Item / Category / Menu / State, with
 * stage-to-stage variance flags, Pending / Legacy badges and a summary strip.
 *
 * It reuses the SAME read hook the desktop page uses (useFulfillmentCosting →
 * GET /scm/reports/fulfillment-costing); the server does the whole join + FIFO +
 * variance math + aggregation (backend/src/scm/lib/fulfillment-costing.ts), so
 * this screen only fetches, filters and renders. No new endpoint, no backend
 * change, no client-side money math beyond formatting.
 *
 * PERMISSION mirrors the desktop exactly. The endpoint is finance-only: the
 * backend enforces canViewScmFinance, and the desktop gates the nav entry
 * (Sidebar requireFinanceViewer) AND the route (App.tsx FinanceCostingGuard →
 * canViewScmCosting). On mobile the menu row is gated by the same NAV_TABS entry
 * via allowed("/scm/reports/fulfillment-costing"), and this screen is guarded
 * again on canViewScmCosting in MobileApp — an ordinary salesperson never gets
 * the row and can never mount the screen (off, not hide).
 *
 * The desktop is a wide two-table layout (grouped summary + per-line detail);
 * on a phone that becomes a group card list + a tap→full-screen per-group line
 * detail. The response already carries every line (rows), so the detail filters
 * them client-side by the same dimension key the server grouped on — no extra
 * fetch. The mobile shell has no router, so dimension + filters + the open group
 * are plain component state, matching every other mobile screen.
 *
 * English · MYR · DD/MM/YYYY · no emoji.
 */

// ── money / number / pct formatting ──────────────────────────────────────────
// MYR prefix (matches the desktop FulfillmentCosting page, per the task's MYR
// house style). fmtAmt carries the shared finite-guard (#647), reused here so
// this screen can never regress into NaN money. Absent → em dash so a compact
// card reads cleanly; `rm` always shows 0.00 for a headline figure.
const money = (centi: number | null | undefined): string =>
  centi == null ? "—" : `MYR ${fmtAmt(centi)}`;
const rm = (centi: number | null | undefined): string => `MYR ${fmtAmt(centi)}`;
const pct = (p: number | null | undefined): string =>
  p == null ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;

/* Variance flag thresholds (mirror the desktop varianceTone): >5% strong (red),
   2-5% mild (amber), else neutral. Returns the CSS-var colour that drives both
   the per-line drift cells and the group headline. */
function varianceColor(p: number | null | undefined): string {
  if (p == null) return "var(--mut)";
  const a = Math.abs(p);
  if (a > 5) return "var(--red)";
  if (a >= 2) return "var(--gold)";
  return "var(--ink2)";
}

const DIMENSIONS: { key: FulfilmentCostingDimension; label: string }[] = [
  { key: "item", label: "By Item" },
  { key: "category", label: "By Category" },
  { key: "menu", label: "By Menu" },
  { key: "state", label: "By State" },
];

/* Same key a row groups under on the server (backend dimensionKeyLabel), so a
   group card can gather its own lines from the flat `rows` list without a second
   request. A missing value groups under '' (labelled "Unspecified"). */
function rowKey(r: FulfilmentCostingRow, dim: FulfilmentCostingDimension): string {
  switch (dim) {
    case "item": return r.item_code;
    case "category": return r.category ?? "";
    case "menu": return r.menu ?? "";
    case "state": return r.customer_state ?? "";
  }
}

const countActiveFilters = (f: FulfilmentCostingFilters): number => {
  let n = 0;
  if (f.itemCode) n++;
  if (f.category) n++;
  if (f.state) n++;
  if (f.dateFrom) n++;
  if (f.dateTo) n++;
  if (f.minVariancePct != null) n++;
  if (f.pending) n++;
  return n;
};

type OpenGroup = { key: string; label: string };

/** Fulfillment Costing — mobile. Top bar (title + Filters), dimension tabs, a
 *  group card list, and a tap→full-screen per-group line detail. */
export function MobileFulfillmentCosting({ onBack }: { onBack: () => void }) {
  const [groupBy, setGroupBy] = useState<FulfilmentCostingDimension>("category");
  const [filters, setFilters] = useState<FulfilmentCostingFilters>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const [open, setOpen] = useState<OpenGroup | null>(null);

  const q = useFulfillmentCosting({ ...filters, groupBy });
  const data = q.data;
  const summary = data?.summary;
  const groups = data?.groups ?? [];
  const rows = data?.rows ?? [];
  const legacyCount = summary?.legacy_count ?? 0;
  const pendingCount = summary?.pending_count ?? 0;
  const activeFilterCount = countActiveFilters(filters);

  const dimLabel = useMemo(
    () => DIMENSIONS.find((d) => d.key === groupBy)?.label ?? "Group",
    [groupBy],
  );

  if (open) {
    // Lines for the tapped group — same key the server grouped on. Sliced off the
    // response we already hold, so the detail needs no extra request.
    const groupRows = rows.filter((r) => rowKey(r, groupBy) === open.key);
    return (
      <CostingDetail
        title={open.label}
        eyebrow={dimLabel.replace("By ", "")}
        rows={groupRows}
        onBack={() => setOpen(null)}
      />
    );
  }

  return (
    <div className="hz-m" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <button onClick={onBack} className="back" style={{ marginBottom: 4 }}>
              <span className="chev">‹</span> Back
            </button>
            <div className="eyebrow">Finance</div>
            <div className="scr-title">Fulfillment Costing</div>
          </div>
          <button onClick={() => setSheetOpen(true)} className="iconbtn" style={{ position: "relative", width: "auto", padding: "0 12px", gap: 6, fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: "var(--ink2)" }} aria-label="Filters">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
            Filters
            {activeFilterCount > 0 && (
              <span style={{ background: "var(--gold)", color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 999, minWidth: 15, height: 15, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}>{activeFilterCount}</span>
            )}
          </button>
        </div>
        {/* Dimension tabs — By Item / Category / Menu / State (the desktop's dim tabs). */}
        <div className="chips" style={{ marginTop: 11 }}>
          {DIMENSIONS.map((d) => (
            <button key={d.key} onClick={() => setGroupBy(d.key)} className={groupBy === d.key ? "chip on" : "chip"}>{d.label}</button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        <div style={{ fontSize: 10.5, color: "var(--mut)", background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: 9, padding: "8px 10px", marginBottom: 11 }}>
          Three-way cost per Sales Order line: Order-time (①) vs DO ship-time FIFO (②) vs SI landed (③). Tap a {dimLabel.replace("By ", "").toLowerCase()} for its per-line detail.
        </div>

        {/* Summary strip — Lines + the three stage costs + the ③−① variance. */}
        {summary && !q.isError && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginBottom: 11 }}>
            <Fig k="Lines" v={summary.lines.toLocaleString("en-MY")} />
            <Fig k="Variance ③−①" v={money(summary.variance_centi)} sub={pct(summary.variance_pct)} tone={summary.variance_centi > 0 ? "err" : summary.variance_centi < 0 ? "ok" : undefined} />
            <Fig k="Order ①" v={money(summary.order_cost_centi)} />
            <Fig k="DO FIFO ②" v={money(summary.do_cost_centi)} />
            <Fig k="SI Landed ③" v={money(summary.si_cost_centi)} />
            <Fig k="Pending · Legacy" v={`${pendingCount} · ${legacyCount}`} />
          </div>
        )}

        {/* Honesty banner — legacy ② + pending ③ are real data limits, surfaced. */}
        {(legacyCount > 0 || pendingCount > 0) && !q.isError && (
          <div style={{ fontSize: 10.5, color: "var(--gold)", background: "var(--amber-bg)", border: "1px solid #ecdcb4", borderRadius: 9, padding: "8px 10px", marginBottom: 11 }}>
            {legacyCount > 0 && (
              <span>{legacyCount} line{legacyCount === 1 ? "" : "s"} shipped before ship-time cost was captured — their DO FIFO (②) falls back to the landed cost and is marked <b>Legacy</b>. </span>
            )}
            {pendingCount > 0 && (
              <span>{pendingCount} line{pendingCount === 1 ? "" : "s"} not yet invoiced — landed cost (③) is <b>Pending</b>.</span>
            )}
          </div>
        )}

        {!q.isLoading && !q.isError && (
          <div style={{ fontSize: 11.5, color: "var(--mut)", margin: "0 2px 11px" }}>
            <b style={{ color: "var(--ink)" }}>{groups.length}</b> {dimLabel.toLowerCase().replace("by ", "")} {groups.length === 1 ? "group" : "groups"}
          </div>
        )}

        {q.isLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card"><div className="card-b ph" style={{ height: 104, borderRadius: 14 }} /></div>
            ))}
          </div>
        )}
        {q.isError && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>Couldn't load Fulfillment Costing</span>
            <button onClick={() => q.refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
          </div>
        )}

        {!q.isLoading && !q.isError && data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {groups.map((g) => (
              <GroupCard key={g.key || "∅"} g={g} onOpen={() => setOpen({ key: g.key, label: g.label })} />
            ))}
            {groups.length === 0 && (
              <div className="empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c2c6bd" strokeWidth="1.6"><path d="M4 4h16v4H4zM4 10h16v10H4z" /></svg>
                <div className="empty-t">No lines</div>
                <div className="empty-s">No lines match the current filters.</div>
              </div>
            )}
          </div>
        )}
      </div>

      {sheetOpen && (
        <FilterSheet
          filters={filters}
          onApply={(f) => { setFilters(f); setSheetOpen(false); }}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}

// ── group card ───────────────────────────────────────────────────────────────
function CardStat({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "var(--mut)" }}>{k}</div>
      <div className="money" style={{ fontSize: 12.5, fontWeight: 700, marginTop: 2, color: color ?? "var(--ink)" }}>{v}</div>
    </div>
  );
}

function GroupCard({ g, onOpen }: { g: FulfilmentCostingGroup; onOpen: () => void }) {
  const tone = varianceColor(g.variance_pct);
  return (
    <div className="card" style={{ padding: "13px 14px", cursor: "pointer" }} onClick={onOpen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.label}</span>
        <span className="money" style={{ marginLeft: "auto", flex: "none", fontSize: 13, fontWeight: 800, color: tone }}>{pct(g.variance_pct)}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 5 }}>
        {g.lines} line{g.lines === 1 ? "" : "s"} · Variance <b className="money" style={{ color: tone }}>{money(g.variance_centi)}</b>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--line2)" }}>
        <CardStat k="Order ①" v={money(g.order_cost_centi)} />
        <CardStat k="DO FIFO ②" v={money(g.do_cost_centi)} />
        <CardStat k="SI Landed ③" v={money(g.si_cost_centi)} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 11, fontSize: 11.5 }}>
        {g.pending_count > 0 && <span className="badge b-amber">{g.pending_count} pending</span>}
        {g.legacy_count > 0 && <span className="badge b-grey">{g.legacy_count} legacy</span>}
        <span style={{ marginLeft: "auto", color: "var(--brand)", fontWeight: 600 }}>Tap ›</span>
      </div>
    </div>
  );
}

// ── filter bottom-sheet ─────────────────────────────────────────────────────
function FilterSheet({ filters, onApply, onClose }: {
  filters: FulfilmentCostingFilters; onApply: (f: FulfilmentCostingFilters) => void; onClose: () => void;
}) {
  // Edit a draft, commit on Apply (a keystroke shouldn't refetch while the sheet
  // is open) — matches the desktop page's filter inputs, minus the dimension
  // (that's the header tabs).
  const [draft, setDraft] = useState<FulfilmentCostingFilters>(filters);
  const set = (patch: Partial<FulfilmentCostingFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const selStyle: React.CSSProperties = { width: "100%" };

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" style={{ maxHeight: "88%" }}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="eyebrow">Filter</div>
            <div className="scr-title" style={{ fontSize: 17 }}>Fulfillment Costing</div>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="sheet-scroll" style={{ gap: 11 }}>
          <FRow label="Item code">
            <input className="fld-i" style={selStyle} placeholder="e.g. MAT-001" value={draft.itemCode ?? ""} onChange={(e) => set({ itemCode: e.target.value || undefined })} />
          </FRow>
          <FRow label="Category">
            <input className="fld-i" style={selStyle} placeholder="e.g. MATTRESS" value={draft.category ?? ""} onChange={(e) => set({ category: e.target.value || undefined })} />
          </FRow>
          <FRow label="State">
            <input className="fld-i" style={selStyle} placeholder="e.g. Selangor" value={draft.state ?? ""} onChange={(e) => set({ state: e.target.value || undefined })} />
          </FRow>
          <div className="fld-row">
            <FRow label="SO date from">
              <input type="date" className="fld-i" style={selStyle} value={draft.dateFrom ?? ""} onChange={(e) => set({ dateFrom: e.target.value || undefined })} />
            </FRow>
            <FRow label="SO date to">
              <input type="date" className="fld-i" style={selStyle} value={draft.dateTo ?? ""} onChange={(e) => set({ dateTo: e.target.value || undefined })} />
            </FRow>
          </div>
          <FRow label="Variance greater than %">
            <input type="number" inputMode="decimal" className="fld-i" style={selStyle} placeholder="e.g. 5" value={draft.minVariancePct ?? ""} onChange={(e) => set({ minVariancePct: e.target.value.trim() === "" || Number.isNaN(Number(e.target.value)) ? null : Number(e.target.value) })} />
          </FRow>
          <label className="fld" style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
            <input type="checkbox" checked={!!draft.pending} onChange={(e) => set({ pending: e.target.checked || undefined })} />
            <span style={{ fontSize: 12.5, color: "var(--ink)" }}>Pending only (no landed cost yet)</span>
          </label>
          <div style={{ display: "flex", gap: 9, marginTop: 4 }}>
            <button className="btn-ghost" style={{ flex: 1 }} onClick={() => onApply({})}>Clear</button>
            <button className="btn" style={{ flex: 2 }} onClick={() => onApply(draft)}>Apply filters</button>
          </div>
        </div>
      </div>
    </div>
  );
}
function FRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fld" style={{ flex: 1 }}>
      <label className="fld-l">{label}</label>
      {children}
    </div>
  );
}

// ── full-screen per-group line detail ────────────────────────────────────────
const secH: React.CSSProperties = { fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--mut)", margin: "20px 0 10px" };

/** Summarise a set of lines the same way the server summarises a group, so the
 *  detail header agrees with the group card even though it reads the flat rows. */
function summariseRows(rows: FulfilmentCostingRow[]): FulfilmentCostingSummary {
  let order = 0, doc = 0, si = 0, pending = 0, legacy = 0;
  for (const r of rows) {
    order += r.order_line_centi;
    doc += r.do_line_centi;
    si += r.si_line_centi;
    if (r.pending) pending++;
    if (r.do_cost_is_legacy) legacy++;
  }
  const variance = si - order;
  return {
    lines: rows.length,
    order_cost_centi: order,
    do_cost_centi: doc,
    si_cost_centi: si,
    variance_centi: variance,
    variance_pct: order ? (variance / order) * 100 : null,
    pending_count: pending,
    legacy_count: legacy,
  };
}

function CostingDetail({ title, eyebrow, rows, onBack }: { title: string; eyebrow: string; rows: FulfilmentCostingRow[]; onBack: () => void }) {
  const s = useMemo(() => summariseRows(rows), [rows]);
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 11, background: "var(--ink-dark)", color: "#fff", padding: "calc(env(safe-area-inset-top) + 13px) 14px 13px" }}>
        <button onClick={onBack} aria-label="Back" style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 24, lineHeight: 1, padding: "0 4px 0 0", fontFamily: "inherit" }}>←</button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
          <div style={{ fontSize: 10.5, color: "#9fb0a8", marginTop: 1 }}>{eyebrow} · {s.lines} line{s.lines === 1 ? "" : "s"}</div>
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        {/* group figures */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
          <Fig k="Order ①" v={money(s.order_cost_centi)} />
          <Fig k="DO FIFO ②" v={money(s.do_cost_centi)} />
          <Fig k="SI Landed ③" v={money(s.si_cost_centi)} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 9, marginTop: 9 }}>
          <Fig k="Variance ③−①" v={rm(s.variance_centi)} sub={pct(s.variance_pct)} tone={s.variance_centi > 0 ? "err" : s.variance_centi < 0 ? "ok" : undefined} />
          <Fig k="Pending · Legacy" v={`${s.pending_count} · ${s.legacy_count}`} />
        </div>

        <div style={secH}>Lines · three-way cost per unit</div>
        {rows.length === 0 && <div style={{ fontSize: 12, color: "var(--mut)" }}>No lines.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {rows.map((r) => <LineCard key={r.so_item_id} r={r} />)}
        </div>
      </div>
    </div>
  );
}

function LineCard({ r }: { r: FulfilmentCostingRow }) {
  const t1 = varianceColor(r.var_do_order_pct);
  const t2 = varianceColor(r.var_si_do_pct);
  return (
    <div className="card" style={{ padding: "11px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--brand-d)" }}>{r.doc_no}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--mut)" }}>Qty {r.qty}</span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ink)", marginTop: 4 }}>
        <b>{r.item_code}</b>{r.item_name ? <span style={{ color: "var(--mut)" }}> — {r.item_name}</span> : null}
      </div>
      <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>
        {[r.category, r.menu, r.customer_state].filter(Boolean).join(" · ") || "—"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginTop: 10 }}>
        <LineCell k="Order ① /u" v={money(r.order_unit_centi)} />
        <LineCell k="DO ② /u" v={money(r.do_unit_centi)} />
        <LineCell k="SI ③ /u" v={money(r.si_unit_centi)} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 11.5 }}>
        <span style={{ color: "var(--ink2)" }}>② vs ① <b className="money" style={{ color: t1 }}>{pct(r.var_do_order_pct)}</b></span>
        <span style={{ color: "var(--ink2)" }}>③ vs ② <b className="money" style={{ color: t2 }}>{pct(r.var_si_do_pct)}</b></span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {r.pending && <span className="badge b-amber">Pending</span>}
          {r.do_cost_is_legacy && <span className="badge b-grey">Legacy</span>}
        </span>
      </div>
    </div>
  );
}

// ── shared figure tile ───────────────────────────────────────────────────────
function Fig({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: "err" | "ok" }) {
  const color = tone === "err" ? "var(--red)" : tone === "ok" ? "var(--green)" : "var(--ink)";
  return (
    <div className="card" style={{ padding: "10px 11px" }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em", color: "var(--mut)" }}>{k}</div>
      <div className="money" style={{ fontSize: 14, fontWeight: 800, marginTop: 4, color }}>{v}</div>
      {sub != null && <div className="money" style={{ fontSize: 10.5, fontWeight: 600, marginTop: 1, color }}>{sub}</div>}
    </div>
  );
}
function LineCell({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div style={{ fontSize: 7.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".02em", color: "var(--mut)" }}>{k}</div>
      <div className="money" style={{ fontSize: 11.5, fontWeight: 700, marginTop: 2, color: "var(--ink)" }}>{v}</div>
    </div>
  );
}

export default MobileFulfillmentCosting;
