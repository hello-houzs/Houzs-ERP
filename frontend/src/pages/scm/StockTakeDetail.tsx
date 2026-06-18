import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shapes from GET /api/scm/stock-takes/:id — snake_case, verbatim from
// the Hono route (backend/src/scm/routes/stock-takes.ts `stockTakes.get('/:id')`).
// It returns { take, lines }: the header carries the warehouse join and the
// scope/lifecycle fields; each line carries the snapshotted system_qty, the
// commander-entered counted_qty (null = untouched), and the DB-generated
// variance.
interface StockTakeHeader {
  id: string;
  take_no: string;
  status: string;
  warehouse_id: string;
  scope_type: string;
  scope_value: string | null;
  take_date: string | null;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
  warehouse: { id: string; code: string; name: string } | null;
}

interface StockTakeLine {
  id: string;
  stock_take_id: string;
  product_code: string;
  product_name: string | null;
  system_qty: number;
  counted_qty: number | null;
  variance: number | null;
  notes: string | null;
  created_at: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function scopeLabel(scopeType: string, scopeValue: string | null): string {
  if (scopeType === "ALL") return "All SKUs";
  if (scopeType === "CATEGORY") return `Category · ${scopeValue ?? "—"}`;
  if (scopeType === "CODE_PREFIX") return `Prefix · ${scopeValue ?? "—"}`;
  return scopeType;
}

// Counted qty is null when the line was never touched; a posted/zero variance
// renders muted, found stock (positive) green, lost stock (negative) red. No
// new colour tokens beyond the synced/err semantics already in the palette.
function VarianceText({ value }: { value: number | null }) {
  if (value == null) return <span className="font-mono text-ink-muted">—</span>;
  if (value === 0) return <span className="font-mono text-ink-muted">0</span>;
  return (
    <span className={cn("font-mono font-semibold", value > 0 ? "text-synced" : "text-err")}>
      {value > 0 ? "+" : ""}
      {value.toLocaleString("en-MY")}
    </span>
  );
}

export function ScmStockTakeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const detail = useQuery<{ take: StockTakeHeader; lines: StockTakeLine[] }>(
    () => api.get(`${SCM}/stock-takes/${id}`),
    [id],
  );

  const take = detail.data?.take;
  const lines = detail.data?.lines ?? null;

  // Client-side filter over the loaded count sheet (by code / name). The
  // detail endpoint returns the full line set in one shot, so this is a pure
  // in-memory narrow — totals below are always computed off the unfiltered set.
  const q = search.trim().toLowerCase();
  const filteredLines =
    lines && q
      ? lines.filter(
          (l) =>
            l.product_code.toLowerCase().includes(q) ||
            (l.product_name ?? "").toLowerCase().includes(q),
        )
      : lines;

