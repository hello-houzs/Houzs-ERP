import { useMemo, useRef, useState } from "react";
import {
  Plus,
  Pencil,
  ArrowDownCircle,
  ArrowUpCircle,
  Receipt,
  Trash2,
  X,
  Filter,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { StatCard } from "../components/StatCard";
import { DashboardBreakdown, DashboardPanels } from "../components/Dashboard";
import { DataTable, type Column } from "../components/DataTable";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../auth/AuthContext";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";

interface EntryRow {
  id: number;
  direction: "in" | "out";
  amount_cents: number;
  category: string | null;
  counterparty: string | null;
  note: string | null;
  receipt_r2_key: string | null;
  occurred_on: string;
  posted_by: number;
  posted_by_name: string | null;
  created_at: string;
}

interface Summary {
  balance_cents: number;
  total_in_cents: number;
  total_out_cents: number;
  filtered_in_cents: number;
  filtered_out_cents: number;
  count: number;
}

const FILTER_KEYS = ["from", "to", "direction", "category", "payee"] as const;

function formatRM(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const v = Math.abs(cents) / 100;
  return `${sign}RM ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PettyCash() {
  const { user } = useAuth();
  const toast = useToast();
  const canPost = !!user?.permissions?.some(
    (p) => p === "petty_cash.post" || p === "*",
  );
  const canManage = !!user?.permissions?.some(
    (p) => p === "petty_cash.manage" || p === "*",
  );

  const [params, setParams] = useStickyFilters("petty-cash", FILTER_KEYS);
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const direction = params.get("direction") || "";
  const category = params.get("category") || "";
  // Payee is a client-side drill-down (no backend param) — filters the
  // visible ledger rows by counterparty.
  const payee = params.get("payee") || "";

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }
  function clearAll() {
    const next = new URLSearchParams(params);
    for (const k of FILTER_KEYS) next.delete(k);
    setParams(next, { replace: true });
  }

  // Ledger anchor — clicking the Inflow / Outflow KPI cards filters the
  // ledger by direction AND scrolls it into view so the matching details
  // surface immediately.
  const ledgerRef = useRef<HTMLDivElement>(null);
  function drillDirection(dir: "in" | "out") {
    const next = direction === dir ? "" : dir;
    setFilter("direction", next);
    if (next) {
      setTimeout(
        () => ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        60,
      );
    }
  }
  // Cash-flow chart is collapsible (persisted) — it's the tallest block and
  // ops often just want the ledger.
  const [cashflowOpen, setCashflowOpen] = useLocalStorage<boolean>("pc:cashflow", true);
  // Cash-flow granularity: month / quarter / half-year (persisted).
  const [granularity, setGranularity] = useLocalStorage<Gran>("pc:cashflow:gran", "month");
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (direction) p.set("direction", direction);
    if (category) p.set("category", category);
    return p.toString();
  }, [from, to, direction, category]);

  const list = useQuery<{ rows: EntryRow[]; summary: Summary }>(
    () => api.get(`/api/petty-cash${qs ? `?${qs}` : ""}`),
    [qs],
  );

  const cats = useQuery<{ rows: { category: string; uses: number }[] }>(
    () => api.get("/api/petty-cash/categories"),
  );

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<EntryRow | null>(null);

  const summary = list.data?.summary;
  const rows = list.data?.rows ?? [];
  // Rows actually shown in the ledger — narrowed by the payee drill-down.
  const displayRows = payee
    ? rows.filter((r) => (r.counterparty || "Unspecified") === payee)
    : rows;

  // Derived insights (client-side, from the current filtered rows).
  const topOut = (
    by: (r: EntryRow) => string | null,
    fallback: string,
  ): Array<{ label: string; count: number }> => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (r.direction !== "out") continue;
      const k = (by(r) || fallback).trim() || fallback;
      m.set(k, (m.get(k) || 0) + r.amount_cents);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => ({ label, count }));
  };
  const byCategory = useMemo(() => topOut((r) => r.category, "Uncategorized"), [rows]);
  const byPayee = useMemo(() => topOut((r) => r.counterparty, "Unspecified"), [rows]);
  // Cash-flow series, bucketed by the chosen granularity. Net is the
  // running cumulative (in − out) across ALL buckets (computed before the
  // window slice) so each plotted point reflects the true cumulative
  // position, then we keep the last N for display.
  const periods = useMemo(() => {
    const m = new Map<string, { in: number; out: number }>();
    for (const r of rows) {
      const key = pcPeriodKey(r.occurred_on, granularity);
      const cur = m.get(key) || { in: 0, out: 0 };
      if (r.direction === "in") cur.in += r.amount_cents;
      else cur.out += r.amount_cents;
      m.set(key, cur);
    }
    const ordered = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let run = 0;
    const withNet = ordered.map(([key, v]) => {
      run += v.in - v.out;
      return { key, label: pcPeriodLabel(key, granularity), in: v.in, out: v.out, net: run };
    });
    const cap = granularity === "month" ? 12 : granularity === "quarter" ? 8 : 6;
    return withNet.slice(-cap);
  }, [rows, granularity]);

  // Cash-flow chart drill-down: clicking a period sets the from/to window to
  // that whole period (click again to clear).
  const activePeriodKey = useMemo(() => {
    if (!from || !to) return "";
    for (const p of periods) {
      const r = pcPeriodRange(p.key, granularity);
      if (r.from === from && r.to === to) return p.key;
    }
    return "";
  }, [from, to, periods, granularity]);
  function togglePeriod(key: string) {
    const next = new URLSearchParams(params);
    if (activePeriodKey === key) {
      next.delete("from");
      next.delete("to");
    } else {
      const r = pcPeriodRange(key, granularity);
      next.set("from", r.from);
      next.set("to", r.to);
    }
    setParams(next, { replace: true });
  }

  const columns: Column<EntryRow>[] = [
    {
      key: "occurred_on",
      label: "Date",
      getValue: (r) => r.occurred_on,
      render: (r) => (
        <span className="font-mono text-[11px] font-semibold text-ink-secondary">
          {r.occurred_on}
        </span>
      ),
    },
    {
      key: "direction",
      label: "Type",
      getValue: (r) => r.direction,
      render: (r) => <DirBadge dir={r.direction} />,
    },
    {
      key: "category",
      label: "Category",
      getValue: (r) => r.category ?? "",
      render: (r) =>
        r.category ? (
          <span className="rounded-full bg-accent-soft/60 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-accent-ink">
            {r.category}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "counterparty",
      label: "Source / Payee",
      getValue: (r) => r.counterparty ?? "",
      render: (r) => (
        <span className="text-[12px] font-semibold text-ink">
          {r.counterparty || "—"}
        </span>
      ),
    },
    {
      key: "note",
      label: "Note",
      getValue: (r) => r.note ?? "",
      render: (r) => (
        <span className="text-[11.5px] text-ink-secondary">{r.note || "—"}</span>
      ),
    },
    {
      key: "posted_by",
      label: "Posted by",
      getValue: (r) => r.posted_by_name ?? "",
      render: (r) => (
        <span className="text-[10.5px] text-ink-muted">
          {r.posted_by_name || `User #${r.posted_by}`} · {relativeTime(r.created_at)}
        </span>
      ),
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      getValue: (r) => (r.direction === "in" ? r.amount_cents : -r.amount_cents),
      render: (r) => (
        <span
          className={cn(
            "font-mono text-[13px] font-extrabold",
            r.direction === "in" ? "text-synced" : "text-err",
          )}
        >
          {r.direction === "in" ? "+" : "−"}
          {formatRM(r.amount_cents)}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => {
        // Posters can edit their own entry within 24 h; managers anytime
        // (mirrors the PATCH endpoint's rule).
        const fresh =
          Date.now() - new Date(r.created_at).getTime() < 24 * 3600 * 1000;
        const canEdit = canManage || (r.posted_by === user?.id && fresh);
        return (
          <LedgerRowActions
            row={r}
            canManage={canManage}
            canEdit={canEdit}
            onEdit={() => setEditing(r)}
            onChange={() => list.reload()}
          />
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Finance"
        title="Petty Cash"
        description="Office float ledger — every cash in and out, with running balance and receipts."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<RefreshCw size={13} className={list.loading ? "animate-spin" : ""} />}
              onClick={() => list.reload()}
              disabled={list.loading}
            >
              Refresh
            </Button>
            {canPost && (
              <Button onClick={() => setAddOpen(true)} icon={<Plus size={13} />}>
                New entry
              </Button>
            )}
          </div>
        }
      />

      {/* D — KPI hero: prominent live balance + supporting metrics */}
      <div className="mb-4 grid gap-3 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="relative overflow-hidden rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
          <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent to-transparent" />
          <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Cash on hand
          </div>
          <div className="mt-2 font-display text-[34px] font-extrabold leading-none tracking-tight text-synced">
            {summary ? formatRM(summary.balance_cents) : "—"}
          </div>
          <div className="mt-2 text-[11px] font-medium text-ink-secondary">
            {summary
              ? `${summary.count} ${summary.count === 1 ? "entry" : "entries"}${qs ? " in view" : ""} · live float balance`
              : "Loading…"}
          </div>
        </div>
        <StatCard
          label={qs ? "Inflow (filtered)" : "Total inflow"}
          value={summary ? formatRM(qs ? summary.filtered_in_cents : summary.total_in_cents) : "—"}
          subtitle={direction === "in" ? "Showing inflow · tap to clear" : "Top-ups, refunds · tap for details"}
          tone={direction === "in" ? "success" : "default"}
          active={direction === "in"}
          onClick={() => drillDirection("in")}
        />
        <StatCard
          label={qs ? "Outflow (filtered)" : "Total outflow"}
          value={summary ? formatRM(qs ? summary.filtered_out_cents : summary.total_out_cents) : "—"}
          subtitle={direction === "out" ? "Showing outflow · tap to clear" : "Purchases, expenses · tap for details"}
          tone={direction === "out" ? "error" : "default"}
          active={direction === "out"}
          onClick={() => drillDirection("out")}
        />
        <StatCard
          label={qs ? "Net (filtered)" : "Net position"}
          value={
            summary
              ? formatRM(
                  (qs ? summary.filtered_in_cents : summary.total_in_cents) -
                    (qs ? summary.filtered_out_cents : summary.total_out_cents),
                )
              : "—"
          }
          subtitle="In − Out"
          tone={
            summary &&
            (qs ? summary.filtered_in_cents : summary.total_in_cents) -
              (qs ? summary.filtered_out_cents : summary.total_out_cents) <
              0
              ? "error"
              : "success"
          }
        />
      </div>

      {/* C — cash flow trend (in / out / net over recent periods), collapsible */}
      <CashFlowTrend
        data={periods}
        granularity={granularity}
        onGranularity={setGranularity}
        activeKey={activePeriodKey}
        onPeriodClick={togglePeriod}
        open={cashflowOpen}
        onToggle={() => setCashflowOpen(!cashflowOpen)}
      />

      {/* A + B — spend breakdowns (click a row to drill into the ledger) */}
      <DashboardPanels cols={2}>
        <DashboardBreakdown
          title="Spend by category"
          items={byCategory}
          formatCount={formatRM}
          emptyLabel="No outflow recorded yet"
          activeLabel={category}
          onItemClick={(c) => setFilter("category", category === c ? "" : c)}
        />
        <DashboardBreakdown
          title="Top payees"
          items={byPayee}
          formatCount={formatRM}
          emptyLabel="No payees recorded yet"
          activeLabel={payee}
          onItemClick={(p) => setFilter("payee", payee === p ? "" : p)}
        />
      </DashboardPanels>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-stone">
        <Filter size={13} className="text-ink-muted" />
        <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Filter
        </span>
        <input
          type="date"
          value={from}
          onChange={(e) => setFilter("from", e.target.value)}
          className="rounded border border-border bg-paper px-2 py-1 font-mono text-[11px]"
          aria-label="From date"
        />
        <span className="text-[10px] text-ink-muted">→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setFilter("to", e.target.value)}
          className="rounded border border-border bg-paper px-2 py-1 font-mono text-[11px]"
          aria-label="To date"
        />
        <select
          value={direction}
          onChange={(e) => setFilter("direction", e.target.value)}
          className="rounded border border-border bg-paper px-2 py-1 text-[11px]"
        >
          <option value="">All types</option>
          <option value="in">Inflow only</option>
          <option value="out">Outflow only</option>
        </select>
        <select
          value={category}
          onChange={(e) => setFilter("category", e.target.value)}
          className="rounded border border-border bg-paper px-2 py-1 text-[11px]"
        >
          <option value="">All categories</option>
          {(cats.data?.rows ?? []).map((c) => (
            <option key={c.category} value={c.category}>
              {c.category}
            </option>
          ))}
        </select>
        {payee && (
          <button
            onClick={() => setFilter("payee", "")}
            className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-ink transition-colors hover:bg-accent hover:text-white"
            title="Clear payee filter"
          >
            Payee: {payee} <X size={10} />
          </button>
        )}
        {(qs || payee) && (
          <button
            onClick={() => clearAll()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft/50 px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent hover:text-white"
            title="Clear all filters and show every entry"
          >
            <X size={12} /> Show all
          </button>
        )}
      </div>

      {/* Ledger */}
      <div ref={ledgerRef} className="scroll-mt-4">
        <DataTable
          tableId="petty-cash"
          columns={columns}
          rows={list.data ? displayRows : null}
          loading={list.loading}
          error={list.error}
          getRowKey={(r) => r.id}
          emptyLabel={canPost ? "No entries yet — click 'New entry' to log one." : "No entries yet."}
          exportName="petty-cash"
          caption={
            direction === "in"
              ? "Inflow details"
              : direction === "out"
              ? "Outflow details"
              : "Ledger"
          }
        />
      </div>

      {addOpen && canPost && (
        <AddEntryModal
          onClose={() => setAddOpen(false)}
          onSuccess={() => {
            setAddOpen(false);
            list.reload();
            cats.reload();
            toast.success("Entry posted");
          }}
          knownCategories={(cats.data?.rows ?? []).map((c) => c.category)}
        />
      )}

      {editing && (
        <AddEntryModal
          entry={editing}
          onClose={() => setEditing(null)}
          onSuccess={() => {
            setEditing(null);
            list.reload();
            cats.reload();
            toast.success("Entry updated");
          }}
          knownCategories={(cats.data?.rows ?? []).map((c) => c.category)}
        />
      )}
    </div>
  );
}

