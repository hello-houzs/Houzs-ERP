import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { DataTable, type Column } from "../../components/DataTable";
import { Field, Input } from "./Suppliers";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/grns — snake_case, verbatim from the Hono
// route (backend/src/scm/routes/grns.ts `grns.get('/')`). The list endpoint
// embeds the supplier + parent PO joins, the stored header total_centi, and the
// migration-0106 convert/lock flags. Rows stay loosely typed where the upstream
// payload is wide; the fields below are the ones the list grid reads.
export interface GrnRow {
  id: string;
  grn_number: string;
  status: string;
  received_at: string | null;
  delivery_note_ref: string | null;
  currency: string | null;
  total_centi: number | null;
  supplier: { id: string; code: string; name: string } | null;
  purchase_order: { id: string; po_number: string } | null;
  has_children?: boolean;
  fully_invoiced?: boolean;
  fully_returned?: boolean;
}

// grn_status enum is POSTED / CLOSED / CANCELLED. A GRN has no draft lifecycle —
// POSTED reads as "Confirmed" (mirrors 2990's). `all` is the unfiltered view.
const STATUS_TABS = ["all", "POSTED", "CLOSED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

export function ScmGoodsReceived() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");
  const [showReceive, setShowReceive] = useState(false);

  const list = useQuery<{ grns: GrnRow[] }>(
    () =>
      api.get(
        `${SCM}/grns${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  // The backend GRN list endpoint only filters by status/supplierId (no
  // server-side text search), so the search box filters the loaded rows here.
  const all = list.data?.grns ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((g) =>
          [
            g.grn_number,
            g.supplier?.name,
            g.supplier?.code,
            g.purchase_order?.po_number,
            g.delivery_note_ref,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<GrnRow>[] = [
    {
      key: "grn_number",
      label: "GRN No.",
      render: (g) => <span className="font-mono text-[12px] font-semibold text-ink">{g.grn_number}</span>,
      getValue: (g) => g.grn_number,
    },
    {
      key: "supplier",
      label: "Supplier",
      render: (g) => g.supplier?.name || g.supplier?.code || "—",
      getValue: (g) => g.supplier?.name || g.supplier?.code || "",
    },
    {
      key: "po_number",
      label: "Transfer From (PO)",
      render: (g) =>
        g.purchase_order?.po_number ? (
          <span className="font-mono text-[12px]">{g.purchase_order.po_number}</span>
        ) : (
          "—"
        ),
      getValue: (g) => g.purchase_order?.po_number || "",
    },
    {
      key: "received_at",
      label: "Received Date",
      render: (g) => fmtDate(g.received_at),
      getValue: (g) => g.received_at || "",
    },
    {
      key: "delivery_note_ref",
      label: "DN Ref",
      defaultHidden: true,
      render: (g) => g.delivery_note_ref || "—",
      getValue: (g) => g.delivery_note_ref || "",
    },
    {
      key: "total_centi",
      label: "Total",
      align: "right",
      render: (g) => <span className="font-mono">{fmtCenti(g.total_centi, g.currency ?? "MYR")}</span>,
      getValue: (g) => g.total_centi ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (g) => <StatusPill status={g.status} />,
      getValue: (g) => g.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Goods Received"
        description="Goods Receipt Notes — the PO → GRN → Purchase Invoice receiving step."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => setShowReceive(true)}>
            Receive (New GRN)
          </Button>
        }
      />

      {/* Status filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {STATUS_TABS.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold transition-colors",
              status === s
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            {s === "all" ? "All" : statusLabel(s)}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_grns"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(g) => g.id}
        onRowClick={(g) => navigate(`/scm/grns/${g.id}`)}
        getRowClassName={(g) =>
          g.status === "CANCELLED" || g.status === "CLOSED" ? "opacity-60" : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search GRN no., supplier, PO…",
        }}
        emptyLabel="No goods received notes found"
        exportName="grns"
      />

      {showReceive && (
        <ReceiveGrnPanel
          onClose={() => setShowReceive(false)}
          onReceived={(id) => {
            setShowReceive(false);
            list.reload();
            navigate(`/scm/grns/${id}`);
          }}
        />
      )}
    </div>
  );
}

// Response shape from GET /api/scm/grns/outstanding-po-items — snake/camel verbatim
// from the Hono route (backend/src/scm/routes/grns.ts `grns.get('/outstanding-po-items')`).
// One flat row per outstanding PO line (parent PO is SUBMITTED / PARTIALLY_RECEIVED
// and remainingQty > 0). The receive panel groups these by PO for the picker.
interface OutstandingPoItem {
  poItemId: string;
  poId: string;
  poDocNo: string;
  itemCode: string;
  description: string | null;
  itemGroup: string;
  qty: number;
  receivedQty: number;
  remainingQty: number;
  unitPriceCenti: number;
  variants: unknown;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  warehouseLocationId: string | null;
  warehouseLocationName: string | null;
  deliveryDate: string | null;
}

// One editable receipt line in the panel. `received` defaults to the PO line's
// outstanding qty; `rejected` defaults to 0. Both are capped at remaining.
interface DraftLine {
  src: OutstandingPoItem;
  received: number;
  rejected: number;
}

// Body POSTed to /api/scm/grns. The route creates the GRN as POSTED directly
// (rolls received_qty onto the PO + writes the inventory IN). One supplier per
// GRN; each line keeps its purchaseOrderItemId so received_qty rolls up.
function ReceiveGrnPanel({
  onClose,
  onReceived,
}: {
  onClose: () => void;
  onReceived: (id: string) => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [saving, setSaving] = useState(false);

  // The chosen PO. A GRN receives one PO's outstanding lines at a time.
  const [poId, setPoId] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [notes, setNotes] = useState("");
  // qty edits keyed by poItemId so they survive re-renders / PO reselection.
  const [edits, setEdits] = useState<Record<string, { received: number; rejected: number }>>({});

  const outstanding = useQuery<{ items: OutstandingPoItem[] }>(
    () => api.get(`${SCM}/grns/outstanding-po-items`),
    [],
  );
  const items = useMemo(() => outstanding.data?.items ?? [], [outstanding.data]);

  // Distinct POs for the picker, each carrying its supplier label + line count.
  const poOptions = useMemo(() => {
    const byPo = new Map<
      string,
      { poId: string; poDocNo: string; supplierName: string; supplierCode: string; lineCount: number }
    >();
    for (const it of items) {
      const cur = byPo.get(it.poId);
      if (cur) cur.lineCount += 1;
      else
        byPo.set(it.poId, {
          poId: it.poId,
          poDocNo: it.poDocNo,
          supplierName: it.supplierName,
          supplierCode: it.supplierCode,
          lineCount: 1,
        });
    }
    return [...byPo.values()].sort((a, b) => a.poDocNo.localeCompare(b.poDocNo));
  }, [items]);

  // The selected PO's outstanding lines, with the current per-line qty edits applied.
  const lines: DraftLine[] = useMemo(() => {
    return items
      .filter((it) => it.poId === poId)
      .map((it) => {
        const e = edits[it.poItemId];
        return {
          src: it,
          received: e ? e.received : it.remainingQty,
          rejected: e ? e.rejected : 0,
        };
      });
  }, [items, poId, edits]);

  const supplierName = lines[0]?.src.supplierName || lines[0]?.src.supplierCode || "";
  const warehouseName = lines[0]?.src.warehouseLocationName || "";

  const dirty = poId !== "" || deliveryNoteRef !== "" || notes !== "";

  function setQty(poItemId: string, field: "received" | "rejected", value: number, remaining: number) {
    const v = Math.min(remaining, Math.max(0, value || 0));
    setEdits((prev) => {
      const line = items.find((it) => it.poItemId === poItemId);
      const base = prev[poItemId] ?? {
        received: line?.remainingQty ?? 0,
        rejected: 0,
      };
      return { ...prev, [poItemId]: { ...base, [field]: v } };
    });
  }

  const subtotalCenti = lines.reduce((s, l) => s + l.received * l.src.unitPriceCenti, 0);
  // At least one line must accept (received - rejected) > 0 to be a real receipt.
  const acceptedTotal = lines.reduce((s, l) => s + Math.max(0, l.received - l.rejected), 0);

  async function submit() {
    if (!poId) {
      toast.error("Pick a Purchase Order to receive against");
      return;
    }
    if (lines.length === 0) {
      toast.error("This PO has no outstanding lines");
      return;
    }
    if (acceptedTotal <= 0) {
      toast.error("Enter a received quantity on at least one line");
      return;
    }
    const ok = await dialog.confirm({
      title: "Post Goods Receipt?",
      message:
        "This receives the stock into inventory and rolls the received quantity onto the PO. " +
        "A GRN posts immediately and cannot be edited — it can only be cancelled.",
      confirmLabel: "Receive & Post",
    });
    if (!ok) return;

    setSaving(true);
    try {
      // One supplier per GRN — every line on a single PO shares it. Each line
      // carries its own purchaseOrderItemId so received_qty rolls up to the PO.
      const supplierId = lines[0].src.supplierId;
      const warehouseId = lines[0].src.warehouseLocationId ?? undefined;
      const res = await api.post<{ id: string; grnNumber: string }>(`${SCM}/grns`, {
        purchaseOrderId: poId,
        supplierId,
        warehouseId,
        deliveryNoteRef: deliveryNoteRef || undefined,
        notes: notes || undefined,
        items: lines
          // Only post lines that actually receive something.
          .filter((l) => l.received > 0)
          .map((l) => ({
            purchaseOrderItemId: l.src.poItemId,
            materialKind: "mfg_product",
            materialCode: l.src.itemCode,
            materialName: l.src.description ?? l.src.itemCode,
            itemGroup: l.src.itemGroup || undefined,
            variants: l.src.variants ?? undefined,
            qtyReceived: l.received,
            qtyAccepted: Math.max(0, l.received - l.rejected),
            qtyRejected: l.rejected,
            unitPriceCenti: l.src.unitPriceCenti,
            deliveryDate: l.src.deliveryDate ?? undefined,
          })),
      });
      toast.success(`GRN ${res.grnNumber} received & posted`);
      onReceived(res.id);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      if (msg.includes("qty_exceeds_remaining"))
        toast.error("A line exceeds the PO's outstanding quantity — refresh and retry");
      else toast.error("Failed to post goods receipt");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      open
      width={720}
      onClose={onClose}
      dirty={dirty}
      onAttemptClose={onClose}
      title="Receive Goods (New GRN)"
      subtitle="Pick a Purchase Order, confirm the received quantities, then post."
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-ink-muted">
            {poId ? `Subtotal ${fmtCenti(subtotalCenti, "MYR")}` : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || !poId || acceptedTotal <= 0}>
              {saving ? "Posting…" : "Receive & Post"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Purchase Order" required>
          <select
            value={poId}
            onChange={(e) => setPoId(e.target.value)}
            disabled={outstanding.loading}
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="">
              {outstanding.loading
                ? "Loading outstanding POs…"
                : poOptions.length === 0
                ? "No outstanding POs to receive"
                : "— Pick a Purchase Order —"}
            </option>
            {poOptions.map((p) => (
              <option key={p.poId} value={p.poId}>
                {p.poDocNo} · {p.supplierName || p.supplierCode} · {p.lineCount} line
                {p.lineCount === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </Field>

        {outstanding.error && (
          <div className="rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-err">
            Failed to load outstanding PO lines.
          </div>
        )}

        {poId && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Supplier">
                <div className="flex h-10 items-center rounded-md border border-border bg-bg/50 px-3 text-[13px] text-ink-secondary">
                  {supplierName || "—"}
                </div>
              </Field>
              <Field label="Receive Into">
                <div className="flex h-10 items-center rounded-md border border-border bg-bg/50 px-3 text-[13px] text-ink-secondary">
                  {warehouseName || "Default warehouse"}
                </div>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Delivery Note Ref">
                <Input
                  value={deliveryNoteRef}
                  onChange={setDeliveryNoteRef}
                  placeholder="Supplier's DN # (optional)"
                />
              </Field>
              <Field label="Notes">
                <Input value={notes} onChange={setNotes} placeholder="Receiving notes (optional)" />
              </Field>
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="h-px w-3 bg-accent/60" />
                <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Lines to Receive ({lines.length})
                </h3>
              </div>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-border bg-bg/50 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                      <th className="px-3 py-2 text-left">Item</th>
                      <th className="px-2 py-2 text-right">Ordered</th>
                      <th className="px-2 py-2 text-right">Outstanding</th>
                      <th className="px-2 py-2 text-right">Received</th>
                      <th className="px-2 py-2 text-right">Rejected</th>
                      <th className="px-3 py-2 text-right">Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.src.poItemId} className="border-b border-border-subtle last:border-0">
                        <td className="px-3 py-2">
                          <div className="font-mono text-[11px] font-semibold text-ink">
                            {l.src.itemCode}
                          </div>
                          <div className="text-[11px] text-ink-muted">
                            {l.src.description || l.src.itemGroup || "—"}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-ink-secondary">{l.src.qty}</td>
                        <td className="px-2 py-2 text-right font-mono text-ink-secondary">
                          {l.src.remainingQty}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            max={l.src.remainingQty}
                            value={l.received}
                            onChange={(e) =>
                              setQty(
                                l.src.poItemId,
                                "received",
                                Number(e.target.value),
                                l.src.remainingQty,
                              )
                            }
                            className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-right text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                          />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            max={l.received}
                            value={l.rejected}
                            onChange={(e) =>
                              setQty(l.src.poItemId, "rejected", Number(e.target.value), l.received)
                            }
                            className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-right text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                          />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-ink">
                          {fmtCenti(l.received * l.src.unitPriceCenti, "MYR")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-ink-muted">
                Received defaults to the PO line's outstanding quantity. Rejected is netted out of
                what posts to inventory. A GRN posts immediately and is irreversible (cancel only).
              </p>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
