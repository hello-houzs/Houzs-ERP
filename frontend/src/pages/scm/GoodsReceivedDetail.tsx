import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shapes from GET /api/scm/grns/:id — snake_case, verbatim from the
// Hono route (backend/src/scm/routes/grns.ts `grns.get('/:id')`). It returns
// { grn, items }: the header carries supplier + parent PO joins and the
// migration-0106 convert/lock flags; each line carries qty_received /
// qty_accepted / qty_rejected, money, a server-resolved source_po_number, and a
// downstream PI/PR breakdown.
interface GrnHeader {
  id: string;
  grn_number: string;
  status: string;
  received_at: string | null;
  delivery_note_ref: string | null;
  notes: string | null;
  currency: string | null;
  subtotal_centi: number | null;
  tax_centi: number | null;
  total_centi: number | null;
  posted_at: string | null;
  supplier: { id: string; code: string; name: string } | null;
  purchase_order: { id: string; po_number: string } | null;
  has_children?: boolean;
  fully_invoiced?: boolean;
  fully_returned?: boolean;
}

interface Downstream {
  docNumber: string;
  docType: "PI" | "PR";
  qty: number;
  status: string;
}

interface GrnItem {
  id: string;
  material_kind: string | null;
  material_code: string;
  material_name: string | null;
  supplier_sku: string | null;
  description: string | null;
  description2: string | null;
  qty_received: number;
  qty_accepted: number;
  qty_rejected: number;
  rejection_reason: string | null;
  unit_price_centi: number | null;
  discount_centi: number | null;
  line_total_centi: number | null;
  delivery_date: string | null;
  source_po_number: string | null;
  downstream: Downstream[];
}

const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

export function ScmGoodsReceivedDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ grn: GrnHeader; items: GrnItem[] }>(
    () => api.get(`${SCM}/grns/${id}`),
    [id],
  );

  const grn = detail.data?.grn;
  const items = detail.data?.items ?? null;
  const currency = grn?.currency ?? "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/grns")} />
        <EmptyState message="Failed to load goods received note" description={detail.error} />
      </div>
    );
  }

  // Live subtotal from the lines (matches 2990's "computed from visible lines").
  // GRN carries no tax, so total = subtotal + tax_centi (tax is 0 in practice).
  const itemsSubtotal = (items ?? []).reduce((s, it) => s + (it.line_total_centi ?? 0), 0);
  const grandTotal = itemsSubtotal + (grn?.tax_centi ?? 0);

  const itemCols: Column<GrnItem>[] = [
    {
      key: "material_code",
      label: "Item Code",
      render: (it) => <span className="font-mono text-[12px]">{it.material_code}</span>,
      getValue: (it) => it.material_code,
    },
    {
      key: "source_po",
      label: "Transfer From (PO)",
      render: (it) =>
        it.source_po_number ? (
          <span className="font-mono text-[12px]">{it.source_po_number}</span>
        ) : (
          <span className="text-ink-muted">— (manual)</span>
        ),
      getValue: (it) => it.source_po_number || "",
    },
    {
      key: "description",
      label: "Description",
      render: (it) => (it.description?.trim() || it.material_name || "—"),
      getValue: (it) => it.description || it.material_name || "",
    },
    {
      key: "description2",
      label: "Description 2",
      render: (it) => it.description2 || "—",
      getValue: (it) => it.description2 || "",
    },
    {
      key: "qty_received",
      label: "Received",
      align: "right",
      render: (it) => it.qty_received ?? 0,
      getValue: (it) => it.qty_received ?? 0,
    },
    {
      key: "qty_rejected",
      label: "Rejected",
      align: "right",
      render: (it) =>
        (it.qty_rejected ?? 0) > 0 ? (
          <span className="text-err">{it.qty_rejected}</span>
        ) : (
          <span className="text-ink-muted">0</span>
        ),
      getValue: (it) => it.qty_rejected ?? 0,
    },
    {
      key: "transfer_to",
      label: "Transfer To",
      render: (it) => {
        const ds = it.downstream ?? [];
        if (ds.length === 0) return <span className="text-ink-muted">—</span>;
        return (
          <div className="space-y-0.5">
            {ds.map((d, di) => (
              <div key={di} className="whitespace-nowrap text-[12px] font-medium text-ink">
                {d.docNumber} <span className="text-ink-muted">x{d.qty}</span>
              </div>
            ))}
          </div>
        );
      },
      getValue: (it) => (it.downstream ?? []).map((d) => d.docNumber).join(" "),
    },
    {
      key: "unit_price",
      label: "Unit Price",
      align: "right",
      render: (it) => <span className="font-mono">{fmtCenti(it.unit_price_centi, currency)}</span>,
      getValue: (it) => it.unit_price_centi ?? 0,
    },
    {
      key: "line_total",
      label: "Line Total",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold text-ink">{fmtCenti(it.line_total_centi, currency)}</span>
      ),
      getValue: (it) => it.line_total_centi ?? 0,
    },
    {
      key: "delivery_date",
      label: "Delivery",
      render: (it) => fmtDate(it.delivery_date),
      getValue: (it) => it.delivery_date || "",
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/grns")} />
      <PageHeader
        eyebrow={grn ? `Goods Receipt · ${grn.grn_number}` : "Goods Receipt"}
        title={grn?.supplier?.name ?? grn?.supplier?.code ?? (detail.loading ? "Loading…" : "Goods Receipt")}
      />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Lines" value={items ? String(items.length) : "—"} loading={detail.loading} />
        <Kpi
          label="Total"
          value={grn ? fmtCenti(grandTotal, currency) : "—"}
          loading={detail.loading}
        />
        <Kpi label="Received Date" value={grn ? fmtDate(grn.received_at) : "—"} loading={detail.loading} />
        <Kpi
          label="Status"
          value={grn ? statusLabel(grn.status) : "—"}
          loading={detail.loading}
        />
      </div>

      {/* Master record */}
      {grn && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Goods Receipt</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(grn.status),
              )}
            >
              {statusLabel(grn.status)}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="GRN No." value={grn.grn_number} mono />
            <Info label="Supplier" value={grn.supplier?.name ?? grn.supplier?.code} />
            <Info label="Transfer From (PO)" value={grn.purchase_order?.po_number} mono />
            <Info label="Received Date" value={fmtDate(grn.received_at)} />
            <Info label="Delivery Note Ref" value={grn.delivery_note_ref} />
            <Info label="Currency" value={grn.currency} />
            <Info label="Subtotal" value={fmtCenti(grn.subtotal_centi, currency)} mono />
            <Info label="Total" value={fmtCenti(grn.total_centi, currency)} mono />
          </dl>
          {grn.notes && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">{grn.notes}</div>
          )}
        </div>
      )}

      {/* Line items */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Line Items{items ? ` (${items.length})` : ""}
        </h3>
      </div>
      <DataTable
        tableId="scm_grn_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No line items on this GRN"
        exportName="grn-items"
      />

      {/* Totals */}
      {grn && (
        <div className="mt-5 flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="flex items-baseline justify-between py-1">
              <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">Subtotal</span>
              <span className="font-mono text-[13px] text-ink">{fmtCenti(itemsSubtotal, currency)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-border-subtle pt-2">
              <span className="text-[11px] font-semibold uppercase tracking-brand text-ink">Total</span>
              <span className="font-mono text-[15px] font-bold text-ink">{fmtCenti(grandTotal, currency)}</span>
            </div>
          </div>
        </div>
      )}
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
      Goods Received
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

function Info({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}