// ── Cash-flow chart helpers ───────────────────────────────────
type Gran = "month" | "quarter" | "half";

function pcPeriodKey(iso: string, g: Gran): string {
  const y = iso.slice(0, 4);
  const mm = Number(iso.slice(5, 7));
  if (g === "month") return iso.slice(0, 7);
  if (g === "quarter") return `${y}-Q${Math.ceil(mm / 3)}`;
  return `${y}-H${mm <= 6 ? 1 : 2}`;
}
function pcPeriodRange(key: string, g: Gran): { from: string; to: string } {
  const y = Number(key.slice(0, 4));
  const last = (yr: number, m: number) => new Date(yr, m, 0).getDate();
  const fmt = (yr: number, m: number, d: number) =>
    `${yr}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (g === "month") {
    const m = Number(key.slice(5, 7));
    return { from: fmt(y, m, 1), to: fmt(y, m, last(y, m)) };
  }
  if (g === "quarter") {
    const q = Number(key.slice(6));
    return { from: fmt(y, (q - 1) * 3 + 1, 1), to: fmt(y, q * 3, last(y, q * 3)) };
  }
  const h = Number(key.slice(6));
  return h === 1
    ? { from: fmt(y, 1, 1), to: fmt(y, 6, 30) }
    : { from: fmt(y, 7, 1), to: fmt(y, 12, 31) };
}
function pcPeriodLabel(key: string, g: Gran): string {
  if (g === "month") {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en", { month: "short" });
  }
  return key.slice(5); // "Q2" / "H1"
}
// Catmull-Rom → cubic-bezier smoothing for a soft, report-style curve.
function pcSmooth(pts: Array<[number, number]>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  const out = [`M ${pts[0][0]} ${pts[0][1]}`];
  const t = 0.18;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    out.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`);
  }
  return out.join(" ");
}
function pcNiceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) max = min + 1;
  const raw = (max - min) / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}
