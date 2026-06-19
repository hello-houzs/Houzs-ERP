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

// GET /api/scm/consignment-returns/returnable-note-lines → { lines } — camelCase,
// verbatim from the Hono route. One flat row per Consignment Note line that still
// has remaining = delivered − returned > 0. The page groups these by source note
// (consignmentDoId) for the picker.
interface ReturnableLine {
  noteItemId: string;
  consignmentDoId: string;
  noteNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  delivered: number;
  returned: number;
  remaining: number;
  unitPriceCenti: number;
  discountCenti: number;
  unitCostCenti: number;
  variants: unknown;
}

interface DraftLine {
  src: ReturnableLine;
  qty: number;
  condition: string;
  include: boolean;
}

/**
 * ScmConsignmentReturnNew — full-page Create Consignment Return at
 * /scm/consignment-returns/new. Pick the source Consignment Note, set return
 * quantities per line, then post. The return books the unsold loaner back IN the
 * moment it is created (status RECEIVED).
 */
export function ScmConsignmentReturnNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  const linesQ = useQuery<{ lines: ReturnableLine[] }>(
    () => api.get(`${SCM}/consignment-returns/returnable-note-lines`),
    [],
  );

  const [consignmentDoId, setConsignmentDoId] = useState<string | null>(null);
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [edits, setEdits] = useState<Record<string, DraftLine>>({});
  const [saving, setSaving] = useState(false);

  const all = useMemo(() => linesQ.data?.lines ?? [], [linesQ.data]);

  // Distinct source notes for the picker.
  const noteOptions = useMemo(() => {
    const byNote = new Map<
      string,
      {
        consignmentDoId: string;
        noteNumber: string;
        debtorName: string;
        debtorCode: string | null;
        lineCount: number;
      }
    >();
    for (const it of all) {
      const cur = byNote.get(it.consignmentDoId);
      if (cur) cur.lineCount += 1;
      else
        byNote.set(it.consignmentDoId, {
          consignmentDoId: it.consignmentDoId,
          noteNumber: it.noteNumber,
          debtorName: it.debtorName ?? "",
          debtorCode: it.debtorCode ?? null,
          lineCount: 1,
        });
    }
    return [...byNote.values()].sort((a, b) => b.noteNumber.localeCompare(a.noteNumber));
  }, [all]);

  const selectedNote = noteOptions.find((n) => n.consignmentDoId === consignmentDoId) ?? null;

  // The selected note's returnable lines with current per-line edits applied.
  const lines: DraftLine[] = useMemo(() => {
    return all
      .filter((it) => it.consignmentDoId === consignmentDoId)
      .map((it) => edits[it.noteItemId] ?? { src: it, qty: 0, condition: "", include: false });
  }, [all, consignmentDoId, edits]);

  function patchLine(noteItemId: string, patch: Partial<DraftLine>) {
    const base = all.find((l) => l.noteItemId === noteItemId);
    if (!base) return;
    setEdits((prev) => {
      const cur = prev[noteItemId] ?? { src: base, qty: 0, condition: "", include: false };
      return { ...prev, [noteItemId]: { ...cur, ...patch } };
    });
  }

  function setLineQty(l: DraftLine, raw: string) {
    const n = Math.min(Math.max(0, Number(raw) || 0), l.src.remaining);
    patchLine(l.src.noteItemId, { qty: n, include: n > 0 ? true : edits[l.src.noteItemId]?.include ?? false });
  }

  function toggleLine(l: DraftLine) {
    const willInclude = !l.include;
    patchLine(l.src.noteItemId, {
      include: willInclude,
      qty: willInclude && l.qty === 0 ? l.src.remaining : l.qty,
    });
  }

  const picks = lines.filter((l) => l.include && l.qty > 0);
  const totalRefund = picks.reduce((s, l) => s + l.qty * l.src.unitPriceCenti, 0);

  async function submit() {
    if (!consignmentDoId || !selectedNote) {
      toast.error("Pick a consignment note to return from");
      return;
    }
    if (picks.length === 0) {
      toast.error("Select at least one line with a quantity to return");
      return;
    }
    const ok = await dialog.confirm({
      title: "Create consignment return?",
      message: `This books ${picks.length} line(s) from ${selectedNote.noteNumber} back into the warehouse (stock IN, refund ${fmtCenti(totalRefund)}). A return is received immediately.`,
      confirmLabel: "Create Return",
    });
    if (!ok) return;

    setSaving(true);
    try {
      // POST /consignment-returns: { debtorName (required), consignmentDoId?,
      // doDocNo?, returnDate?, reason?, notes?, items:[{ consignmentDoItemId,
      // itemCode, itemGroup?, description?, qtyReturned, unitPriceCenti,
      // discountCenti?, unitCostCenti?, condition?, variants? }] }
      // → 201 { id, returnNumber }.
      const res = await api.post<{ id: string; returnNumber: string }>(`${SCM}/consignment-returns`, {
        debtorName: selectedNote.debtorName || selectedNote.noteNumber,
        debtorCode: selectedNote.debtorCode ?? undefined,
        consignmentDoId,
        doDocNo: selectedNote.noteNumber,
        returnDate,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
        items: picks.map((l) => ({
          consignmentDoItemId: l.src.noteItemId,
          itemCode: l.src.itemCode,
          itemGroup: l.src.itemGroup ?? undefined,
          description: l.src.description ?? undefined,
          qtyReturned: l.qty,
          unitPriceCenti: l.src.unitPriceCenti,
          discountCenti: l.src.discountCenti || undefined,
          unitCostCenti: l.src.unitCostCenti || undefined,
          condition: l.condition.trim() || undefined,
          variants: l.src.variants ?? undefined,
        })),
      });
      toast.success(`Consignment return ${res.returnNumber} created`);
      navigate(`/scm/consignment-returns/${res.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(`Failed to create consignment return${msg ? `: ${msg}` : ""}`);
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/consignment-returns")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Consignment Returns
      </button>
      <PageHeader
        eyebrow="Supply Chain"
        title="New Consignment Return"
        description="Book unsold consignment goods back from the consignee. Pick the source note, set return quantities, then post."
      />

      {/* Step 1 — pick the source note */}
      <Section title="1 · Select the consignment note">
        {linesQ.loading ? (
          <p className="text-[13px] text-ink-muted">Loading returnable notes…</p>
        ) : linesQ.error ? (
          <EmptyState message="Failed to load notes" description={linesQ.error} />
        ) : noteOptions.length === 0 ? (
          <EmptyState
            message="No returnable notes"
            description="There are no consignment notes with stock left to return."
          />
        ) : (
          <div className="space-y-2">
            {noteOptions.map((n) => {
              const active = n.consignmentDoId === consignmentDoId;
              return (
                <button
                  key={n.consignmentDoId}
                  onClick={() => setConsignmentDoId(n.consignmentDoId)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-accent/40",
                  )}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[12px] font-semibold text-ink">{n.noteNumber}</div>
                    <div className="truncate text-[12px] text-ink-secondary">{n.debtorName || "—"}</div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-ink-muted">
                    {n.lineCount} line{n.lineCount === 1 ? "" : "s"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {/* Step 2 — set return quantities */}
      {consignmentDoId && (
        <>
          <Section title={`2 · Lines from ${selectedNote?.noteNumber ?? ""}`}>
            {lines.length === 0 ? (
              <EmptyState
                message="Nothing to return"
                description="Every line on this note has already been fully returned."
              />
            ) : (
              <>
                <div className="space-y-2.5">
                  {lines.map((l, idx) => (
                    <LineCard key={l.src.noteItemId} index={idx + 1}>
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
                            {l.src.itemCode || "—"}
                          </div>
                        </LineField>
                        <LineField label="Description">
                          <div className="flex h-9 items-center rounded-md border border-border-subtle bg-bg/50 px-2.5 text-[13px] text-ink-secondary">
                            {l.src.description || l.src.description2 || "—"}
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
                            onChange={(e) => setLineQty(l, e.target.value)}
                            className={`${lineInputCls} text-right`}
                          />
                        </LineField>
                        <LineField label="Unit Price" align="right">
                          <div className="flex h-9 items-center justify-end rounded-md border border-border-subtle bg-bg/50 px-2.5 font-mono text-[13px] text-ink-secondary">
                            {fmtCenti(l.src.unitPriceCenti)}
                          </div>
                        </LineField>
                      </div>

                      <LineField label="Condition">
                        <input
                          type="text"
                          value={l.condition}
                          onChange={(e) => patchLine(l.src.noteItemId, { condition: e.target.value })}
                          placeholder="e.g. good / damaged"
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
            <Button variant="secondary" onClick={() => navigate("/scm/consignment-returns")} disabled={saving}>
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
