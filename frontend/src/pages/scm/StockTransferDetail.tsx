import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shapes from GET /api/scm/stock-transfers/:id — snake_case, verbatim
// from the Hono route (backend/src/scm/routes/stock-transfers.ts
// `stockTransfers.get('/:id')`). It returns { transfer, lines }: the header
// carries the from/to warehouse joins; each line is a SKU × qty move (no money).
interface TransferHeader {
  id: string;
  transfer_no: string;
  status: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  transfer_date: string | null;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
  created_by: string | null;
  from_warehouse: { id: string; code: string; name: string } | null;
  to_warehouse: { id: string; code: string; name: string } | null;
}

interface TransferLine {
  id: string;
  stock_transfer_id: string;
  product_code: string;
  product_name: string | null;
  variant_key: string | null;
  qty: number;
  notes: string | null;
  created_at: string | null;
}

const STATUS_LABEL: Record<string, string> = {
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
  if (!Number.isFinite(d.getTime())) return value.slice(0, 16).replace("T", " ");
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

function whLabel(w: { code: string; name: string } | null): string {
  if (!w) return "—";
  if (w.code && w.name) return `${w.code} · ${w.name}`;
  return w.code || w.name || "—";
}

export function ScmStockTransferDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ transfer: TransferHeader; lines: TransferLine[] }>(
    () => api.get(`${SCM}/stock-transfers/${id}`),
    [id],
  );

  const transfer = detail.data?.transfer;
  const lines = detail.data?.lines ?? null;

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/stock-transfers")} />
        <EmptyState message="Failed to load stock transfer" description={detail.error} />
      </div>
    );
  }

  const totalQty = (lines ?? []).reduce((s, l) => s + (l.qty ?? 0), 0);

  const lineCols: Column<TransferLine>[] = [
    {
      key: "product_code",
      label: "SKU",
      render: (l) => <span className="font-mono text-[12px]">{l.product_code}</span>,
      getValue: (l) => l.product_code,
    },
    {
      key: "product_name",
      label: "Description",
      render: (l) => l.product_name?.trim() || "—",
      getValue: (l) => l.product_name || "",
    },
    {
      key: "variant_key",
      label: "Description 2",
      render: (l) => (l.variant_key?.trim() ? l.variant_key : <span className="text-ink-muted">—</span>),
      getValue: (l) => l.variant_key || "",
    },
    {
      key: "qty",
      label: "Qty",
      align: "right",
      render: (l) => <span className="font-mono">{(l.qty ?? 0).toLocaleString("en-MY")}</span>,
      getValue: (l) => l.qty ?? 0,
    },
    {
      key: "notes",
      label: "Notes",
      defaultHidden: true,
      render: (l) => l.notes?.trim() || "—",
      getValue: (l) => l.notes || "",
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/stock-transfers")} />
      <PageHeader
        eyebrow={transfer ? `Stock Transfer · ${transfer.transfer_no}` : "Stock Transfer"}
        title={
          transfer
            ? `${whLabel(transfer.from_warehouse)} → ${whLabel(transfer.to_warehouse)}`
            : detail.loading
              ? "Loading…"
              : "Stock Transfer"
        }
      />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Lines" value={lines ? String(lines.length) : "—"} loading={detail.loading} />
        <Kpi label="Total Qty" value={lines ? totalQty.toLocaleString("en-MY") : "—"} loading={detail.loading} />
        <Kpi label="Date" value={transfer ? fmtDate(transfer.transfer_date) : "—"} loading={detail.loading} />
        <Kpi label="Status" value={transfer ? statusLabel(transfer.status) : "—"} loading={detail.loading} />
      </div>

      {/* Master record */}
      {transfer && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Transfer</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(transfer.status),
              )}
            >
              {statusLabel(transfer.status)}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="ST No." value={transfer.transfer_no} mono />
            <Info label="From Warehouse" value={whLabel(transfer.from_warehouse)} />
            <Info
              label="To Warehouse"
              value={whLabel(transfer.to_warehouse)}
              icon={<ArrowRight size={11} className="text-ink-muted" />}
            />
            <Info label="Transfer Date" value={fmtDate(transfer.transfer_date)} />
            <Info label="Created" value={fmtDateTime(transfer.created_at)} />
            <Info label="Posted" value={transfer.posted_at ? fmtDateTime(transfer.posted_at) : null} />
            <Info
              label="Cancelled"
              value={transfer.cancelled_at ? fmtDateTime(transfer.cancelled_at) : null}
            />
          </dl>
          {transfer.notes && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {transfer.notes}
            </div>
          )}
        </div>
      )}

      {/* Line items */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Items{lines ? ` (${lines.length})` : ""}
        </h3>
      </div>
      <DataTable
        tableId="scm_stock_transfer_lines"
        columns={lineCols}
        rows={lines}
        loading={detail.loading}
        getRowKey={(l) => l.id}
        emptyLabel="No line items on this transfer"
        exportName="stock-transfer-lines"
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
      Stock Transfers
    </button>
  );
}

function Kpi({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-1 font-display text-[22px] font-bold tracking-tight text-ink">{loading ? "…" : value}</div>
    </div>
  );
}

function Info({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {icon}
        {label}
      </dt>
      <dd className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}
