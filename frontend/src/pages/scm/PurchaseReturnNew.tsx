import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { Field, Input } from "./Suppliers";

/* GET /api/scm/grns?status=POSTED → { grns } — header rows with embedded
   supplier + purchase_order. We only need enough to label the picker. */
interface GrnListRow {
  id: string;
  grn_number: string;
  received_at: string | null;
  supplier: { id: string; code: string; name: string } | null;
  purchase_order: { id: string; po_number: string } | null;
  fully_returned?: boolean;
}

/* GET /api/scm/grns/:id → { grn, items }. Each line carries qty_accepted /
   returned_qty so we can compute remaining = qty_accepted − returned_qty (the
   cap the create endpoint enforces). material_* + item_group/variants are
   replayed into the PR line body so the return mirrors what was received. */
interface GrnDetailHeader {
  id: string;
  grn_number: string;
  supplier_id: string | null;
  purchase_order_id: string | null;
}
interface GrnDetailItem {
  id: string;
  material_kind: string | null;
  material_code: string | null;
  material_name: string | null;
  description: string | null;
  description2: string | null;
  item_group: string | null;
  qty_accepted: number | null;
  returned_qty: number | null;
  unit_price_centi: number | null;
  variants: Record<string, unknown> | null;
}

interface DraftLine {
  grnItemId: string;
  materialKind: string | null;
  materialCode: string | null;
  materialName: string | null;
  description: string | null;
  itemGroup: string | null;
  variants: Record<string, unknown> | null;
  remaining: number;
  unitPriceCenti: number;
  qty: number;
  reason: string;
  include: boolean;
}

