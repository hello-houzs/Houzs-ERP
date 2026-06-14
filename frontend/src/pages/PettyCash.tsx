import { useMemo, useState } from "react";
import {
  Wallet,
  Plus,
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
import { StatCard } from "../components/StatCard";
import { DashboardGrid } from "../components/Dashboard";
import { EmptyState } from "../components/EmptyState";
import { ListSkeleton } from "../components/Skeleton";
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

const FILTER_KEYS = ["from", "to", "direction", "category"] as const;

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

  const summary = list.data?.summary;

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
              <button
                onClick={() => setAddOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-all hover:bg-accent/90 active:scale-95"
              >
                <Plus size={13} /> New entry
              </button>
            )}
          </div>
        }
      />

      <DashboardGrid cols={3}>
        <StatCard
          label="Cash on hand"
          value={summary ? formatRM(summary.balance_cents) : "—"}
          subtitle={
            summary
              ? `${summary.count} entries${qs ? " (filtered)" : ""}`
              : "Loading…"
          }
          tone="success"
        />
        <StatCard
          label={qs ? "Inflow (filtered)" : "Total inflow"}
          value={summary ? formatRM(qs ? summary.filtered_in_cents : summary.total_in_cents) : "—"}
          subtitle="Top-ups, refunds"
        />
        <StatCard
          label={qs ? "Outflow (filtered)" : "Total outflow"}
          value={summary ? formatRM(qs ? summary.filtered_out_cents : summary.total_out_cents) : "—"}
          subtitle="Purchases, expenses"
        />
      </DashboardGrid>

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
        {qs && (
          <button
            onClick={() => clearAll()}
            className="ml-auto inline-flex items-center gap-1 rounded text-[10px] font-semibold uppercase tracking-brand text-ink-muted transition-colors hover:text-accent"
          >
            <X size={11} /> Clear
          </button>
        )}
      </div>

      {/* Ledger */}
      {list.loading ? (
        <ListSkeleton rows={6} />
      ) : list.error ? (
        <EmptyState icon={<Wallet size={20} />} message="Couldn't load ledger" description={list.error} />
      ) : (list.data?.rows ?? []).length === 0 ? (
        <EmptyState
          icon={<Wallet size={20} />}
          message="No entries"
          description={
            canPost
              ? "Click 'New entry' to log a top-up or expense."
              : "Nothing here yet."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          <ul className="divide-y divide-border-subtle">
            {(list.data?.rows ?? []).map((r) => (
              <EntryRowItem
                key={r.id}
                row={r}
                canManage={canManage}
                onChange={() => list.reload()}
              />
            ))}
          </ul>
        </div>
      )}

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
    </div>
  );
}

function EntryRowItem({
  row,
  canManage,
  onChange,
}: {
  row: EntryRow;
  canManage: boolean;
  onChange: () => void;
}) {
  const toast = useToast();
  const isIn = row.direction === "in";
  const Icon = isIn ? ArrowDownCircle : ArrowUpCircle;

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
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-bg/40 sm:flex-nowrap">
      <Icon
        size={20}
        className={cn(
          "shrink-0",
          isIn ? "text-synced" : "text-err",
        )}
      />
      <div className="min-w-0 flex-1 basis-[60%] sm:basis-auto">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-[11px] font-semibold text-ink-secondary">
            {row.occurred_on}
          </span>
          {row.category && (
            <span className="rounded-full bg-accent-soft/60 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-accent-ink">
              {row.category}
            </span>
          )}
          {row.counterparty && (
            <span className="truncate text-[12.5px] font-semibold text-ink">
              {row.counterparty}
            </span>
          )}
        </div>
        {row.note && (
          <div className="mt-0.5 truncate text-[11px] text-ink-secondary">
            {row.note}
          </div>
        )}
        <div className="mt-0.5 text-[10px] text-ink-muted">
          {row.posted_by_name || `User #${row.posted_by}`} · {relativeTime(row.created_at)}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span
          className={cn(
            "font-mono text-[14px] font-extrabold",
            isIn ? "text-synced" : "text-err",
          )}
        >
          {isIn ? "+" : "−"}
          {formatRM(row.amount_cents)}
        </span>
        {row.receipt_r2_key && (
          <button
            onClick={viewReceipt}
            className="rounded p-1 text-ink-muted transition-colors hover:bg-bg/60 hover:text-accent"
            title="View receipt"
          >
            <Receipt size={14} />
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
    </li>
  );
}

function AddEntryModal({
  onClose,
  onSuccess,
  knownCategories,
}: {
  onClose: () => void;
  onSuccess: () => void;
  knownCategories: string[];
}) {
  const toast = useToast();
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [note, setNote] = useState("");
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10));
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
      const created = await api.post<{ row: EntryRow }>("/api/petty-cash", {
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
            `/api/petty-cash/${created.row.id}/receipt?name=${encodeURIComponent(receipt.name)}`,
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New petty cash entry"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
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
              New entry
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
              Receipt photo (optional)
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
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-border bg-surface py-2 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !amount}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-all hover:bg-accent/90 active:scale-95",
                (busy || !amount) && "cursor-not-allowed opacity-50",
              )}
            >
              <Plus size={13} /> {busy ? "Posting…" : "Post entry"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
