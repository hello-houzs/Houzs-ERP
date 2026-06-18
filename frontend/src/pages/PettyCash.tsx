import { useMemo, useState } from "react";
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
  // Cash-flow chart drill-down: clicking a month sets the from/to window to
  // that whole month (click again to clear).
  const activeMonth =
    from && to && from.slice(0, 7) === to.slice(0, 7) && from.endsWith("-01")
      ? from.slice(0, 7)
      : "";
  function toggleMonth(m: string) {
    const next = new URLSearchParams(params);
    if (activeMonth === m) {
      next.delete("from");
      next.delete("to");
    } else {
      const [y, mm] = m.split("-").map(Number);
      const last = new Date(y, mm, 0).getDate();
      next.set("from", `${m}-01`);
      next.set("to", `${m}-${String(last).padStart(2, "0")}`);
    }
    setParams(next, { replace: true });
  }

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
  const monthly = useMemo(() => {
    const m = new Map<string, { in: number; out: number }>();
    for (const r of rows) {
      const key = r.occurred_on.slice(0, 7);
      const cur = m.get(key) || { in: 0, out: 0 };
      if (r.direction === "in") cur.in += r.amount_cents;
      else cur.out += r.amount_cents;
      m.set(key, cur);
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([month, v]) => ({ month, ...v }));
  }, [rows]);

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
          subtitle={direction === "in" ? "Showing inflow · tap to clear" : "Top-ups, refunds"}
          tone={direction === "in" ? "success" : "default"}
          onClick={() => setFilter("direction", direction === "in" ? "" : "in")}
        />
        <StatCard
          label={qs ? "Outflow (filtered)" : "Total outflow"}
          value={summary ? formatRM(qs ? summary.filtered_out_cents : summary.total_out_cents) : "—"}
          subtitle={direction === "out" ? "Showing outflow · tap to clear" : "Purchases, expenses"}
          tone={direction === "out" ? "error" : "default"}
          onClick={() => setFilter("direction", direction === "out" ? "" : "out")}
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

      {/* C — cash flow trend (in vs out over recent months) */}
      <CashFlowTrend
        data={monthly}
        activeMonth={activeMonth}
        onMonthClick={toggleMonth}
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
            className="ml-auto inline-flex items-center gap-1 rounded text-[10px] font-semibold uppercase tracking-brand text-ink-muted transition-colors hover:text-accent"
          >
            <X size={11} /> Clear
          </button>
        )}
      </div>

      {/* Ledger */}
      <DataTable
        tableId="petty-cash"
        columns={columns}
        rows={list.data ? displayRows : null}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        emptyLabel={canPost ? "No entries yet — click 'New entry' to log one." : "No entries yet."}
        exportName="petty-cash"
        caption="Ledger"
      />

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

function CashFlowTrend({
  data,
  activeMonth,
  onMonthClick,
}: {
  data: Array<{ month: string; in: number; out: number }>;
  activeMonth?: string;
  onMonthClick?: (month: string) => void;
}) {
  const max = Math.max(1, ...data.flatMap((d) => [d.in, d.out]));
  const monthLabel = (m: string) => {
    const [y, mm] = m.split("-");
    return new Date(Number(y), Number(mm) - 1, 1).toLocaleDateString("en", {
      month: "short",
    });
  };
  return (
    <div className="relative mb-4 overflow-hidden rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Cash flow · last {data.length || 0} months
        </div>
        <div className="flex items-center gap-3 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-synced" /> In
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-err" /> Out
          </span>
        </div>
      </div>
      {data.length === 0 ? (
        <div className="py-4 text-[12px] text-ink-muted">Not enough data yet</div>
      ) : (
        (() => {
          const n = data.length;
          // Centre points in equal columns so the clickable month strips,
          // dots and labels all line up.
          const xAt = (i: number) => ((i + 0.5) / n) * 100;
          const yAt = (v: number) => 96 - (v / max) * 88; // 4–96 vertical padding
          const pts = (sel: (d: (typeof data)[number]) => number) =>
            data.map((d, i) => `${xAt(i)},${yAt(sel(d))}`).join(" ");
          const area = (sel: (d: (typeof data)[number]) => number) =>
            `${xAt(0)},100 ${pts(sel)} ${xAt(n - 1)},100`;
          const IN = "#3f7d4f";
          const OUT = "#a83232";
          return (
            <div className="relative h-32">
              {/* clickable month strips (behind the chart) */}
              <div className="absolute inset-0 flex gap-1">
                {data.map((d) => (
                  <button
                    key={`hit-${d.month}`}
                    type="button"
                    onClick={() => onMonthClick?.(d.month)}
                    title={`${monthLabel(d.month)} · In ${formatRM(d.in)} · Out ${formatRM(d.out)}`}
                    className={cn(
                      "flex-1 rounded-md transition-colors",
                      onMonthClick && "hover:bg-accent-soft/40",
                      activeMonth === d.month && "bg-accent-soft/60 ring-1 ring-inset ring-accent/30",
                    )}
                  />
                ))}
              </div>
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                <polygon points={area((d) => d.in)} fill={IN} opacity={0.08} />
                <polygon points={area((d) => d.out)} fill={OUT} opacity={0.07} />
                <polyline
                  points={pts((d) => d.in)}
                  fill="none"
                  stroke={IN}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <polyline
                  points={pts((d) => d.out)}
                  fill="none"
                  stroke={OUT}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {/* round dots (HTML, so they stay circular under the stretch) */}
              {data.map((d, i) => (
                <span
                  key={`in-${d.month}`}
                  className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-surface bg-synced"
                  style={{ left: `${xAt(i)}%`, top: `${yAt(d.in)}%` }}
                  title={`${monthLabel(d.month)} · In ${formatRM(d.in)}`}
                />
              ))}
              {data.map((d, i) => (
                <span
                  key={`out-${d.month}`}
                  className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-surface bg-err"
                  style={{ left: `${xAt(i)}%`, top: `${yAt(d.out)}%` }}
                  title={`${monthLabel(d.month)} · Out ${formatRM(d.out)}`}
                />
              ))}
              {/* month axis */}
              {data.map((d, i) => (
                <span
                  key={`lbl-${d.month}`}
                  className="pointer-events-none absolute bottom-0 -translate-x-1/2 font-mono text-[9px] text-ink-muted"
                  style={{ left: `${xAt(i)}%` }}
                >
                  {monthLabel(d.month)}
                </span>
              ))}
            </div>
          );
        })()
      )}
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