  // Variance aggregates — mirrors 2990's variance summary. A line counts toward
  // the totals only once counted_qty is set (null = untouched, skipped on post).
  const totals = useMemo(() => {
    let counted = 0;
    let untouched = 0;
    let variancePos = 0;
    let varianceNeg = 0;
    let nonZeroVarianceLines = 0;
    for (const l of lines ?? []) {
      if (l.counted_qty == null) {
        untouched += 1;
        continue;
      }
      counted += 1;
      const v = l.variance ?? l.counted_qty - l.system_qty;
      if (v > 0) variancePos += v;
      if (v < 0) varianceNeg += v;
      if (v !== 0) nonZeroVarianceLines += 1;
    }
    return {
      totalLines: (lines ?? []).length,
      counted,
      untouched,
      variancePos,
      varianceNeg,
      varianceNet: variancePos + varianceNeg,
      nonZeroVarianceLines,
    };
  }, [lines]);

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/stock-takes")} />
        <EmptyState message="Failed to load stock take" description={detail.error} />
      </div>
    );
  }

  const lineCols: Column<StockTakeLine>[] = [
    {
      key: "product_code",
      label: "SKU",
      render: (l) => <span className="font-mono text-[12px]">{l.product_code}</span>,
      getValue: (l) => l.product_code,
    },
    {
      key: "product_name",
      label: "Name",
      render: (l) => l.product_name || "—",
      getValue: (l) => l.product_name || "",
    },
    {
      key: "system_qty",
      label: "System Qty",
      align: "right",
      render: (l) => <span className="font-mono">{l.system_qty.toLocaleString("en-MY")}</span>,
      getValue: (l) => l.system_qty,
    },
    {
      key: "counted_qty",
      label: "Counted Qty",
      align: "right",
      render: (l) =>
        l.counted_qty == null ? (
          <span className="font-mono text-ink-muted">—</span>
        ) : (
          <span className="font-mono">{l.counted_qty.toLocaleString("en-MY")}</span>
        ),
      getValue: (l) => l.counted_qty ?? -1,
    },
    {
      key: "variance",
      label: "Variance",
      align: "right",
      render: (l) => (
        <VarianceText value={l.counted_qty == null ? null : l.variance ?? l.counted_qty - l.system_qty} />
      ),
      getValue: (l) => (l.counted_qty == null ? 0 : l.variance ?? l.counted_qty - l.system_qty),
    },
    {
      key: "notes",
      label: "Notes",
      defaultHidden: true,
      render: (l) => l.notes || "—",
      getValue: (l) => l.notes || "",
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/stock-takes")} />
      <PageHeader
        eyebrow={take ? `Stock Take · ${take.take_no}` : "Stock Take"}
        title={take?.take_no ?? (detail.loading ? "Loading…" : "Stock Take")}
      />

      {/* Variance summary tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Kpi label="Total Lines" value={lines ? String(totals.totalLines) : "—"} loading={detail.loading} />
        <Kpi label="Counted" value={lines ? String(totals.counted) : "—"} loading={detail.loading} />
        <Kpi
          label="Untouched"
          value={lines ? String(totals.untouched) : "—"}
          tone={totals.untouched > 0 ? "muted" : undefined}
          loading={detail.loading}
        />
        <Kpi
          label="Found"
          value={lines ? `+${totals.variancePos.toLocaleString("en-MY")}` : "—"}
          tone={totals.variancePos > 0 ? "positive" : "muted"}
          loading={detail.loading}
        />
        <Kpi
          label="Lost"
          value={lines ? totals.varianceNeg.toLocaleString("en-MY") : "—"}
          tone={totals.varianceNeg < 0 ? "negative" : "muted"}
          loading={detail.loading}
        />
        <Kpi
          label="Net Variance"
          value={
            lines
              ? `${totals.varianceNet > 0 ? "+" : ""}${totals.varianceNet.toLocaleString("en-MY")}`
              : "—"
          }
          tone={totals.varianceNet > 0 ? "positive" : totals.varianceNet < 0 ? "negative" : undefined}
          loading={detail.loading}
        />
      </div>

      {/* Master record */}
      {take && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Setup</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(take.status),
              )}
            >
              {statusLabel(take.status)}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Take No." value={take.take_no} mono />
            <Info
              label="Warehouse"
              value={take.warehouse ? `${take.warehouse.code} · ${take.warehouse.name}` : take.warehouse_id}
            />
            <Info label="Scope" value={scopeLabel(take.scope_type, take.scope_value)} />
            <Info label="Take Date" value={fmtDate(take.take_date)} />
            <Info label="Created" value={fmtDateTime(take.created_at)} />
            <Info label="Posted" value={take.posted_at ? fmtDateTime(take.posted_at) : "—"} />
            <Info label="Cancelled" value={take.cancelled_at ? fmtDateTime(take.cancelled_at) : "—"} />
          </dl>
          {take.notes && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {take.notes}
            </div>
          )}
        </div>
      )}

      {/* Count sheet */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Count Sheet{lines ? ` (${lines.length})` : ""}
        </h3>
      </div>
      <DataTable
        tableId="scm_stock_take_lines"
        columns={lineCols}
        rows={filteredLines}
        loading={detail.loading}
        getRowKey={(l) => l.id}
        getRowClassName={(l) =>
          l.counted_qty != null && (l.variance ?? l.counted_qty - l.system_qty) !== 0
            ? "bg-err/[0.03]"
            : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Filter by SKU / name…",
        }}
        emptyLabel={lines && lines.length > 0 ? "No lines match the search" : "No lines on this stock take"}
        exportName="stock-take-lines"
      />
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
    >
      <ArrowLeft size={14} />
      Stock Takes
    </button>
  );
}

type KpiTone = "positive" | "negative" | "muted";

function Kpi({
  label,
  value,
  tone,
  loading,
}: {
  label: string;
  value: string;
  tone?: KpiTone;
  loading?: boolean;
}) {
  const valueColor =
    tone === "positive"
      ? "text-synced"
      : tone === "negative"
        ? "text-err"
        : tone === "muted"
          ? "text-ink-muted"
          : "text-ink";
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className={cn("mt-1 font-display text-[22px] font-bold tracking-tight", valueColor)}>
        {loading ? "…" : value}
      </div>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}