export function ScmPurchaseReturnNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  // Eligible source GRNs: POSTED and not already fully returned.
  const grnList = useQuery<{ grns: GrnListRow[] }>(
    () => api.get(`${SCM}/grns${buildQuery({ status: "POSTED" })}`),
    [],
  );

  const [grnId, setGrnId] = useState<string | null>(null);
  const [header, setHeader] = useState<GrnDetailHeader | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [loadingLines, setLoadingLines] = useState(false);
  const [reason, setReason] = useState("");
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const grns = useMemo(
    () => (grnList.data?.grns ?? []).filter((g) => !g.fully_returned),
    [grnList.data],
  );
  const selectedGrn = grns.find((g) => g.id === grnId) ?? null;

  async function pickGrn(g: GrnListRow) {
    setGrnId(g.id);
    setHeader(null);
    setLines([]);
    setLoadingLines(true);
    try {
      const res = await api.get<{ grn: GrnDetailHeader; items: GrnDetailItem[] }>(
        `${SCM}/grns/${g.id}`,
      );
      setHeader(res.grn);
      const draft = (res.items ?? [])
        .map((it) => {
          const remaining = (it.qty_accepted ?? 0) - (it.returned_qty ?? 0);
          return { it, remaining };
        })
        .filter(({ remaining }) => remaining > 0)
        .map(({ it, remaining }) => ({
          grnItemId: it.id,
          materialKind: it.material_kind,
          materialCode: it.material_code,
          materialName: it.material_name,
          description: (it.description || "").trim() || it.material_name,
          itemGroup: it.item_group,
          variants: it.variants,
          remaining,
          unitPriceCenti: it.unit_price_centi ?? 0,
          qty: 0, // a return defaults to ZERO — the operator opts each line in
          reason: "",
          include: false,
        }));
      setLines(draft);
    } catch {
      toast.error("Failed to load GRN lines");
    } finally {
      setLoadingLines(false);
    }
  }

  function setLineQty(grnItemId: string, raw: string) {
    const n = Math.max(0, Number(raw) || 0);
    setLines((prev) =>
      prev.map((l) =>
        l.grnItemId === grnItemId
          ? { ...l, qty: Math.min(n, l.remaining), include: n > 0 ? true : l.include }
          : l,
      ),
    );
  }

  function setLineReason(grnItemId: string, v: string) {
    setLines((prev) => prev.map((l) => (l.grnItemId === grnItemId ? { ...l, reason: v } : l)));
  }

  function toggleLine(grnItemId: string) {
    setLines((prev) =>
      prev.map((l) =>
        l.grnItemId === grnItemId
          ? { ...l, include: !l.include, qty: !l.include && l.qty === 0 ? l.remaining : l.qty }
          : l,
      ),
    );
  }

  const picks = lines.filter((l) => l.include && l.qty > 0);
  const totalRefund = picks.reduce((s, l) => s + l.qty * l.unitPriceCenti, 0);
  const dirty = grnId !== null;

  async function submit() {
    if (!selectedGrn || !header) {
      toast.error("Pick a GRN to return from");
      return;
    }
    if (!header.supplier_id) {
      toast.error("This GRN has no supplier — cannot raise a return");
      return;
    }
    if (picks.length === 0) {
      toast.error("Select at least one line with a quantity to return");
      return;
    }
    const ok = await dialog.confirm({
      title: "Create purchase return?",
      message: `This posts a purchase return for ${picks.length} line(s) from ${selectedGrn.grn_number} and ships the goods back (stock OUT, refund ${fmtCenti(totalRefund)}).`,
      confirmLabel: "Create Return",
    });
    if (!ok) return;

    setSaving(true);
    try {
      // POST /purchase-returns: { supplierId, grnId, purchaseOrderId?, returnDate?,
      // reason?, notes?, items:[{grnItemId, materialKind, materialCode,
      // materialName, qtyReturned, unitPriceCenti, reason?, itemGroup?, variants?}] }
      // → 201 { id, returnNumber }. Posts immediately (no DRAFT).
      const res = await api.post<{ id: string; returnNumber: string }>(
        `${SCM}/purchase-returns`,
        {
          supplierId: header.supplier_id,
          grnId: header.id,
          purchaseOrderId: header.purchase_order_id ?? undefined,
          returnDate: returnDate || undefined,
          reason: reason.trim() || undefined,
          notes: notes.trim() || undefined,
          items: picks.map((l) => ({
            grnItemId: l.grnItemId,
            materialKind: l.materialKind ?? undefined,
            materialCode: l.materialCode,
            materialName: l.materialName,
            qtyReturned: l.qty,
            unitPriceCenti: l.unitPriceCenti,
            reason: l.reason.trim() || undefined,
            itemGroup: l.itemGroup ?? undefined,
            variants: l.variants ?? undefined,
          })),
        },
      );
      toast.success(`Return ${res.returnNumber} created`);
      navigate(`/scm/purchase-returns/${res.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(
        msg.includes("no_returnable_qty")
          ? "Nothing left to return on this GRN"
          : "Failed to create return",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/purchase-returns")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Purchase Returns
      </button>
      <PageHeader
        eyebrow="Supply Chain"
        title="New Purchase Return"
        description="Send received goods back to the supplier. Pick the source GRN, set return quantities, then post."
      />

      {/* Step 1 — pick the source GRN */}
      <Section title="1 · Select the source GRN">
        {grnList.loading ? (
          <p className="text-[13px] text-ink-muted">Loading goods receipts…</p>
        ) : grnList.error ? (
          <EmptyState message="Failed to load goods receipts" description={grnList.error} />
        ) : grns.length === 0 ? (
          <EmptyState
            message="No returnable GRNs"
            description="There are no posted goods receipts with stock left to return."
          />
        ) : (
          <div className="space-y-2">
            {grns.map((g) => {
              const active = g.id === grnId;
              return (
                <button
                  key={g.id}
                  onClick={() => pickGrn(g)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-accent bg-accent-soft"
                      : "border-border bg-surface hover:border-accent/40",
                  )}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[12px] font-semibold text-ink">{g.grn_number}</div>
                    <div className="truncate text-[12px] text-ink-secondary">
                      {g.supplier?.name || g.supplier?.code || "—"}
                      {g.purchase_order?.po_number ? ` · ${g.purchase_order.po_number}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-ink-muted">
                    {g.received_at ? formatDate(g.received_at) : "—"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {/* Step 2 — set return quantities */}
      {selectedGrn && (
        <>
          <Section title={`2 · Lines from ${selectedGrn.grn_number}`}>
            {loadingLines ? (
              <p className="text-[13px] text-ink-muted">Loading lines…</p>
            ) : lines.length === 0 ? (
              <EmptyState
                message="Nothing to return"
                description="Every line on this GRN has already been fully returned."
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                        <th className="py-2 pr-2 font-semibold">Return</th>
                        <th className="py-2 pr-2 font-semibold">Item</th>
                        <th className="py-2 pr-2 font-semibold">Description</th>
                        <th className="py-2 pr-2 text-right font-semibold">Remaining</th>
                        <th className="py-2 pr-2 text-right font-semibold">Qty to Return</th>
                        <th className="py-2 pr-2 text-right font-semibold">Unit Price</th>
                        <th className="py-2 pr-2 font-semibold">Reason</th>
                        <th className="py-2 text-right font-semibold">Line Refund</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.grnItemId} className="border-b border-border-subtle">
                          <td className="py-2 pr-2">
                            <input
                              type="checkbox"
                              checked={l.include}
                              onChange={() => toggleLine(l.grnItemId)}
                              className="h-4 w-4 accent-accent"
                            />
                          </td>
                          <td className="py-2 pr-2 font-mono text-[11px] text-ink">{l.materialCode || "—"}</td>
                          <td className="py-2 pr-2 text-ink-secondary">{l.description || "—"}</td>
                          <td className="py-2 pr-2 text-right font-mono text-ink-secondary">{l.remaining}</td>
                          <td className="py-2 pr-2 text-right">
                            <input
                              type="number"
                              min={0}
                              max={l.remaining}
                              step="0.01"
                              value={l.qty}
                              onChange={(e) => setLineQty(l.grnItemId, e.target.value)}
                              className="h-9 w-24 rounded-md border border-border bg-surface px-2 text-right text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                            />
                          </td>
                          <td className="py-2 pr-2 text-right font-mono text-ink-secondary">
                            {fmtCenti(l.unitPriceCenti)}
                          </td>
                          <td className="py-2 pr-2">
                            <input
                              type="text"
                              value={l.reason}
                              onChange={(e) => setLineReason(l.grnItemId, e.target.value)}
                              placeholder="e.g. defective"
                              disabled={!l.include}
                              className="h-9 w-40 rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
                            />
                          </td>
                          <td className="py-2 text-right font-mono font-semibold text-ink">
                            {fmtCenti(l.include ? l.qty * l.unitPriceCenti : 0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex justify-end border-t border-border pt-3">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Total Refund
                    </span>
                    <span className="font-mono text-[15px] font-bold text-ink">{fmtCenti(totalRefund)}</span>
                  </div>
                </div>
              </>
            )}
          </Section>

          <Section title="3 · Return details">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Return Date">
                <Input value={returnDate} onChange={setReturnDate} type="date" />
              </Field>
              <Field label="Reason (header)">
                <Input value={reason} onChange={setReason} placeholder="Overall reason for the return" />
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
            <Button
              variant="secondary"
              onClick={() => navigate("/scm/purchase-returns")}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || picks.length === 0}>
              {saving ? "Creating…" : "Create Return"}
            </Button>
          </div>
        </>
      )}

      {dirty && null}
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
