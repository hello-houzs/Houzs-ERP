import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useAuth } from "../auth/AuthContext";
import { normalizeJobs, type ScanJobsResp } from "./MobileScan";
import "./mobile.css";

type SoRow = {
  doc_no: string; debtor_name: string | null; status: string | null;
  sales_location: string | null; warehouse_name: string | null;
  customer_state: string | null; ref: string | null; po_doc_no: string | null;
  customer_so_no: string | null;
  processing_date: string | null; customer_delivery_date: string | null; internal_expected_dd: string | null;
  so_date: string | null; created_at: string | null;
  local_total_centi: number | null; total_revenue_centi: number | null; paid_total_centi: number | null;
  balance_centi: number | null; balance_centi_live: number | null;
  /* Fulfilment status the list endpoint derives per SO (only rendered when the
     row actually carries it — a Draft/Cancelled SO has none). */
  planning_state: string | null;
  is_fully_ready: boolean | null; is_main_ready: boolean | null; ready_categories: string[] | null;
};

const rm = (centi: number | null | undefined) =>
  ((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* Numeric DD/MM/YYYY (owner-locked desktop/mobile date format — never month names). */
const dm = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d); if (isNaN(+dt)) return "—";
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
};
const total = (r: SoRow) => r.local_total_centi ?? r.total_revenue_centi ?? 0;
const paid = (r: SoRow) => r.paid_total_centi ?? 0;
const balance = (r: SoRow) => r.balance_centi_live ?? r.balance_centi ?? (total(r) - paid(r));
const isCancelled = (r: SoRow) => (r.status ?? "").toLowerCase() === "cancelled";
const isDraft = (r: SoRow) => (r.status ?? "").toLowerCase() === "draft";
const soDate = (r: SoRow) => r.so_date ?? r.created_at ?? null;

/* ── Draft-created notifier — localStorage ack set ─────────────────────────
   Owner 2026-07-04: "after a scan creates a draft, next time I open the app tell
   me 'SO xxx created as draft'." On the Orders screen mount we read the recent
   done scan jobs (GET /scan-so/jobs) and toast the ones we haven't yet
   acknowledged. Acknowledged job ids live in localStorage so the toast fires
   ONCE per new draft, never re-fires on every navigation back to Orders.
   Bounded to the last N ids so the set can't grow forever. */
const SCAN_ACK_KEY = "houzs:scan-draft-acked";
const SCAN_ACK_MAX = 200;
/* Only consider jobs finished within this window — an old done job the operator
   has long since seen must not toast just because the ack set was cleared. */
const SCAN_ACK_WINDOW_MS = 30 * 60 * 1000; // 30 min

function readAckedJobIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SCAN_ACK_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
  } catch {
    return new Set();
  }
}
function writeAckedJobIds(ids: Set<string>): void {
  try {
    // Keep only the most recent SCAN_ACK_MAX ids (insertion order preserved).
    const arr = Array.from(ids);
    const trimmed = arr.length > SCAN_ACK_MAX ? arr.slice(arr.length - SCAN_ACK_MAX) : arr;
    localStorage.setItem(SCAN_ACK_KEY, JSON.stringify(trimmed));
  } catch {
    /* private-mode / quota — the toast just re-fires next open, harmless */
  }
}
const jobTsMs = (s: string | null | undefined): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/* Period chips → client-side date buckets. The list endpoint returns all rows
   (no server range param), so — like the owner's prototype — we bucket by
   so_date locally. */
type Range = "all" | "this-month" | "last-month" | "next-month" | "this-year";
const RANGES: [Range, string][] = [
  ["all", "All"], ["this-month", "This month"], ["last-month", "Last month"],
  ["next-month", "Next month"], ["this-year", "This year"],
];

/* Status filter → picks by raw SO status. Real SO statuses are DRAFT / CONFIRMED
   / CANCELLED (see lib/status-pill.ts SO map + lib/so-status.ts); older data /
   sibling ERPs may spell the active state SUBMITTED, so the active buckets match
   either spelling and nothing taps into a dead filter (the old blind cycle's
   bug: it filtered on "Submitted", which no SO row carried). `match: null` = All. */
