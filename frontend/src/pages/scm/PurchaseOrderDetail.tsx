import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Ban, RotateCcw, Trash2 } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { poStatusLabel } from "./PurchaseOrders";

// GET /api/scm/mfg-purchase-orders/:id → { purchaseOrder, items }. The header
// embeds a richer supplier than the list (contact/phone/email/address) and
// stamps has_children (any non-cancelled GRN → PO is downstream-locked).
interface PoSupplierDetail {
  id: string;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}

interface PoHeader {
  id: string;
  po_number: string;
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
  supplier: PoSupplierDetail | null;
}

// Per-line goods-receipt breakdown the detail route attaches to each item:
// which GR(s) took how much (cancelled GRNs already excluded server-side).
interface PoLineReceipt {
  grnNumber: string;
  qty: number;
  status: string;
}

// The detail route surfaces SO→PO drift: the source SO line was edited after
// this PO was raised, so the snapshot no longer matches the live SO.
interface PoSoDrift {
  specPo: string;
  specSo: string;
  itemPo: string;
  itemSo: string;
  itemChanged: boolean;
}

interface PoItem {
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
  so_doc_no: string | null;
  receipts: PoLineReceipt[] | null;
  so_drift: PoSoDrift | null;
}

const OPEN_STATUSES = new Set(["SUBMITTED", "PARTIALLY_RECEIVED"]);

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.parse(d.length <= 10 ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(ms)) return d;
  return new Date(ms).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ScmPurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);

  const detail = useQuery<{ purchaseOrder: PoHeader; items: PoItem[] }>(
    () => api.get(`${SCM}/mfg-purchase-orders/${id}`),
    [id],
  );

  const po = detail.data?.purchaseOrder;
  const items = detail.data?.items ?? null;
  const currency = po?.currency || "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/purchase-orders")} />
        <EmptyState message="Failed to load purchase order" description={detail.error} />
      </div>
    );
  }

  const hasChildren = Boolean(po?.has_children);
  const isOpen = po ? OPEN_STATUSES.has(po.status) : false;
  // SO→PO drift is only actionable while the PO is still open (pre-receipt) —
  // a received/cancelled PO can't be re-sent, so we hide the warning there.
  const showDrift = isOpen;
  const driftCount = (items ?? []).filter((it) => it.so_drift).length;

  async function runAction(
    label: string,
    fn: () => Promise<unknown>,
    successMsg: string,
  ) {
    setBusy(true);
    try {
      await fn();
      toast.success(successMsg);
      detail.reload();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(`${label} failed${msg ? `: ${msg}` : ""}`);
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!po) return;
    const ok = await dialog.confirm({
      title: `Cancel ${po.po_number}?`,
      message:
        "This sets the status to CANCELLED. Line items and linked documents stay for audit, and any converted Sales-Order quota is released back.",
      confirmLabel: "Cancel PO",
      danger: true,
    });
    if (!ok) return;
    await runAction(
      "Cancel",
      () => api.patch(`${SCM}/mfg-purchase-orders/${po.id}/cancel`, {}),
      "Purchase order cancelled",
    );
  }

  async function onReopen() {
    if (!po) return;
    const ok = await dialog.confirm({
      title: `Reopen ${po.po_number}?`,
      message:
        "Status returns to SUBMITTED and this PO re-claims its Sales-Order quota.",
      confirmLabel: "Reopen",
    });
    if (!ok) return;
    await runAction(
      "Reopen",
      () => api.patch(`${SCM}/mfg-purchase-orders/${po.id}/reopen`, {}),
      "Purchase order reopened",
    );
  }

  async function onDelete() {
    if (!po) return;
    const ok = await dialog.confirm({
      title: `Permanently delete ${po.po_number}?`,
      message:
        "This removes the header and all line items and cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`${SCM}/mfg-purchase-orders/${po.id}`);
      toast.success("Purchase order deleted");
      navigate("/scm/purchase-orders");
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(`Delete failed${msg ? `: ${msg}` : ""}`);
      setBusy(false);
    }
  }

  const itemCols: Column<PoItem>[] = [
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
          {showDrift && it.so_drift && (
            <div className="mt-0.5 text-[11px] font-semibold text-err">
              {it.so_drift.itemChanged
                ? `SO product changed to ${it.so_drift.itemSo} (this line is still ${it.so_drift.itemPo})`
                : `SO spec is now ${it.so_drift.specSo || "—"} (this line is still ${it.so_drift.specPo || "—"})`}
            </div>
          )}
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
      label: "Qty",
      align: "right",
      render: (it) => it.qty ?? 0,
      getValue: (it) => it.qty ?? 0,
    },
    {
      key: "received",
      label: "Received (GRN)",
      render: (it) => {
        const receipts = it.receipts ?? [];
        if (receipts.length === 0) return <span className="text-ink-muted">—</span>;
        const received = receipts.reduce((s, r) => s + Number(r.qty ?? 0), 0);
        const balance = Number(it.qty ?? 0) - received;
        return (
          <div>
            {receipts.map((r, ri) => (
              <div key={ri} className="whitespace-nowrap text-[12px] font-semibold text-accent">
                {r.grnNumber}{" "}
                <span className="font-normal text-ink-muted">×{r.qty}</span>
              </div>
            ))}
            <div className={cn("text-[10px]", balance > 0 ? "text-err" : "text-synced")}>
              {balance > 0 ? `Balance ${balance}` : "Fully received"}
            </div>
          </div>
        );
      },
      getValue: (it) => (it.receipts ?? []).map((r) => r.grnNumber).join(" "),
    },
    {
      key: "delivery_date",
      label: "Delivery",
      render: (it) => fmtDate(it.delivery_date ?? po?.expected_at ?? null),
      getValue: (it) => it.delivery_date ?? po?.expected_at ?? "",
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
      <BackLink onClick={() => navigate("/scm/purchase-orders")} />
      <PageHeader
        eyebrow={po ? `Purchase Order · ${po.po_number}` : "Purchase Order"}
        title={
          po
            ? (po.supplier?.name ?? po.supplier?.code ?? po.po_number)
            : detail.loading
              ? "Loading…"
              : "Purchase Order"
        }
        primaryAction={
          po ? (
            <div className="flex flex-wrap items-center gap-2">
              {isOpen && !hasChildren && (
                <Button
                  variant="danger"
                  icon={<Ban size={14} />}
                  onClick={onCancel}
                  disabled={busy}
                >
                  Cancel
                </Button>
              )}
              {po.status === "CANCELLED" && (
                <>
                  <Button
                    variant="secondary"
                    icon={<RotateCcw size={14} />}
                    onClick={onReopen}
                    disabled={busy}
                  >
                    Reopen
                  </Button>
                  <Button
                    variant="danger"
                    icon={<Trash2 size={14} />}
                    onClick={onDelete}
                    disabled={busy}
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          ) : undefined
        }
      />

      {/* Downstream-lock notice — once a GRN exists the PO is read-only +
          un-cancellable until the GRN is cancelled/deleted. */}
      {po && isOpen && hasChildren && (
        <div className="mb-5 rounded-lg border border-warning-text/30 bg-warning-bg px-4 py-3 text-[12.5px] text-warning-text">
          <span className="font-semibold">Locked — has a Goods Receipt.</span>{" "}
          Cancel or delete the downstream GRN to edit this purchase order again.
        </div>
      )}

      {/* SO→PO drift banner — the source SO changed after this PO was raised. */}
      {po && showDrift && driftCount > 0 && (
        <div className="mb-5 rounded-lg border border-err/40 bg-err/5 px-4 py-3 text-[12.5px] text-err">
          <span className="font-semibold">{driftCount}</span>{" "}
          {driftCount === 1 ? "line's" : "lines'"} source Sales Order changed after
          this PO was raised. Review the red notes below, sync the spec, and re-send
          to the supplier.
        </div>
      )}

      {/* Totals KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Status" value={po ? poStatusLabel(po.status) : "—"} loading={detail.loading} status={po?.status} />
        <Kpi
          label="Subtotal"
          value={po ? fmtCenti(po.subtotal_centi, currency) : "—"}
          loading={detail.loading}
        />
        <Kpi label="Tax" value={po ? fmtCenti(po.tax_centi, currency) : "—"} loading={detail.loading} />
        <Kpi
          label="Total"
          value={po ? fmtCenti(po.total_centi, currency) : "—"}
          loading={detail.loading}
        />
      </div>

      {/* Master record */}
      {po && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Master Record
            </h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(po.status),
              )}
            >
              {poStatusLabel(po.status)}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="PO No." value={po.po_number} mono />
            <Info label="Supplier" value={po.supplier?.name ?? po.supplier?.code} />
            <Info label="Supplier Code" value={po.supplier?.code} mono />
            <Info label="Currency" value={po.currency} />
            <Info label="PO Date" value={fmtDate(po.po_date)} />
            <Info label="Expected Delivery" value={fmtDate(po.expected_at)} />
            <Info label="Contact" value={po.supplier?.contact_person} />
            <Info label="Phone" value={po.supplier?.phone} />
            <Info label="Email" value={po.supplier?.email} />
            <Info label="Address" value={po.supplier?.address} />
          </dl>
          {po.notes && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {po.notes}
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
        tableId="scm_po_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No line items on this purchase order"
        exportName="purchase-order-items"
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
      Purchase Orders
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
