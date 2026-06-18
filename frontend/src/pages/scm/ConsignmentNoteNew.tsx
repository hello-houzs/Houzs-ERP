import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { Field, Input } from "./Suppliers";

// GET /api/scm/consignment-notes/deliverable-order-lines → { lines } — camelCase,
// verbatim from the Hono route. One flat row per CO line that still has
// outstanding = ordered − delivered > 0, across all consignment orders. The page
// groups these by source order (orderDocNo) for the picker.
interface DeliverableLine {
  orderItemId: string;
  orderDocNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  ordered: number;
  delivered: number;
  outstanding: number;
  unitPriceCenti: number;
  discountCenti: number;
  unitCostCenti: number;
  variants: unknown;
}

interface DraftLine {
  src: DeliverableLine;
  qty: number;
  include: boolean;
}

/**
 * ScmConsignmentNoteNew — full-page Create Consignment Note at
 * /scm/consignment-notes/new. Pick the source Consignment Order, set ship
 * quantities per line, then post. The note ships the loaner OUT the moment it is
 * created (status DISPATCHED) and is value-neutral on the ledger.
 */
export function ScmConsignmentNoteNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  const linesQ = useQuery<{ lines: DeliverableLine[] }>(
    () => api.get(`${SCM}/consignment-notes/deliverable-order-lines`),
    [],
  );

  const [orderDocNo, setOrderDocNo] = useState<string | null>(null);
  const [doDate, setDoDate] = useState(new Date().toISOString().slice(0, 10));
  const [driverName, setDriverName] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [notes, setNotes] = useState("");
  const [edits, setEdits] = useState<Record<string, DraftLine>>({});
  const [saving, setSaving] = useState(false);

  const all = useMemo(() => linesQ.data?.lines ?? [], [linesQ.data]);

  // Distinct source orders for the picker.
  const orderOptions = useMemo(() => {
    const byOrder = new Map<
      string,
      { orderDocNo: string; debtorName: string; debtorCode: string | null; lineCount: number }
    >();
    for (const it of all) {
      const cur = byOrder.get(it.orderDocNo);
      if (cur) cur.lineCount += 1;
      else
        byOrder.set(it.orderDocNo, {
          orderDocNo: it.orderDocNo,
          debtorName: it.debtorName ?? "",
          debtorCode: it.debtorCode ?? null,
          lineCount: 1,
        });
    }
    return [...byOrder.values()].sort((a, b) => b.orderDocNo.localeCompare(a.orderDocNo));
  }, [all]);

  const selectedOrder = orderOptions.find((o) => o.orderDocNo === orderDocNo) ?? null;

  // The selected order's deliverable lines with current per-line edits applied.
  const lines: DraftLine[] = useMemo(() => {
    return all
      .filter((it) => it.orderDocNo === orderDocNo)
      .map((it) => edits[it.orderItemId] ?? { src: it, qty: it.outstanding, include: true });
  }, [all, orderDocNo, edits]);

  function patchLine(orderItemId: string, patch: Partial<DraftLine>) {
    const base = all.find((l) => l.orderItemId === orderItemId);
    if (!base) return;
    setEdits((prev) => {
      const cur = prev[orderItemId] ?? { src: base, qty: base.outstanding, include: true };
      return { ...prev, [orderItemId]: { ...cur, ...patch } };
    });
  }

  function setLineQty(l: DraftLine, raw: string) {
    const n = Math.min(Math.max(0, Number(raw) || 0), l.src.outstanding);
    patchLine(l.src.orderItemId, { qty: n, include: n > 0 });
  }

  function toggleLine(l: DraftLine) {
    const willInclude = !l.include;
    patchLine(l.src.orderItemId, {
      include: willInclude,
      qty: willInclude && l.qty === 0 ? l.src.outstanding : l.qty,
    });
  }

  const picks = lines.filter((l) => l.include && l.qty > 0);
  const totalValue = picks.reduce((s, l) => s + l.qty * l.src.unitPriceCenti - l.src.discountCenti, 0);

  async function submit() {
    if (!orderDocNo || !selectedOrder) {
      toast.error("Pick a consignment order to ship from");
      return;
    }
    if (picks.length === 0) {
      toast.error("Select at least one line with a quantity to ship");
      return;
    }
    const ok = await dialog.confirm({
      title: "Create consignment note?",
      message: `This ships ${picks.length} line(s) from ${orderDocNo} out to the consignee (stock transfer). A note dispatches immediately.`,
      confirmLabel: "Create Note",
    });
    if (!ok) return;

    setSaving(true);
    try {
      // POST /consignment-notes: { debtorName (required), consignmentSoDocNo?,
      // debtorCode?, doDate?, driverName?, vehicle?, notes?, items:[{ soItemId,
      // itemCode, itemGroup?, description?, qty, unitPriceCenti, discountCenti?,
      // unitCostCenti?, variants? }] } → 201 { id, doNumber }.
      const res = await api.post<{ id: string; doNumber: string }>(`${SCM}/consignment-notes`, {
        debtorName: selectedOrder.debtorName || orderDocNo,
        debtorCode: selectedOrder.debtorCode ?? undefined,
        consignmentSoDocNo: orderDocNo,
        doDate,
        driverName: driverName.trim() || undefined,
        vehicle: vehicle.trim() || undefined,
        notes: notes.trim() || undefined,
        items: picks.map((l) => ({
          soItemId: l.src.orderItemId,
          itemCode: l.src.itemCode,
          itemGroup: l.src.itemGroup ?? undefined,
          description: l.src.description ?? undefined,
          qty: l.qty,
          unitPriceCenti: l.src.unitPriceCenti,
          discountCenti: l.src.discountCenti || undefined,
          unitCostCenti: l.src.unitCostCenti || undefined,
          variants: l.src.variants ?? undefined,
        })),
      });
      toast.success(`Consignment note ${res.doNumber} created`);
      navigate(`/scm/consignment-notes/${res.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(`Failed to create consignment note${msg ? `: ${msg}` : ""}`);
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/consignment-notes")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Consignment Notes
      </button>
      <PageHeader
        eyebrow="Supply Chain"
        title="New Consignment Note"
        description="Ship consigned goods out to the consignee against a consignment order. Pick the order, set ship quantities, then post."
      />

      {/* Step 1 — pick the source order */}
      <Section title="1 · Select the consignment order">
        {linesQ.loading ? (
          <p className="text-[13px] text-ink-muted">Loading deliverable orders…</p>
        ) : linesQ.error ? (
          <EmptyState message="Failed to load orders" description={linesQ.error} />
        ) : orderOptions.length === 0 ? (
          <EmptyState
            message="No deliverable orders"
            description="There are no consignment orders with stock left to ship."
          />
        ) : (
          <div className="space-y-2">
            {orderOptions.map((o) => {
              const active = o.orderDocNo === orderDocNo;
              return (
                <button
                  key={o.orderDocNo}
                  onClick={() => setOrderDocNo(o.orderDocNo)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-accent/40",
                  )}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[12px] font-semibold text-ink">{o.orderDocNo}</div>
                    <div className="truncate text-[12px] text-ink-secondary">{o.debtorName || "—"}</div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-ink-muted">
                    {o.lineCount} line{o.lineCount === 1 ? "" : "s"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {/* Step 2 — set ship quantities */}
      {orderDocNo && (
        <>
          <Section title={`2 · Lines from ${orderDocNo}`}>
            {lines.length === 0 ? (
              <EmptyState
                message="Nothing to ship"
                description="Every line on this order has already been fully delivered."
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                        <th className="py-2 pr-2 font-semibold">Ship</th>
                        <th className="py-2 pr-2 font-semibold">Item</th>
                        <th className="py-2 pr-2 font-semibold">Description</th>
                        <th className="py-2 pr-2 text-right font-semibold">Outstanding</th>
                        <th className="py-2 pr-2 text-right font-semibold">Qty to Ship</th>
                        <th className="py-2 pr-2 text-right font-semibold">Unit Price</th>
                        <th className="py-2 text-right font-semibold">Line Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.src.orderItemId} className="border-b border-border-subtle">
                          <td className="py-2 pr-2">
                            <input
                              type="checkbox"
                              checked={l.include}
                              onChange={() => toggleLine(l)}
                              className="h-4 w-4 accent-accent"
                            />
                          </td>
                          <td className="py-2 pr-2 font-mono text-[11px] text-ink">{l.src.itemCode || "—"}</td>
                          <td className="py-2 pr-2 text-ink-secondary">
                            {l.src.description || l.src.description2 || "—"}
                          </td>
                          <td className="py-2 pr-2 text-right font-mono text-ink-secondary">{l.src.outstanding}</td>
                          <td className="py-2 pr-2 text-right">
                            <input
                              type="number"
                              min={0}
                              max={l.src.outstanding}
                              step="0.01"
                              value={l.qty}
                              onChange={(e) => setLineQty(l, e.target.value)}
                              className="h-9 w-24 rounded-md border border-border bg-surface px-2 text-right text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                            />
                          </td>
                          <td className="py-2 pr-2 text-right font-mono text-ink-secondary">
                            {fmtCenti(l.src.unitPriceCenti)}
                          </td>
                          <td className="py-2 text-right font-mono font-semibold text-ink">
                            {fmtCenti(l.include ? l.qty * l.src.unitPriceCenti - l.src.discountCenti : 0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex justify-end border-t border-border pt-3">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Total Value
                    </span>
                    <span className="font-mono text-[15px] font-bold text-ink">{fmtCenti(totalValue)}</span>
                  </div>
                </div>
              </>
            )}
          </Section>

          <Section title="3 · Shipping details">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Note Date">
                <Input value={doDate} onChange={setDoDate} type="date" />
              </Field>
              <Field label="Driver">
                <Input value={driverName} onChange={setDriverName} placeholder="Driver name (optional)" />
              </Field>
              <Field label="Vehicle">
                <Input value={vehicle} onChange={setVehicle} placeholder="Vehicle (optional)" />
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Notes">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </Field>
            </div>
          </Section>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => navigate("/scm/consignment-notes")} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || picks.length === 0}>
              {saving ? "Creating…" : "Create Note"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{title}</h3>
      </div>
      {children}
    </div>
  );
}