type StatusFilter = "all" | "draft" | "submitted" | "confirmed" | "cancelled";
const STATUS_FILTERS: { key: StatusFilter; label: string; match: string[] | null }[] = [
  { key: "all",       label: "All",       match: null },
  { key: "draft",     label: "Draft",     match: ["draft"] },
  { key: "submitted", label: "Submitted", match: ["submitted", "confirmed"] },
  { key: "confirmed", label: "Confirmed", match: ["confirmed", "submitted"] },
  { key: "cancelled", label: "Cancelled", match: ["cancelled"] },
];
function statusMatches(r: SoRow, filter: StatusFilter): boolean {
  const entry = STATUS_FILTERS.find((f) => f.key === filter);
  if (!entry || !entry.match) return true;
  return entry.match.includes((r.status ?? "").toLowerCase());
}
function inRange(r: SoRow, range: Range): boolean {
  if (range === "all") return true;
  const raw = soDate(r); if (!raw) return false;
  const d = new Date(raw); if (isNaN(+d)) return false;
  const now = new Date(); const y = now.getFullYear(); const m = now.getMonth();
  if (range === "this-year") return d.getFullYear() === y;
  const bucket =
    range === "this-month" ? new Date(y, m, 1) :
    range === "last-month" ? new Date(y, m - 1, 1) :
    new Date(y, m + 1, 1); // next-month
  return d.getFullYear() === bucket.getFullYear() && d.getMonth() === bucket.getMonth();
}

/** Sales Orders list — 1:1 with the owner's mobile prototype (`#so-list`), wired
 *  to the same /api/scm/mfg-sales-orders the desktop uses (row-scoped +
 *  permission-gated by the backend). Summary bar + period chips + card + FAB. */
