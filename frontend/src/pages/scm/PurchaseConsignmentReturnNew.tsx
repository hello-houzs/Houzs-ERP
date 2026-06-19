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
import { LineCard, LineField, lineInputCls, LineTotalRow } from "./_lineKit";

// GET /api/scm/purchase-consignment-returns/returnable-receive-lines → { lines }
// — camelCase, verbatim from the Hono route. One flat row per receive line that
// still has remaining = qty_accepted − returned_qty > 0, across all non-cancelled
// PC Receives. The page groups these by source receive for the picker.
interface ReturnableLine {
  receiveItemId: string;
  pcReceiveId: string;
  receiveNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  materialKind: string;
  materialCode: string;
  materialName: string;
  itemGroup: string | null;
  description: string | null;
  uom: string | null;
  accepted: number;
  returned: number;
  remaining: number;
  unitPriceCenti: number;
  variants: unknown;
}

interface DraftLine {
  src: ReturnableLine;
  qty: number;
  reason: string;
  include: boolean;
}

/**
 * ScmPurchaseConsignmentReturnNew — full-page Create PC Return at
 * /scm/purchase-consignment-returns/new. Pick the source PC Receive, set return
 * quantities per line, then post. A PC Return posts immediately (books the
 * inventory OUT + nets down the source receive line) and is irreversible.
 */
export function ScmPurchaseConsignmentReturnNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  const linesQ = useQuery<{ lines: ReturnableLine[] }>(
    () => api.get(`${SCM}/purchase-consignment-returns/returnable-receive-lines`),
    [],
  );

  const [receiveId, setReceiveId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [edits, setEdits] = useState<Record<string, DraftLine>>({});
  const [saving, setSaving] = useState(false);

  const all = useMemo(() => linesQ.data?.lines ?? [], [linesQ.data]);

  // Distinct source receives for the picker.
  const receiveOptions = useMemo(() => {
    const byReceive = new Map<
      string,
      { pcReceiveId: string; receiveNumber: string; supplierName: string; lineCount: number }
    >();
    for (const it of all) {
      const cur = byReceive.get(it.pcReceiveId);
      if (cur) cur.lineCount += 1;
      else
        byReceive.set(it.pcReceiveId, {
          pcReceiveId: it.pcReceiveId,
          receiveNumber: it.receiveNumber,
          supplierName: it.supplierName ?? "",
          lineCount: 1,
        });
    }
    return [...byReceive.values()].sort((a, b) => a.receiveNumber.localeCompare(b.receiveNumber));
  }, [all]);

  // The selected receive's returnable lines with the current per-line edits applied.
  const lines: DraftLine[] = useMemo(() => {
    return all
      .filter((it) => it.pcReceiveId === receiveId)
      .map((it) => {
        const e = edits[it.receiveItemId];
        return e ?? { src: it, qty: 0, reason: "", include: false };
      });
  }, [all, receiveId, edits]);

  const selectedReceive = receiveOptions.find((r) => r.pcReceiveId === receiveId) ?? null;
  const supplierId = lines[0]?.src.supplierId ?? all.find((l) => l.pcReceiveId === receiveId)?.supplierId ?? null;

  function patchLine(receiveItemId: string, patch: Partial<DraftLine>) {
    const base = all.find((l) => l.receiveItemId === receiveItemId);
    if (!base) return;
    setEdits((prev) => {
      const cur = prev[receiveItemId] ?? { src: base, qty: 0, reason: "", include: false };
      return { ...prev, [receiveItemId]: { ...cur, ...patch } };
    });
  }

  function setLineQty(receiveItemId: string, raw: string, remaining: number) {
    const n = Math.min(Math.max(0, Number(raw) || 0), remaining);
    patchLine(receiveItemId, { qty: n, include: n > 0 ? true : edits[receiveItemId]?.include ?? false });
  }

  function toggleLine(l: DraftLine) {
    const willInclude = !l.include;
    patchLine(l.src.receiveItemId, {
      include: willInclude,
      qty: willInclude && l.qty === 0 ? l.src.remaining : l.qty,
    });
  }

  const picks = lines.filter((l) => l.include && l.qty > 0);
  const totalRefund = picks.reduce((s, l) => s + l.qty * l.src.unitPriceCenti, 0);

  async function submit() {
    if (!receiveId) {
      toast.error("Pick a PC Receive to return from");
      return;
    }
    if (!supplierId) {
      toast.error("This receive has no supplier — cannot raise a return");
      return;
    }
    if (picks.length === 0) {
      toast.error("Select at least one line with a quantity to return");
      return;
    }
    const ok = await dialog.confirm({
      title: "Create consignment return?",
      message: `This posts a consignment return for ${picks.length} line(s) from ${selectedReceive?.receiveNumber ?? ""} and ships the goods back (stock OUT, refund ${fmtCenti(totalRefund)}).`,
      confirmLabel: "Create Return",
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await api.post<{ id: string; returnNumber: string }>(
        `${SCM}/purchase-consignment-returns`,
        {
          supplierId,
          pcReceiveId: receiveId,
          returnDate: returnDate || undefined,
          reason: reason.trim() || undefined,
          notes: notes.trim() || undefined,
          items: picks.map((l) => ({
            pcReceiveItemId: l.src.receiveItemId,
            materialKind: l.src.materialKind,
            materialCode: l.src.materialCode,
            materialName: l.src.materialName,
            qtyReturned: l.qty,
            unitPriceCenti: l.src.unitPriceCenti,
            reason: l.reason.trim() || undefined,
            itemGroup: l.src.itemGroup ?? undefined,
            variants: l.src.variants ?? undefined,
          })),
        },
      );
      toast.success(`Return ${res.returnNumber} created`);
      navigate(`/scm/purchase-consignment-returns/${res.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(
        msg.includes("no_returnable_qty")
          ? "Nothing left to return on this receive"
          : msg.includes("qty_exceeds_remaining")
          ? "A line exceeds the receive's remaining quantity — refresh and retry"
          : "Failed to create return",
      );
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/purchase-consignment-returns")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Purchase Consignment Returns
      </button>
      <PageHeader
        eyebrow="Supply Chain"
        title="New Consignment Return"
        description="Send consigned goods back to the supplier. Pick the source receive, set return quantities, then post."
      />

      {/* Step 1 — pick the source receive */}
      <Section title="1 · Select the source receive">
        {linesQ.loading ? (
          <p className="text-[13px] text-ink-muted">Loading returnable receives…</p>
        ) : linesQ.error ? (
          <EmptyState message="Failed to load receives" description={linesQ.error} />
        ) : receiveOptions.length === 0 ? (
          <EmptyState
            message="No returnable receives"
            description="There are no posted PC Receives with stock left to return."
          />
        ) : (
          <div className="space-y-2">
            {receiveOptions.map((r) => {
              const active = r.pcReceiveId === receiveId;
              return (
                <button
                  key={r.pcReceiveId}
                  onClick={() => setReceiveId(r.pcReceiveId)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-accent/40",
                  )}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[12px] font-semibold text-ink">{r.receiveNumber}</div>
                    <div className="truncate text-[12px] text-ink-secondary">{r.supplierName || "—"}</div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-ink-muted">
                    {r.lineCount} line{r.lineCount === 1 ? "" : "s"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {/* Step 2 — set return quantities */}
      {receiveId && (
        <>
          <Section title={`2 · Lines from ${selectedReceive?.receiveNumber ?? ""}`}>
            {lines.length === 0 ? (
              <EmptyState
                message="Nothing to return"
                description="Every line on this receive has already been fully returned."
              />
            ) : (
              <>
                <div className="space-y-2.5">
                  {lines.map((l, idx) => (
                    <LineCard key={l.src.receiveItemId} index={idx + 1}>
                      <LineField label="Return">
                        <label className="flex h-9 items-center gap-2 text-[13px] text-ink">
                          <input
                            type="checkbox"
                            checked={l.include}
                            onChange={() => toggleLine(l)}
                            className="h-4 w-4 accent-accent"
                          />
                          <span className="text-ink-secondary">Include this line</span>
                        </label>
                      </LineField>

                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        <LineField label="Item">
                          <div className="flex h-9 items-center rounded-md border border-border-subtle bg-bg/50 px-2.5 font-mono text-[13px] text-ink">
                            {l.src.materialCode || "—"}
                          </div>
                        </LineField>
                        <LineField label="Description">
                          <div className="flex h-9 items-center rounded-md border border-border-subtle bg-bg/50 px-2.5 text-[13px] text-ink-secondary">
                            {l.src.description || l.src.materialName || "—"}
                          </div>
                        </LineField>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                        <LineField label="Remaining" align="right">
                          <div className="flex h-9 items-center justify-end rounded-md border border-border-subtle bg-bg/50 px-2.5 font-mono text-[13px] text-ink-secondary">
                            {l.src.remaining}
                          </div>
                        </LineField>
                        <LineField label="Qty to Return" align="right">
                          <input
                            type="number"
                            min={0}
                            max={l.src.remaining}
                            step="0.01"
                            value={l.qty}
                            onChange={(e) => setLineQty(l.src.receiveItemId, e.target.value, l.src.remaining)}
                            className={`${lineInputCls} text-right`}
                          />
                        </LineField>
                        <LineField label="Unit Price" align="right">
                          <div className="flex h-9 items-center justify-end rounded-md border border-border-subtle bg-bg/50 px-2.5 font-mono text-[13px] text-ink-secondary">
                            {fmtCenti(l.src.unitPriceCenti)}
                          </div>
                        </LineField>
                      </div>

                      <LineField label="Reason">
                        <input
                          type="text"
                          value={l.reason}
                          onChange={(e) => patchLine(l.src.receiveItemId, { reason: e.target.value })}
                          placeholder="e.g. unsold"
                          disabled={!l.include}
                          className={lineInputCls}
                        />
                      </LineField>

                      <LineTotalRow>
                        <span className="text-ink-muted">Line refund</span>
                        <span className="font-mono font-semibold text-ink">
                          {fmtCenti(l.include ? l.qty * l.src.unitPriceCenti : 0)}
                        </span>
                      </LineTotalRow>
                    </LineCard>
                  ))}
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
              onClick={() => navigate("/scm/purchase-consignment-returns")}
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
