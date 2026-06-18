import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { pcoStatusLabel, fmtScmDate } from "./PurchaseConsignmentOrders";

// GET /api/scm/purchase-consignment-orders/:id → { purchaseOrder, items }. The
// header embeds a richer supplier than the list (contact/phone/email/address)
// and stamps has_children (any non-cancelled PC Receive → PC Order is locked).
// Each item carries a per-line receipts[] breakdown (which PC Receive took how
// much), the PC Order counterpart of the GRN poLineReceipts.
interface PcoSupplierDetail {
  id: string;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}

interface PcoHeader {
  id: string;
  pc_number: string;
  supplier_id: string;
  status: string;
  po_date: string | null;
  expected_at: string | null;
  currency: string;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  notes: string | null;
  purchase_location_id: string | null;
  submitted_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  has_children?: boolean;
  supplier: PcoSupplierDetail | null;
}

interface PcoLineReceipt {
  receiveNumber: string;
  qty: number;
  status: string;
}

interface PcoItem {
  id: string;
  material_code: string;
  material_name: string;
  supplier_sku: string | null;
  item_group: string | null;
  material_kind: string;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  received_qty: number | null;
  unit_price_centi: number;
  discount_centi: number | null;
  line_total_centi: number;
  delivery_date: string | null;
  warehouse_id: string | null;
  receipts: PcoLineReceipt[] | null;
}

export function ScmPurchaseConsignmentOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ purchaseOrder: PcoHeader; items: PcoItem[] }>(
    () => api.get(`${SCM}/purchase-consignment-orders/${id}`),
    [id],
  );

  const pco = detail.data?.purchaseOrder;
  const items = detail.data?.items ?? null;
  const currency = pco?.currency || "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/purchase-consignment-orders")} />
        <EmptyState message="Failed to load purchase consignment order" description={detail.error} />
      </div>
    );
  }

  const hasChildren = Boolean(pco?.has_children);

  const itemCols: Column<PcoItem>[] = [
    {
      key: "material_code",
      label: "Item",
      render: (it) => (
        <div>
          <div className="font-mono text-[12px] font-semibold text-accent">{it.material_code}</div>
          {(() => {
            const sub = it.description2 || it.description || it.material_name;
            return sub ? <div className="text-[11px] text-ink-muted">{sub}</div> : null;
          })()}
        </div>
      ),
      getValue: (it) => it.material_code,
    },
    {
      key: "supplier_sku",
      label: "Supplier Code",
      render: (it) => (
        <span className="font-mono text-[12px]">{it.supplier_sku?.trim() || "—"}</span>
      ),
      getValue: (it) => it.supplier_sku || "",
    },
    {
      key: "group",
      label: "Group",
      render: (it) => (
        <span className="text-[12px] capitalize text-ink-secondary">
          {(it.item_group ?? it.material_kind ?? "").replace(/_/g, " ") || "—"}
        </span>
      ),
      getValue: (it) => it.item_group ?? it.material_kind ?? "",
    },
    {
      key: "qty",
      label: "Ordered",
      align: "right",
      render: (it) => it.qty ?? 0,
      getValue: (it) => it.qty ?? 0,
    },
    {
      key: "received",
      label: "Received (PCR)",
      render: (it) => {
        const receipts = it.receipts ?? [];
        if (receipts.length === 0) return <span className="text-ink-muted">—</span>;
        const received = receipts.reduce((s, r) => s + Number(r.qty ?? 0), 0);
        const balance = Number(it.qty ?? 0) - received;
        return (
          <div>
            {receipts.map((r, ri) => (
              <div key={ri} className="whitespace-nowrap text-[12px] font-semibold text-accent">
                {r.receiveNumber}{" "}
                <span className="font-normal text-ink-muted">×{r.qty}</span>
              </div>
            ))}
            <div className={cn("text-[10px]", balance > 0 ? "text-err" : "text-synced")}>
              {balance > 0 ? `Balance ${balance}` : "Fully received"}
            </div>
          </div>
        );
      },
      getValue: (it) => (it.receipts ?? []).map((r) => r.receiveNumber).join(" "),
    },
    {
      key: "delivery_date",
      label: "Delivery",
      render: (it) => fmtScmDate(it.delivery_date ?? pco?.expected_at ?? null),
      getValue: (it) => it.delivery_date ?? pco?.expected_at ?? "",
    },
    {
      key: "unit_price",
      label: "Unit Price",
      align: "right",
      render: (it) => (
        <span className="font-mono">{fmtCenti(it.unit_price_centi, currency)}</span>
      ),
      getValue: (it) => it.unit_price_centi ?? 0,
    },
    {
      key: "discount",
      label: "Disc.",
      align: "right",
      render: (it) =>
        (it.discount_centi ?? 0) > 0 ? (
          <span className="font-mono">{fmtCenti(it.discount_centi, currency)}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
      getValue: (it) => it.discount_centi ?? 0,
    },
    {
      key: "line_total",
      label: "Line Total",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold text-ink">
          {fmtCenti(it.line_total_centi, currency)}
        </span>
      ),
      getValue: (it) => it.line_total_centi ?? 0,
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/purchase-consignment-orders")} />
      <PageHeader
        eyebrow={pco ? `Purchase Consignment Order · ${pco.pc_number}` : "Purchase Consignment Order"}
        title={
          pco
            ? (pco.supplier?.name ?? pco.supplier?.code ?? pco.pc_number)
            : detail.loading
              ? "Loading…"
              : "Purchase Consignment Order"
        }
      />

      {/* Downstream-lock notice — once a PC Receive exists the PC Order is
          read-only + un-cancellable until that receive is cancelled/deleted. */}
      {pco && hasChildren && (
        <div className="mb-5 rounded-lg border border-warning-text/30 bg-warning-bg px-4 py-3 text-[12.5px] text-warning-text">
          <span className="font-semibold">Locked — has a Consignment Receive.</span>{" "}
          Cancel or delete the downstream PC Receive to edit this order again.
        </div>
      )}

      {/* Totals KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Status" value={pco ? pcoStatusLabel(pco.status) : "—"} loading={detail.loading} status={pco?.status} />
        <Kpi
          label="Subtotal"
          value={pco ? fmtCenti(pco.subtotal_centi, currency) : "—"}
          loading={detail.loading}
        />
        <Kpi label="Tax" value={pco ? fmtCenti(pco.tax_centi, currency) : "—"} loading={detail.loading} />
        <Kpi
          label="Total"
          value={pco ? fmtCenti(pco.total_centi, currency) : "—"}
          loading={detail.loading}
        />
      </div>

      {/* Master record */}
      {pco && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Master Record
            </h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(pco.status),
              )}
            >
              {pcoStatusLabel(pco.status)}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="PC Order No." value={pco.pc_number} mono />
            <Info label="Supplier" value={pco.supplier?.name ?? pco.supplier?.code} />
            <Info label="Supplier Code" value={pco.supplier?.code} mono />
            <Info label="Currency" value={pco.currency} />
            <Info label="Order Date" value={fmtScmDate(pco.po_date)} />
            <Info label="Expected Delivery" value={fmtScmDate(pco.expected_at)} />
            <Info label="Contact" value={pco.supplier?.contact_person} />
            <Info label="Phone" value={pco.supplier?.phone} />
            <Info label="Email" value={pco.supplier?.email} />
            <Info label="Address" value={pco.supplier?.address} />
          </dl>
          {pco.notes && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {pco.notes}
            </div>
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
        tableId="scm_pc_order_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No line items on this purchase consignment order"
        exportName="purchase-consignment-order-items"
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
      Purchase Consignment Orders
    </button>
  );
}

function Kpi({
  label,
  value,
  loading,
  status,
}: {
  label: string;
  value: string;
  loading?: boolean;
  status?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div
        className={cn(
          "mt-1 font-display text-[20px] font-bold tracking-tight text-ink",
          status && "text-[16px]",
        )}
      >
        {loading ? "…" : value}
      </div>
    </div>
  );
}

function Info({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}