function pcTickLabel(v: number): string {
  const a = Math.abs(v);
  const body =
    a >= 10000 ? `${(a / 1000).toFixed(a % 1000 === 0 ? 0 : 1)}k` : Math.round(a).toLocaleString();
  return `${v < 0 ? "−" : ""}RM${body}`;
}

function CashFlowTrend({
  data,
  open = true,
  onToggle,
  granularity,
  onGranularity,
  activeKey,
  onPeriodClick,
}: {
  data: Array<{ key: string; label: string; in: number; out: number; net: number }>;
  open?: boolean;
  onToggle?: () => void;
  granularity: Gran;
  onGranularity: (g: Gran) => void;
  activeKey?: string;
  onPeriodClick?: (key: string) => void;
}) {
  const granWord =
    granularity === "month" ? "monthly" : granularity === "quarter" ? "quarterly" : "half-yearly";
  const NEUTRAL = "#6c7167";
  const IN = "#3f7d4f";
  const OUT = "#a83232";
  const NET = "#111810";
  return (
    <div className={cn("relative mb-4 overflow-hidden rounded-lg border border-border bg-surface px-5 shadow-stone", open ? "py-5" : "py-3")}>
      <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
      <div className={cn("flex flex-wrap items-center justify-between gap-3", open && "mb-4")}>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted transition-colors hover:text-accent"
          aria-expanded={open}
          title={open ? "Collapse cash flow" : "Expand cash flow"}
        >
          <ChevronDown size={13} className={cn("transition-transform", open ? "" : "-rotate-90")} />
          Cash flow
          <span className="font-mono normal-case tracking-normal text-ink-muted/70">· {granWord}</span>
        </button>
        {open && (
          <div className="inline-flex overflow-hidden rounded-md border border-border bg-bg/40 text-[10px] font-semibold">
            {([["month", "Monthly"], ["quarter", "Quarterly"], ["half", "Half-year"]] as const).map(
              ([g, l]) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => onGranularity(g)}
                  aria-pressed={granularity === g}
                  className={cn(
                    "px-2.5 py-1 transition-colors",
                    granularity === g ? "bg-accent text-white" : "text-ink-muted hover:text-accent",
                  )}
                >
                  {l}
                </button>
              ),
            )}
          </div>
        )}
      </div>
      {open && (data.length === 0 ? (
        <div className="py-4 text-[12px] text-ink-muted">Not enough data yet</div>
      ) : data.length === 1 ? (
        // Single period: a lone point reads as "broken" — show a clean
        // In / Out / Net summary instead of a chart.
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3 py-1">
          {([
            [`${data[0].label} · In`, formatRM(data[0].in), "text-synced"],
            [`${data[0].label} · Out`, formatRM(data[0].out), "text-err"],
            ["Net position", formatRM(data[0].net), data[0].net >= 0 ? "text-synced" : "text-err"],
          ] as const).map(([lbl, val, color]) => (
            <div key={lbl}>
              <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted">{lbl}</div>
              <div className={cn("mt-1 font-display text-2xl font-bold leading-none", color)}>{val}</div>
            </div>
          ))}
        </div>
      ) : (
        (() => {
          const W = 720, H = 230, L = 52, R = 14, T = 12, B = 26;
          const iW = W - L - R, iH = H - T - B;
          const n = data.length;
          const ins = data.map((d) => d.in / 100);
          const outs = data.map((d) => -(d.out / 100)); // money out plotted below zero
          const nets = data.map((d) => d.net / 100);
          const ticks = pcNiceTicks(
            Math.min(0, ...outs, ...nets),
            Math.max(0, ...ins, ...nets),
            5,
          );
          const yMin = ticks[0], yMax = ticks[ticks.length - 1];
          const xAt = (i: number) => L + (n === 1 ? iW / 2 : (i / (n - 1)) * iW);
          const yAt = (v: number) => T + ((yMax - v) / (yMax - yMin || 1)) * iH;
          const pts = (arr: number[]): Array<[number, number]> => arr.map((v, i) => [xAt(i), yAt(v)]);
          const areaPath = (arr: number[]) =>
            `${pcSmooth(pts(arr))} L ${xAt(n - 1)} ${yAt(0)} L ${xAt(0)} ${yAt(0)} Z`;
          return (
            <div>
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="aspect-[720/230] w-full">
                <defs>
                  <linearGradient id="pc-in" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={IN} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={IN} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="pc-out" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={OUT} stopOpacity={0.02} />
                    <stop offset="100%" stopColor={OUT} stopOpacity={0.2} />
                  </linearGradient>
                </defs>
                {ticks.map((tk) => {
                  const y = yAt(tk);
                  const zero = Math.abs(tk) < 1e-9;
                  return (
                    <g key={`t-${tk}`}>
                      <line
                        x1={L} y1={y} x2={W - R} y2={y}
                        stroke={zero ? NEUTRAL : "#e6e4da"}
                        strokeWidth={1}
                        strokeDasharray={zero ? "2 3" : undefined}
                      />
                      <text x={L - 8} y={y + 3} textAnchor="end" fill={NEUTRAL} fontSize="10" fontFamily="monospace">
                        {pcTickLabel(tk)}
                      </text>
                    </g>
                  );
                })}
                {data.map((d, i) => {
                  const cx = xAt(i);
                  const half = n === 1 ? iW / 2 : iW / (n - 1) / 2;
                  return (
                    <rect
                      key={`hit-${d.key}`}
                      x={cx - half} y={T} width={half * 2} height={iH}
                      fill={activeKey === d.key ? "rgba(161,106,46,0.10)" : "transparent"}
                      className={cn(onPeriodClick && "cursor-pointer")}
                      onClick={() => onPeriodClick?.(d.key)}
                    >
                      <title>{`${d.label} · In ${formatRM(d.in)} · Out ${formatRM(d.out)} · Net ${formatRM(d.net)}`}</title>
                    </rect>
                  );
                })}
                <path d={areaPath(ins)} fill="url(#pc-in)" />
                <path d={areaPath(outs)} fill="url(#pc-out)" />
                <path d={pcSmooth(pts(ins))} fill="none" stroke={IN} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                <path d={pcSmooth(pts(outs))} fill="none" stroke={OUT} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                <path d={pcSmooth(pts(nets))} fill="none" stroke={NET} strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round" strokeLinecap="round" />
                {pts(ins).map(([x, y], i) => (
                  <circle key={`di-${i}`} cx={x} cy={y} r={3} fill={IN} stroke="#fff" strokeWidth={1.2} />
                ))}
                {pts(outs).map(([x, y], i) => (
                  <circle key={`do-${i}`} cx={x} cy={y} r={3} fill={OUT} stroke="#fff" strokeWidth={1.2} />
                ))}
                {data.map((d, i) => (
                  <text key={`xl-${d.key}`} x={xAt(i)} y={H - 8} textAnchor="middle" fill={NEUTRAL} fontSize="10" fontFamily="monospace">
                    {d.label}
                  </text>
                ))}
              </svg>
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[10px] font-medium text-ink-secondary">
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-sm" style={{ background: IN }} /> Cash inflows</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-sm" style={{ background: OUT }} /> Cash outflows</span>
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: NET }} /> Net cash position</span>
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0 w-4 border-t border-dotted border-ink-muted" /> $0 baseline</span>
              </div>
            </div>
          );
        })()
      ))}
    </div>
  );
}

