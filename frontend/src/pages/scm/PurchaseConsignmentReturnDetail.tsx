import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { fmtScmDate } from "./PurchaseConsignmentOrders";
import { pctStatusLabel } from "./PurchaseConsignmentReturns";

// Response shapes from GET /api/scm/purchase-consignment-returns/:id —
// snake_case, verbatim from the Hono route. It returns { purchaseReturn, items }.
// The header embeds a richer supplier (contact/phone/email/address) + the parent
// PC Order and PC Receive joins. NOTE: the return-item select only returns the
// base columns (material_code/name, qty_returned, unit_price_centi,
// line_refund_centi, reason, notes) — no item_group/description2/variants — so
// the line table below renders exactly those.
interface PctSupplierDetail {
  id: string;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}

interface PctHeader {
  id: string;
  return_number: string;
  pc_order_id: string | null;
  pc_receive_id: string | null;
  supplier_id: string;
  return_date: string | null;
  reason: string | null;
  status: string;
  posted_at: string | null;
  completed_at: string | null;
  credit_note_ref: string | null;
  refund_centi: number | null;
  notes: string | null;
  supplier: PctSupplierDetail | null;
  purchase_consignment_order: { id: string; pc_number: string } | null;
  pc_receive: { id: string; receive_number: string } | null;
}

interface PctItem {
  id: string;
  pc_receive_item_id: string | null;
  material_kind: string | null;
  material_code: string;
  material_name: string | null;
  qty_returned: number;
  unit_price_centi: number | null;
  line_refund_centi: number | null;
  reason: string | null;
  notes: string | null;
}

export function ScmPurchaseConsignmentReturnDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ purchaseReturn: PctHeader; items: PctItem[] }>(
    () => api.get(`${SCM}/purchase-consignment-returns/${id}`),
    [id],
  );

  const ret = detail.data?.purchaseReturn;
  const items = detail.data?.items ?? null;
  // Consignment returns are MYR-denominated (refund_centi has no currency col).
  const currency = "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/purchase-consignment-returns")} />
        <EmptyState message="Failed to load purchase consignment return" description={detail.error} />
      </div>
    );
  }

  const itemsRefund = (items ?? []).reduce((s, it) => s + (it.line_refund_centi ?? 0), 0);

  const itemCols: Column<PctItem>[] = [
    {
      key: "material_code",
      label: "Item Code",
      render: (it) => <span className="font-mono text-[12px]">{it.material_code}</span>,
      getValue: (it) => it.material_code,
    },
    {
      key: "material_name",
      label: "Description",
      render: (it) => it.material_name || "—",
      getValue: (it) => it.material_name || "",
    },
    {
      key: "qty_returned",
      label: "Qty Returned",
      align: "right",
      render: (it) => it.qty_returned ?? 0,
      getValue: (it) => it.qty_returned ?? 0,
    },
    {
      key: "unit_price",
      label: "Unit Price",
      align: "right",
      render: (it) => <span className="font-mono">{fmtCenti(it.unit_price_centi, currency)}</span>,
      getValue: (it) => it.unit_price_centi ?? 0,
    },
    {
      key: "line_refund",
      label: "Line Refund",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold text-ink">{fmtCenti(it.line_refund_centi, currency)}</span>
      ),
      getValue: (it) => it.line_refund_centi ?? 0,
    },
    {
      key: "reason",
      label: "Reason",
      render: (it) => it.reason || "—",
      getValue: (it) => it.reason || "",
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/purchase-consignment-returns")} />
      <PageHeader
        eyebrow={ret ? `Consignment Return · ${ret.return_number}` : "Consignment Return"}
        title={ret?.supplier?.name ?? ret?.supplier?.code ?? (detail.loading ? "Loading…" : "Consignment Return")}
      />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Lines" value={items ? String(items.length) : "—"} loading={detail.loading} />
        <Kpi
          label="Refund"
          value={ret ? fmtCenti(ret.refund_centi, currency) : "—"}
          loading={detail.loading}
        />
        <Kpi label="Return Date" value={ret ? fmtScmDate(ret.return_date) : "—"} loading={detail.loading} />
        <Kpi label="Status" value={ret ? pctStatusLabel(ret.status) : "—"} loading={detail.loading} />
      </div>

      {/* Master record */}
      {ret && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Consignment Return</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(ret.status),
              )}
            >
              {pctStatusLabel(ret.status)}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Return No." value={ret.return_number} mono />
            <Info label="Supplier" value={ret.supplier?.name ?? ret.supplier?.code} />
            <Info label="Transfer From (Receive)" value={ret.pc_receive?.receive_number} mono />
            <Info label="Source Order" value={ret.purchase_consignment_order?.pc_number} mono />
            <Info label="Return Date" value={fmtScmDate(ret.return_date)} />
            <Info label="Reason" value={ret.reason} />
            <Info label="Credit Note Ref" value={ret.credit_note_ref} />
            <Info label="Contact" value={ret.supplier?.contact_person} />
            <Info label="Phone" value={ret.supplier?.phone} />
            <Info label="Email" value={ret.supplier?.email} />
            <Info label="Address" value={ret.supplier?.address} />
          </dl>
          {ret.notes && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">{ret.notes}</div>
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
        tableId="scm_pc_return_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No line items on this consignment return"
        exportName="purchase-consignment-return-items"
      />

      {/* Totals */}
      {ret && (
        <div className="mt-5 flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="flex items-baseline justify-between border-t border-border-subtle pt-2">
              <span className="text-[11px] font-semibold uppercase tracking-brand text-ink">Total Refund</span>
              <span className="font-mono text-[15px] font-bold text-ink">{fmtCenti(itemsRefund, currency)}</span>
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
      Purchase Consignment Returns
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
