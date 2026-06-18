import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Save } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { Field, Input } from "./Suppliers";

// Response shape from GET /api/scm/purchase-consignment-receives/outstanding-pco-items
// — camelCase, verbatim from the Hono route. One flat row per outstanding PC
// Order line (parent PCO SUBMITTED / PARTIALLY_RECEIVED and remainingQty > 0).
// The receive page groups these by PC Order for the picker.
interface OutstandingPcoItem {
  pcoItemId: string;
  pcoId: string;
  pcoDocNo: string;
  itemCode: string;
  description: string | null;
  itemGroup: string;
  qty: number;
  receivedQty: number;
  remainingQty: number;
  unitPriceCenti: number;
  variants: unknown;
  warehouseId: string | null;
  deliveryDate: string | null;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
}

// One editable receipt line. `received` defaults to the PCO line's outstanding
// qty; `rejected` defaults to 0. Both are capped at remaining.
interface DraftLine {
  src: OutstandingPcoItem;
  received: number;
  rejected: number;
}

/**
 * ScmPurchaseConsignmentReceiveNew — full-page Receive at
 * /scm/purchase-consignment-receives/new. Pick an outstanding PC Order, confirm
 * the received quantities, then post. A PC Receive posts immediately (books the
 * inventory IN and rolls received_qty onto the PC Order) and is irreversible.
 */
export function ScmPurchaseConsignmentReceiveNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  const [saving, setSaving] = useState(false);

  // The chosen PC Order. A receive takes one PCO's outstanding lines at a time.
  const [pcoId, setPcoId] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [notes, setNotes] = useState("");
  // qty edits keyed by pcoItemId so they survive re-renders / PCO reselection.
  const [edits, setEdits] = useState<Record<string, { received: number; rejected: number }>>({});

  const outstanding = useQuery<{ items: OutstandingPcoItem[] }>(
    () => api.get(`${SCM}/purchase-consignment-receives/outstanding-pco-items`),
    [],
  );
  const items = useMemo(() => outstanding.data?.items ?? [], [outstanding.data]);

  // Distinct PCOs for the picker, each carrying its supplier label + line count.
  const pcoOptions = useMemo(() => {
    const byPco = new Map<
      string,
      { pcoId: string; pcoDocNo: string; supplierName: string; supplierCode: string; lineCount: number }
    >();
    for (const it of items) {
      const cur = byPco.get(it.pcoId);
      if (cur) cur.lineCount += 1;
      else
        byPco.set(it.pcoId, {
          pcoId: it.pcoId,
          pcoDocNo: it.pcoDocNo,
          supplierName: it.supplierName,
          supplierCode: it.supplierCode,
          lineCount: 1,
        });
    }
    return [...byPco.values()].sort((a, b) => a.pcoDocNo.localeCompare(b.pcoDocNo));
  }, [items]);

  // The selected PCO's outstanding lines, with current per-line qty edits applied.
  const lines: DraftLine[] = useMemo(() => {
    return items
      .filter((it) => it.pcoId === pcoId)
      .map((it) => {
        const e = edits[it.pcoItemId];
        return {
          src: it,
          received: e ? e.received : it.remainingQty,
          rejected: e ? e.rejected : 0,
        };
      });
  }, [items, pcoId, edits]);

  const supplierName = lines[0]?.src.supplierName || lines[0]?.src.supplierCode || "";

  const dirty = pcoId !== "" || deliveryNoteRef !== "" || notes !== "";

  function setQty(pcoItemId: string, field: "received" | "rejected", value: number, remaining: number) {
    const v = Math.min(remaining, Math.max(0, value || 0));
    setEdits((prev) => {
      const line = items.find((it) => it.pcoItemId === pcoItemId);
      const base = prev[pcoItemId] ?? {
        received: line?.remainingQty ?? 0,
        rejected: 0,
      };
      return { ...prev, [pcoItemId]: { ...base, [field]: v } };
    });
  }

  const subtotalCenti = lines.reduce((s, l) => s + l.received * l.src.unitPriceCenti, 0);
  const acceptedTotal = lines.reduce((s, l) => s + Math.max(0, l.received - l.rejected), 0);

  async function submit() {
    if (!pcoId) {
      toast.error("Pick a Purchase Consignment Order to receive against");
      return;
    }
    if (lines.length === 0) {
      toast.error("This PC Order has no outstanding lines");
      return;
    }
    if (acceptedTotal <= 0) {
      toast.error("Enter a received quantity on at least one line");
      return;
    }
    const ok = await dialog.confirm({
      title: "Post Consignment Receipt?",
      message:
        "This receives the stock into inventory and rolls the received quantity onto the PC Order. " +
        "A receive posts immediately and cannot be edited — it can only be cancelled.",
      confirmLabel: "Receive & Post",
    });
    if (!ok) return;

    setSaving(true);
    try {
      // One supplier per receive — every line on a single PCO shares it. Each
      // line carries its own pcOrderItemId so received_qty rolls up to the PCO.
      const supplierId = lines[0].src.supplierId;
      const warehouseId = lines[0].src.warehouseId ?? undefined;
      const res = await api.post<{ id: string; grnNumber: string }>(
        `${SCM}/purchase-consignment-receives`,
        {
          purchaseConsignmentOrderId: pcoId,
          supplierId,
          warehouseId,
          deliveryNoteRef: deliveryNoteRef || undefined,
          notes: notes || undefined,
          items: lines
            .filter((l) => l.received > 0)
            .map((l) => ({
              pcOrderItemId: l.src.pcoItemId,
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
        },
      );
      toast.success(`Receive ${res.grnNumber} posted`);
      navigate(`/scm/purchase-consignment-receives/${res.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      if (msg.includes("qty_exceeds_remaining"))
        toast.error("A line exceeds the PC Order's outstanding quantity — refresh and retry");
      else toast.error("Failed to post consignment receipt");
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/purchase-consignment-receives")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Purchase Consignment Receives
      </button>

      <PageHeader
        eyebrow="Supply Chain"
        title="New Consignment Receive"
        description="Receive a supplier's consigned stock into the warehouse. Pick the PC Order, confirm quantities, then post."
        primaryAction={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => navigate("/scm/purchase-consignment-receives")}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              icon={<Save size={15} />}
              onClick={submit}
              disabled={saving || !pcoId || acceptedTotal <= 0}
            >
              {saving ? "Posting…" : "Receive & Post"}
            </Button>
          </div>
        }
      />

      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-surface p-5 shadow-stone">
          <Field label="Purchase Consignment Order" required>
            <select
              value={pcoId}
              onChange={(e) => setPcoId(e.target.value)}
              disabled={outstanding.loading}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">
                {outstanding.loading
                  ? "Loading outstanding PC Orders…"
                  : pcoOptions.length === 0
                  ? "No outstanding PC Orders to receive"
                  : "— Pick a PC Order —"}
              </option>
              {pcoOptions.map((p) => (
                <option key={p.pcoId} value={p.pcoId}>
                  {p.pcoDocNo} · {p.supplierName || p.supplierCode} · {p.lineCount} line
                  {p.lineCount === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </Field>

          {outstanding.error && (
            <div className="mt-3 rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-err">
              Failed to load outstanding PC Order lines.
            </div>
          )}

          {pcoId && (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Supplier">
                <div className="flex h-10 items-center rounded-md border border-border bg-bg/50 px-3 text-[13px] text-ink-secondary">
                  {supplierName || "—"}
                </div>
              </Field>
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
          )}
        </div>

        {pcoId && lines.length > 0 && (
          <div className="rounded-lg border border-border bg-surface p-5 shadow-stone">
            <div className="mb-3 flex items-center gap-2">
              <span className="h-px w-3 bg-accent/60" />
              <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Lines to Receive ({lines.length})
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    <th className="py-2 pr-2 font-semibold">Item</th>
                    <th className="py-2 pr-2 text-right font-semibold">Ordered</th>
                    <th className="py-2 pr-2 text-right font-semibold">Outstanding</th>
                    <th className="py-2 pr-2 text-right font-semibold">Received</th>
                    <th className="py-2 pr-2 text-right font-semibold">Rejected</th>
                    <th className="py-2 text-right font-semibold">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.src.pcoItemId} className="border-b border-border-subtle">
                      <td className="py-2 pr-2">
                        <div className="font-mono text-[11px] font-semibold text-ink">{l.src.itemCode}</div>
                        <div className="text-[11px] text-ink-muted">
                          {l.src.description || l.src.itemGroup || "—"}
                        </div>
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-ink-secondary">{l.src.qty}</td>
                      <td className="py-2 pr-2 text-right font-mono text-ink-secondary">
                        {l.src.remainingQty}
                      </td>
                      <td className="py-2 pr-2 text-right">
                        <input
                          type="number"
                          min={0}
                          max={l.src.remainingQty}
                          value={l.received}
                          onChange={(e) =>
                            setQty(l.src.pcoItemId, "received", Number(e.target.value), l.src.remainingQty)
                          }
                          className="h-9 w-20 rounded-md border border-border bg-surface px-2 text-right text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                        />
                      </td>
                      <td className="py-2 pr-2 text-right">
                        <input
                          type="number"
                          min={0}
                          max={l.received}
                          value={l.rejected}
                          onChange={(e) =>
                            setQty(l.src.pcoItemId, "rejected", Number(e.target.value), l.received)
                          }
                          className="h-9 w-20 rounded-md border border-border bg-surface px-2 text-right text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                        />
                      </td>
                      <td className="py-2 text-right font-mono text-ink">
                        {fmtCenti(l.received * l.src.unitPriceCenti)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex justify-end border-t border-border pt-3">
              <div className="flex items-baseline gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Subtotal
                </span>
                <span className="font-mono text-[15px] font-bold text-ink">{fmtCenti(subtotalCenti)}</span>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-ink-muted">
              Received defaults to the PC Order line's outstanding quantity. Rejected is netted out of what
              posts to inventory. A receive posts immediately and is irreversible (cancel only).
            </p>
          </div>
        )}
      </div>

      {dirty && null}
    </div>
  );
}