export function MobileSalesOrders({ onScan, onOpen, onNew }: { onScan: () => void; onOpen: (docNo: string) => void; onNew: () => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [range, setRange] = useState<Range>("all");
  const [filterOpen, setFilterOpen] = useState(false);

  /* Item 3 — bulk confirm. selectMode toggles the tick UI; `selected` is the set
     of picked DRAFT doc_nos; `confirming` runs the sequential PATCH pass. */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [confirmProgress, setConfirmProgress] = useState(0);
  /* Long-press to ENTER select mode (and pre-tick the pressed DRAFT row). The
     timer fires after 450ms; a tap that releases sooner opens the SO as usual.
     `longPressFired` suppresses the click that follows the long-press release. */
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["mobile-so-list"],
    queryFn: () => authedFetch<{ salesOrders?: SoRow[]; orders?: SoRow[]; rows?: SoRow[] }>("/mfg-sales-orders?limit=500&fields=minimal"),
    staleTime: 30_000,
  });
  const all = data?.salesOrders ?? data?.orders ?? data?.rows ?? [];

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (!statusMatches(r, status)) return false;
      if (!inRange(r, range)) return false;
      if (needle && !`${r.debtor_name ?? ""} ${r.doc_no} ${r.customer_so_no ?? ""} ${r.ref ?? ""} ${r.po_doc_no ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [all, q, status, range]);

  /* Summary bar totals — exclude cancelled orders (mirrors the prototype: a
     voided order contributes neither revenue nor outstanding). */
  const summary = useMemo(() => {
    let rev = 0, out = 0;
    for (const r of rows) {
      if (isCancelled(r)) continue;
      rev += total(r);
      const b = balance(r); if (b > 0) out += b;
    }
    return { count: rows.length, rev, out };
  }, [rows]);

  const filterActive = status !== "all" || range !== "all";

  /* ── Item 2 — "SO xxx created as draft" notification ──────────────────────
     On mount, pull this rep's recent scan jobs and toast any DONE job (with a
     soDocNo, finished in the last 30 min) we haven't acknowledged yet. One
     toast per new draft, or a combined "N drafts saved" when several land at
     once. Tapping a single-draft toast opens that SO. Acked ids are persisted
     so the toast never re-fires on a later Orders visit. Fail-soft: any jobs
     hiccup silently skips the notification (retry:false, no dialog). */
  const salesperson = (user?.name || user?.email || "").trim();
  const notifiedRef = useRef(false);
  const { data: jobsData } = useQuery({
    queryKey: ["mobile-so-scan-jobs", salesperson],
    queryFn: () =>
      authedFetch<ScanJobsResp>(
        salesperson ? `/scan-so/jobs?salesperson=${encodeURIComponent(salesperson)}` : "/scan-so/jobs",
      ),
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (notifiedRef.current || !jobsData) return;
    const now = Date.now();
    const acked = readAckedJobIds();
    const fresh = (j: { id: string; updatedAt: string | null; createdAt: string | null }) =>
      now - jobTsMs(j.updatedAt ?? j.createdAt) < SCAN_ACK_WINDOW_MS && !acked.has(j.id);
    const all = normalizeJobs(jobsData);
    // Owner 2026-07-04: EVERY scan lands a draft, so the toast announces them all
    // — a clean draft, a possible-duplicate draft, and a blank "please complete"
    // draft (the case that used to just error) all open the same way. Genuine
    // SYSTEM failures (status 'error' — no draft was created) are surfaced too,
    // so the rep knows to scan again. Newest first.
    const drafts = all
      .filter((j) => j.status === "done" && j.soDocNo && fresh(j))
      .sort((a, b) => jobTsMs(b.updatedAt ?? b.createdAt) - jobTsMs(a.updatedAt ?? a.createdAt));
    const failures = all.filter((j) => j.status === "error" && fresh(j));
    if (drafts.length === 0 && failures.length === 0) return;
    notifiedRef.current = true; // once per screen mount — never double-fire on navigation

    // Ack everything we're about to surface, so re-mounts don't repeat it.
    for (const j of [...drafts, ...failures]) acked.add(j.id);
    writeAckedJobIds(acked);

    // Single draft, nothing else → open it straight after the toast.
    if (drafts.length === 1 && failures.length === 0) {
      const j = drafts[0];
      const doc = j.soDocNo!;
      // A shell/blank or payment-warning draft carries a plain note in `error`;
      // a possible-duplicate carries the earlier doc no. Either rides in the body.
      const extra = j.duplicateOf
        ? ` This looks like a possible duplicate of ${j.duplicateOf}.`
        : j.error
          ? ` ${j.error}`
          : "";
      void notify({
        title: "Scan complete",
        body: `${doc} was saved as a draft.${extra} Tap OK, then open it from your Orders to review.`,
      }).then(() => {
        // Nudge the list so the new draft is visible before the operator taps in.
        void refetch();
        onOpen(doc);
      });
      return;
    }

    // Several drafts and/or a system failure → one combined summary, no auto-open.
    const parts: string[] = [];
    if (drafts.length > 0) {
      parts.push(
        drafts.length === 1
          ? `${drafts[0].soDocNo} was saved as a draft`
          : `${drafts.length} scanned orders were saved as drafts`,
      );
    }
    if (failures.length > 0) {
      parts.push(
        `${failures.length} ${failures.length === 1 ? "scan" : "scans"} could not be read — please scan again`,
      );
    }
    void notify({
      title: "Scan update",
      body: `${parts.join(". ")}. Review them in your Orders list.`,
    }).then(() => void refetch());
  }, [jobsData, notify, onOpen, refetch]);

  /* ── Item 3 — bulk confirm helpers ──────────────────────────────────────
     Only DRAFT rows are selectable. exitSelect resets the whole selection UI. */
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmProgress(0);
  };
  const toggleSelect = (docNo: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(docNo)) next.delete(docNo);
      else next.add(docNo);
      return next;
    });
  };
  const clearLongPress = () => {
    if (lpTimer.current !== null) { window.clearTimeout(lpTimer.current); lpTimer.current = null; }
  };
  /* A row tap: in select mode a DRAFT row toggles its tick (non-draft rows are
     inert); otherwise it opens the SO. A long-press that already fired swallows
     this click. */
  const onCardTap = (r: SoRow) => {
    if (lpFired.current) { lpFired.current = false; return; }
    if (selectMode) { if (isDraft(r)) toggleSelect(r.doc_no); return; }
    onOpen(r.doc_no);
  };
  /* Long-press on a DRAFT row enters select mode and pre-ticks it. Ignored while
     already selecting or confirming, and on non-draft rows. */
  const onCardPressStart = (r: SoRow) => {
    if (selectMode || confirming || !isDraft(r)) return;
    lpFired.current = false;
    clearLongPress();
    lpTimer.current = window.setTimeout(() => {
      lpFired.current = true;
      setSelectMode(true);
      setSelected(new Set([r.doc_no]));
    }, 450);
  };
  /* Sequentially PATCH each selected DRAFT → CONFIRMED via the SAME status
     endpoint the single-confirm path uses (MobileSODetail.setStatus):
     PATCH /mfg-sales-orders/:docNo/status {status:'CONFIRMED'}. One at a time so
     a mid-batch failure is contained; tallies N confirmed / M failed and toasts
     a summary, then refetches the list. */
  const bulkConfirm = async () => {
    if (confirming || selected.size === 0) return;
    const docs = Array.from(selected);
    setConfirming(true);
    setConfirmProgress(0);
    let ok = 0;
    const failures: string[] = [];
    for (const docNo of docs) {
      try {
        await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "CONFIRMED" }),
        });
        ok += 1;
      } catch {
        failures.push(docNo);
      }
      setConfirmProgress((p) => p + 1);
    }
    // Refresh the list + any open detail caches so statuses reflect the change.
    await Promise.all([
      refetch(),
      qc.invalidateQueries({ queryKey: ["mobile-so-detail"] }),
    ]);
    setConfirming(false);
    exitSelect();
    const m = failures.length;
    void notify({
      title: m === 0 ? "Orders confirmed" : "Some orders couldn't be confirmed",
      body:
        m === 0
          ? `${ok} order${ok === 1 ? "" : "s"} confirmed.`
          : `${ok} confirmed, ${m} failed. The failed order${m === 1 ? "" : "s"} stayed as draft${m === 1 ? "" : "s"} — try again.`,
      tone: m === 0 ? "info" : "error",
    });
  };

  return (
    <div className="hz-m" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <div className="eyebrow">Supply chain</div>
            <div className="scr-title">Sales Orders</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Item 3 — Select toggle: enters/exits DRAFT multiselect. In select
                mode it reads "Done" and clears the picks. */}
            {selectMode ? (
              <button onClick={exitSelect} className="iconbtn" aria-label="Exit selection" style={{ width: "auto", padding: "0 12px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: "#16695f" }}>
                Done
              </button>
            ) : (
              <button onClick={() => setSelectMode(true)} className="iconbtn" aria-label="Select orders" title="Select drafts to confirm">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
              </button>
            )}
            {!selectMode && (
              <button onClick={onScan} aria-label="Scan slip" className="iconbtn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
              </button>
            )}
          </div>
        </div>
        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer · SO · reference" />
          </div>
          <button onClick={() => setFilterOpen(true)} className="iconbtn" style={{ position: "relative" }} aria-label="Filter by status">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
            {filterActive && <span style={{ position: "absolute", top: -3, right: -3, width: 9, height: 9, borderRadius: "50%", background: "var(--gold)", border: "1.5px solid #fff" }} />}
          </button>
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {/* Summary bar — N orders · RM rev · RM outstanding (outstanding hidden when zero). */}
        {!isLoading && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 11.5, color: "var(--mut)", margin: "0 2px 11px" }}>
            <span><b style={{ color: "var(--ink)" }}>{summary.count}</b> orders</span>
            <span style={{ opacity: .4 }}>·</span>
            <span className="money">RM {rm(summary.rev)} rev</span>
            {summary.out > 0 && <>
              <span style={{ opacity: .4 }}>·</span>
              <span className="money" style={{ color: "var(--red)" }}>RM {rm(summary.out)} outstanding</span>
            </>}
          </div>
        )}

        {/* Period filter chips (h-scroll). */}
        <div className="chips" style={{ marginBottom: 11 }}>
          {RANGES.map(([key, label]) => (
            <button key={key} onClick={() => setRange(key)} className={range === key ? "chip on" : "chip"}>{label}</button>
          ))}
        </div>

        {isLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card"><div className="card-b ph" style={{ height: 92, borderRadius: 14 }} /></div>
            ))}
          </div>
        )}
        {error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>Couldn't load orders</span>
            <button onClick={() => refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
          </div>
        )}
        {!isLoading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {rows.map((r) => {
              const cancelled = isCancelled(r);
              const warehouse = r.warehouse_name || r.sales_location;
              return (
                /* Owner-locked SO card (prototype `soRowCard`):
                   L1  {customer name}                          ·  {status badge}
                   L2  {doc_no} · {customer_so_no}     |  {warehouse}
                   L3  Processing {date}  ->  Delivery {date}
                   L4  (Stock chip · Planning chip — only when the row carries them)
                   L5  {created_at} · created                   ·  {total} (bold) */
                <div key={r.doc_no} onClick={() => onOpen(r.doc_no)} className={cancelled ? "card cancelled" : "card"} style={{ cursor: "pointer", padding: "12px 13px", ...(cancelled ? { opacity: .55, filter: "grayscale(.5)" } : null) }}>
                  {/* Line 1 — customer name / status */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ minWidth: 0, fontSize: 14, fontWeight: 800, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.debtor_name || "—"}</span>
                    <StatusPill status={r.status} />
                  </div>
                  {/* Line 2 — doc_no · customer_so_no on their OWN full-width row
                      (owner: the SO number + reference were squeezed to "SO-260…
                      · HC 1…" by the warehouse sharing the line). doc_no stays
                      whole (flex:none); only the ref ellipsises if truly long. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, marginTop: 5, fontSize: 11.5, color: "var(--mut)" }}>
                    <span className="money" style={{ fontWeight: 700, color: "var(--brand-d)", flex: "none" }}>{r.doc_no}</span>
                    {r.customer_so_no && <><span style={{ opacity: .4, flex: "none" }}>·</span><span className="money" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.customer_so_no}</span></>}
                  </div>
                  {/* Line 2b — warehouse on its own line so it never crowds the ids */}
                  {warehouse && (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, marginTop: 4, fontSize: 11.5, fontWeight: 600, color: "var(--ink2)" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M3 21V8l9-5 9 5v13" /><path d="M7 21v-8h10v8" /></svg>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{warehouse}</span>
                    </div>
                  )}
                  {/* Line 3 — Processing -> Delivery */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11, color: "var(--ink2)" }}>
                    <span style={{ color: "var(--mut2)", fontWeight: 600 }}>Processing</span>
                    <span className="money" style={{ fontWeight: 600 }}>{dm(r.internal_expected_dd ?? r.processing_date)}</span>
                    <span style={{ color: "#c2c6bd" }}>&rarr;</span>
                    <span style={{ color: "var(--mut2)", fontWeight: 600 }}>Delivery</span>
                    <span className="money" style={{ fontWeight: 600 }}>{dm(r.customer_delivery_date)}</span>
                  </div>
                  {/* Line 4 — fulfilment chips (only when live + present) */}
                  <FulfilChips row={r} />
                  {/* Line 5 — created / total */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
                    <span style={{ fontSize: 10, color: "var(--mut2)" }}>{dm(soDate(r))} · created</span>
                    <span className="money" style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>RM {rm(total(r))}</span>
                  </div>
                </div>
              );
            })}
            {!rows.length && (
              <div className="empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c2c6bd" strokeWidth="1.6"><path d="M4 4h16v4H4zM4 10h16v10H4z" /></svg>
                <div className="empty-t">No sales orders</div>
                <div className="empty-s">No orders in this range. Tap + to create one.</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status filter bottom-sheet — replaces the old blind status-cycle. Lists
          the real SO status options; the selected one shows a check + highlight,
          and a non-"All" pick keeps the funnel's gold dot lit. */}
      {filterOpen && (
        <div className="sheet-bd" onClick={() => setFilterOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxHeight: "70%" }}>
            <div className="grab" />
            <div className="sheet-head">
              <div>
                <div className="eyebrow">Filter</div>
                <div className="scr-title" style={{ fontSize: 17 }}>Order status</div>
              </div>
              <button className="sheet-x" onClick={() => setFilterOpen(false)} aria-label="Close">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div className="sheet-scroll" style={{ gap: 8 }}>
              {STATUS_FILTERS.map(({ key, label }) => {
                const on = status === key;
                return (
                  <button
                    key={key}
                    onClick={() => { setStatus(key); setFilterOpen(false); }}
                    className="mcard"
                    style={{ justifyContent: "space-between", ...(on ? { borderColor: "var(--brand)", background: "var(--brand-bg)" } : null) }}
                  >
                    <span className="ml" style={on ? { color: "var(--brand-d)" } : undefined}>{label}</span>
                    {on && (
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-d)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Floating green "+" FAB — create a new sales order. */}
      <button onClick={onNew} aria-label="New sales order" className="fab">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
  );
}

/* status → spec badge tone: DRAFT=b-grey · SUBMITTED=b-brand ·
   CONFIRMED=b-green · CANCELLED=b-red. Any other live status reads as b-brand. */
function StatusPill({ status }: { status: string | null }) {
  const s = (status ?? "").toUpperCase();
  const cls =
    s === "DRAFT" ? "b-grey" :
    s === "CANCELLED" ? "b-red" :
    s === "CONFIRMED" ? "b-green" :
    "b-brand";
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : "—";
  return <span className={`badge ${cls}`} style={{ flex: "none" }}>{label}</span>;
}

/* Stock + Delivery-Planning chips (prototype `soFulfilChips`). Rendered ONLY
   when the SO is live (not Draft/Cancelled) AND the row actually carries the
   derived status — never faked. Stock reads the readiness booleans the list
   endpoint emits; planning reads the derived `planning_state`. */
function FulfilChips({ row }: { row: SoRow }) {
  const s = (row.status ?? "").toLowerCase();
  if (s === "draft" || s === "cancelled") return null;

  const stock: [string, string, string] | null =
    row.is_fully_ready ? ["Ready", "var(--green-bg)", "var(--green)"] :
    (row.is_main_ready || (row.ready_categories?.length ?? 0) > 0) ? ["Partial", "var(--amber-bg)", "var(--amber)"] :
    null;

  const ps = (row.planning_state ?? "").toUpperCase();
  const plan: [string, string, string] | null =
    ps === "DELIVERED" ? ["Delivered", "var(--green-bg)", "var(--green)"] :
    ps === "PENDING_SCHEDULE" ? ["Pending schedule", "var(--amber-bg)", "var(--amber)"] :
    ps === "OVERDUE" ? ["Overdue", "var(--red-bg)", "var(--red)"] :
    null;

  if (!stock && !plan) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
      {stock && <Chip label={stock[0]} bg={stock[1]} fg={stock[2]} />}
      {plan && <Chip label={plan[0]} bg={plan[1]} fg={plan[2]} />}
    </div>
  );
}

function Chip({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: bg, color: fg, whiteSpace: "nowrap" }}>{label}</span>
  );
}
