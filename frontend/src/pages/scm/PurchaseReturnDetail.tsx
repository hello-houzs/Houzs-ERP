import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";

// Shapes from GET /api/scm/purchase-returns/:id — snake_case, verbatim from the
// Hono route. Header embeds supplier (extended) + purchase_order + grn; items
// carry a resolved warehouse_code (display-only, per-line ship-from warehouse).
interface SupplierRef {
  id: string;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}
interface PoRef {
  id: string;
  po_number: string;
}
interface GrnRef {
  id: string;
  grn_number: string;
}

interface PurchaseReturnHeader {
  id: string;
  return_number: string;
  purchase_order_id: string | null;
  grn_id: string | null;
  supplier_id: string | null;
  return_date: string | null;
  reason: string | null;
  status: string;
  posted_at: string | null;
  completed_at: string | null;
  credit_note_ref: string | null;
  refund_centi: number | null;
  notes: string | null;
  created_at: string | null;
  supplier: SupplierRef | null;
  purchase_order: PoRef | null;
  grn: GrnRef | null;
}

interface PurchaseReturnItem {
  id: string;
  material_kind: string | null;
  material_code: string | null;
  material_name: string | null;
  qty_returned: number | null;
  unit_price_centi: number | null;
  line_refund_centi: number | null;
  reason: string | null;
  notes: string | null;
  warehouse_code: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function ScmPurchaseReturnDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ purchaseReturn: PurchaseReturnHeader; items: PurchaseReturnItem[] }>(
    () => api.get(`${SCM}/purchase-returns/${id}`),
    [id],
  );

  const pr = detail.data?.purchaseReturn;
  const items = detail.data?.items ?? null;

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/purchase-returns")} />
        <EmptyState message="Failed to load purchase return" description={detail.error} />
      </div>
    );
  }

  // Refund total — live from the line items (Σ line_refund_centi), falling back
  // to qty × unit when the rollup column is null. A return is qty × unit price,
  // no tax / discount.
  const refundTotal = (items ?? []).reduce(
    (s, it) => s + (it.line_refund_centi ?? (it.qty_returned ?? 0) * (it.unit_price_centi ?? 0)),
    0,
  );

  const itemCols: Column<PurchaseReturnItem>[] = [
    {
      key: "material_code",
      label: "Item Code",
      render: (it) => <span className="font-mono text-[12px]">{it.material_code || "—"}</span>,
      getValue: (it) => it.material_code || "",
    },
    {
      key: "material_name",
      label: "Description",
      render: (it) => it.material_name || "—",
      getValue: (it) => it.material_name || "",
    },
    {
      key: "kind",
      label: "Group",
      render: (it) => (
        <span className="text-[12px] capitalize text-ink-secondary">
          {(it.material_kind || "").replace("_", " ") || "—"}
        </span>
      ),
      getValue: (it) => it.material_kind || "",
    },
    {
      key: "warehouse",
      label: "Warehouse",
      render: (it) => (it.warehouse_code ? <span className="font-mono text-[12px]">{it.warehouse_code}</span> : "—"),
      getValue: (it) => it.warehouse_code || "",
    },
    {
      key: "qty",
      label: "Qty",
      align: "right",
      render: (it) => it.qty_returned ?? 0,
      getValue: (it) => it.qty_returned ?? 0,
    },
    {
      key: "unit",
      label: "Unit",
      align: "right",
      render: (it) => <span className="font-mono">{fmtCenti(it.unit_price_centi)}</span>,
      getValue: (it) => it.unit_price_centi ?? 0,
    },
    {
      key: "total",
      label: "Total",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold">
          {fmtCenti(it.line_refund_centi ?? (it.qty_returned ?? 0) * (it.unit_price_centi ?? 0))}
        </span>
      ),
      getValue: (it) => it.line_refund_centi ?? (it.qty_returned ?? 0) * (it.unit_price_centi ?? 0),
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/purchase-returns")} />
      <PageHeader
        eyebrow={pr ? `Purchase Return · ${pr.return_number}` : "Purchase Return"}
        title={
          pr
            ? pr.supplier?.name ?? pr.supplier?.code ?? pr.return_number
            : detail.loading
            ? "Loading…"
            : "Purchase Return"
        }
      />

      {/* Header / status / refund summary */}
      {pr && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Return Record</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(pr.status),
              )}
            >
              {STATUS_LABEL[pr.status] ?? pr.status}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Return No." value={pr.return_number} mono />
            <Info label="Supplier" value={pr.supplier?.name ?? pr.supplier?.code} />
            <Info label="From GRN" value={pr.grn?.grn_number} mono />
            <Info label="From PO" value={pr.purchase_order?.po_number} mono />
            <Info label="Return Date" value={pr.return_date ? formatDate(pr.return_date) : null} />
            <Info label="Credit Note Ref" value={pr.credit_note_ref} />
            <Info label="Refund Total" value={fmtCenti(pr.refund_centi)} mono />
            <Info label="Contact" value={pr.supplier?.contact_person} />
            <Info label="Phone" value={pr.supplier?.phone} />
            <Info label="Email" value={pr.supplier?.email} />
          </dl>
          {pr.reason && (
            <div className="mt-4 border-t border-border-subtle pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Reason</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">{pr.reason}</div>
            </div>
          )}
          {pr.notes && (
            <div className="mt-3 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">{pr.notes}</div>
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
        tableId="scm_purchase_return_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No items on this return"
        exportName="purchase-return-items"
      />

      {/* Totals */}
      {items && items.length > 0 && (
        <div className="mt-4 flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Total Refund</span>
              <span className="font-display text-[20px] font-bold tracking-tight text-ink">{fmtCenti(refundTotal)}</span>
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
      Purchase Returns
    </button>
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