function DirBadge({ dir }: { dir: "in" | "out" }) {
  const isIn = dir === "in";
  const Icon = isIn ? ArrowDownCircle : ArrowUpCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider",
        isIn ? "bg-synced/10 text-synced" : "bg-err/10 text-err",
      )}
    >
      <Icon size={11} />
      {isIn ? "In" : "Out"}
    </span>
  );
}

function LedgerRowActions({
  row,
  canManage,
  canEdit,
  onEdit,
  onChange,
}: {
  row: EntryRow;
  canManage: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onChange: () => void;
}) {
  const toast = useToast();

  async function remove() {
    if (!confirm("Archive this entry? It will stop counting toward the balance.")) return;
    try {
      await api.del(`/api/petty-cash/${row.id}`);
      toast.success("Archived");
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Archive failed");
    }
  }

  async function viewReceipt() {
    if (!row.receipt_r2_key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/petty-cash/${row.id}/receipt`);
      window.open(url, "_blank");
    } catch (e: any) {
      toast.error(e?.message || "Couldn't load receipt");
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {row.receipt_r2_key && (
        <button
          onClick={viewReceipt}
          className="rounded p-1 text-ink-muted transition-colors hover:bg-bg/60 hover:text-accent"
          title="View receipt"
        >
          <Receipt size={14} />
        </button>
      )}
      {canEdit && (
        <button
          onClick={onEdit}
          className="rounded p-1 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
          title="Edit entry"
        >
          <Pencil size={14} />
        </button>
      )}
      {canManage && (
        <button
          onClick={remove}
          className="rounded p-1 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
          title="Archive"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function AddEntryModal({
  onClose,
  onSuccess,
  knownCategories,
  entry,
}: {
  onClose: () => void;
  onSuccess: () => void;
  knownCategories: string[];
  /** When set, the modal edits this entry instead of creating a new one. */
  entry?: EntryRow;
}) {
  const toast = useToast();
  const isEdit = !!entry;
  const [direction, setDirection] = useState<"in" | "out">(entry?.direction ?? "out");
  const [amount, setAmount] = useState(
    entry ? (entry.amount_cents / 100).toFixed(2) : "",
  );
  const [category, setCategory] = useState(entry?.category ?? "");
  const [counterparty, setCounterparty] = useState(entry?.counterparty ?? "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [occurredOn, setOccurredOn] = useState(
    entry?.occurred_on ?? new Date().toISOString().slice(0, 10),
  );
  const [receipt, setReceipt] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      toast.error("Amount must be greater than 0");
      return;
    }
    setBusy(true);
    try {
      const saved = isEdit
        ? await api.patch<{ row: EntryRow }>(`/api/petty-cash/${entry!.id}`, {
            direction,
            amount_cents: cents,
            category: category.trim() || null,
            counterparty: counterparty.trim() || null,
            note: note.trim() || null,
            occurred_on: occurredOn,
          })
        : await api.post<{ row: EntryRow }>("/api/petty-cash", {
            direction,
            amount_cents: cents,
            category: category.trim() || undefined,
            counterparty: counterparty.trim() || undefined,
            note: note.trim() || undefined,
            occurred_on: occurredOn,
          });
      if (receipt) {
        try {
          await api.putBinary(
            `/api/petty-cash/${saved.row.id}/receipt?name=${encodeURIComponent(receipt.name)}`,
            receipt,
            receipt.type || "application/octet-stream",
          );
        } catch (e: any) {
          toast.error(`Entry saved but receipt upload failed: ${e?.message || ""}`);
        }
      }
      onSuccess();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} aria-label="New petty cash entry">
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface shadow-slab animate-rise"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              Petty cash
            </div>
            <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
              {isEdit ? "Edit entry" : "New entry"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-muted hover:bg-bg/60 hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          {/* Direction toggle */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setDirection("in")}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md border py-2 text-[12px] font-bold uppercase tracking-wide transition-all",
                direction === "in"
                  ? "border-synced bg-synced/10 text-synced"
                  : "border-border bg-surface text-ink-muted hover:border-synced/50",
              )}
            >
              <ArrowDownCircle size={14} /> Cash in
            </button>
            <button
              type="button"
              onClick={() => setDirection("out")}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md border py-2 text-[12px] font-bold uppercase tracking-wide transition-all",
                direction === "out"
                  ? "border-err bg-err/10 text-err"
                  : "border-border bg-surface text-ink-muted hover:border-err/50",
              )}
            >
              <ArrowUpCircle size={14} /> Cash out
            </button>
          </div>

          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Amount (RM)
            </span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 font-mono text-[16px] font-bold"
              autoFocus
              required
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Date
              </span>
              <input
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
                className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 font-mono text-[12px]"
                required
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Category
              </span>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value.slice(0, 60))}
                placeholder={
                  direction === "in" ? "Top-up" : "Office supplies"
                }
                list="petty-cash-cats"
                className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
              />
              <datalist id="petty-cash-cats">
                {knownCategories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              {direction === "in" ? "Source" : "Payee"}
            </span>
            <input
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value.slice(0, 120))}
              placeholder={
                direction === "in"
                  ? "Reimbursement from accounts"
                  : "Mr DIY / 7-Eleven / driver"
              }
              className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Note (optional)
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 280))}
              rows={2}
              placeholder="What was it for?"
              className="thin-scroll mt-0.5 w-full resize-none rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              {isEdit
                ? entry?.receipt_r2_key
                  ? "Replace receipt (optional)"
                  : "Add receipt (optional)"
                : "Receipt photo (optional)"}
            </span>
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
              className="mt-0.5 w-full text-[11px]"
            />
            {receipt && (
              <span className="mt-0.5 block text-[10px] text-ink-muted">
                {receipt.name} · {(receipt.size / 1024).toFixed(0)} KB
              </span>
            )}
          </label>

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !amount}
              className="flex-1"
              icon={isEdit ? undefined : <Plus size={13} />}
            >
              {busy
                ? isEdit
                  ? "Saving…"
                  : "Posting…"
                : isEdit
                ? "Save changes"
                : "Post entry"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
