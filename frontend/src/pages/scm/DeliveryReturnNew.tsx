import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Field, Input } from "./Suppliers";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { cn } from "../../lib/utils";

/* GET /api/scm/delivery-returns/returnable-do-lines → { lines } — one row per
   DO LINE that can still be returned (remaining = delivered − invoiced −
   returned, derived live). camelCase verbatim from doLineRemaining
   (backend/src/scm/lib/do-line-remaining.ts). A Delivery Return ships ONE
   customer's goods back, so the picker groups by debtor; the POST / endpoint
   enforces the same single-customer + per-line remaining caps. */
interface ReturnableDoLine {
  doItemId: string;
  deliveryOrderId: string;
  doNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  delivered: number;
  invoiced: number;
  returned: number;
  remaining: number;
  unitPriceCenti: number;
  unitCostCenti: number;
  discountCenti: number;
  variants: unknown;
  lineSeq: number;
}

// Same-customer key — debtor_code when present, else debtor_name. Mirrors
// custKeyOf in do-line-remaining.ts so the client groups exactly how the server
// validates (one Delivery Return covers ONE customer).
function custKey(l: ReturnableDoLine): string {
  return l.debtorCode && l.debtorCode.trim()
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? "").trim().toUpperCase()}`;
}

function custLabel(l: ReturnableDoLine): string {
  return l.debtorName || l.debtorCode || "(no customer)";
}

interface PickState {
  include: boolean;
  qty: number;
  reason: string;
}

/**
 * ScmDeliveryReturnNew — full-page Create Delivery Return at
 * /scm/delivery-returns/new.
 *
 * Step 1: pick a customer (returnable DO lines are grouped by debtor — a return
 * covers one customer). Step 2: opt each of that customer's returnable DO lines
 * in, set a qty (1..remaining = delivered − invoiced − returned) and a reason.
 * Step 3: header reason/date/notes. Post hits POST /delivery-returns with one
 * line per pick (each carries do_item_id), which restocks inventory, re-opens
 * the source SO and navigates to the new return.
 */
export function ScmDeliveryReturnNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  const linesQ = useQuery<{ lines: ReturnableDoLine[] }>(
    () => api.get(`${SCM}/delivery-returns/returnable-do-lines`),
    [],
  );

  const [customer, setCustomer] = useState<string | null>(null);
  // qty/reason edits keyed by doItemId so they survive customer switches.
  const [picks, setPicks] = useState<Record<string, PickState>>({});
  const [reason, setReason] = useState("");
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const allLines = useMemo(
    () => (linesQ.data?.lines ?? []).filter((l) => l.remaining > 0),
    [linesQ.data],
  );

  // Distinct customers for the picker, each carrying a line count.
  const customers = useMemo(() => {
    const byCust = new Map<string, { key: string; label: string; lineCount: number }>();
    for (const l of allLines) {
      const k = custKey(l);
      const cur = byCust.get(k);
      if (cur) cur.lineCount += 1;
      else byCust.set(k, { key: k, label: custLabel(l), lineCount: 1 });
    }
    return [...byCust.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [allLines]);

  // The selected customer's returnable lines, in each DO's listing order.
  const lines = useMemo(() => {
    if (!customer) return [];
    return allLines
      .filter((l) => custKey(l) === customer)
      .sort(
        (a, b) =>
          a.doNumber.localeCompare(b.doNumber) || a.lineSeq - b.lineSeq || a.doItemId.localeCompare(b.doItemId),
      );
  }, [allLines, customer]);

  function pickFor(l: ReturnableDoLine): PickState {
    return picks[l.doItemId] ?? { include: false, qty: l.remaining, reason: "" };
  }

  function toggleLine(l: ReturnableDoLine) {
    setPicks((prev) => {
      const cur = prev[l.doItemId] ?? { include: false, qty: l.remaining, reason: "" };
      return { ...prev, [l.doItemId]: { ...cur, include: !cur.include } };
    });
  }

  function setLineQty(l: ReturnableDoLine, raw: string) {
    const n = Math.max(0, Number(raw) || 0);
    const capped = Math.min(n, l.remaining);
    setPicks((prev) => {
      const cur = prev[l.doItemId] ?? { include: false, qty: l.remaining, reason: "" };
      return {
        ...prev,
        [l.doItemId]: { ...cur, qty: capped, include: capped > 0 ? true : cur.include },
      };
    });
  }

  function setLineReason(l: ReturnableDoLine, v: string) {
    setPicks((prev) => {
      const cur = prev[l.doItemId] ?? { include: false, qty: l.remaining, reason: "" };
      return { ...prev, [l.doItemId]: { ...cur, reason: v } };
    });
  }

  // Switching customer clears the prior customer's selections so a return can't
  // accidentally mix two debtors (the server rejects that anyway).
  function pickCustomer(key: string) {
    setCustomer(key);
    setPicks({});
  }

  const chosen = lines
    .map((l) => ({ line: l, pick: pickFor(l) }))
    .filter(({ pick }) => pick.include && pick.qty > 0);
  const totalRefund = chosen.reduce(
    (s, { line, pick }) => s + pick.qty * line.unitPriceCenti,
    0,
  );

  async function submit() {
    if (!customer) {
      toast.error("Pick a customer to return from");
      return;
    }
    if (chosen.length === 0) {
      toast.error("Select at least one line with a quantity to return");
      return;
    }
    const first = chosen[0].line;
    const ok = await dialog.confirm({
      title: "Create delivery return?",
      message:
        `This returns ${chosen.length} line(s) from ${custLabel(first)} (stock IN, refund ${fmtCenti(totalRefund)}) and ` +
        "re-opens the source Sales Order. A return is received immediately on creation.",
      confirmLabel: "Create Return",
    });
    if (!ok) return;

    setSaving(true);
    try {
      // POST /delivery-returns — full DO-cloned header + line items. Every line
      // MUST carry doItemId ("no DO, no Return"). returnDate/reason/notes are
      // header-level; per-line reason rides each item. → 201 { id, returnNumber }.
      const res = await api.post<{ id: string; returnNumber: string }>(`${SCM}/delivery-returns`, {
        debtorName: first.debtorName ?? first.debtorCode ?? "(customer)",
        debtorCode: first.debtorCode ?? undefined,
        deliveryOrderId: first.deliveryOrderId,
        doDocNo: first.doNumber,
        returnDate: returnDate || undefined,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
        items: chosen.map(({ line, pick }) => ({
          doItemId: line.doItemId,
          itemCode: line.itemCode,
          itemGroup: line.itemGroup ?? undefined,
          description: line.description ?? undefined,
          uom: line.uom ?? undefined,
          qtyReturned: pick.qty,
          unitPriceCenti: line.unitPriceCenti,
          unitCostCenti: line.unitCostCenti,
          discountCenti: line.discountCenti,
          reason: pick.reason.trim() || undefined,
          variants: line.variants ?? undefined,
        })),
      });
      toast.success(`Return ${res.returnNumber} created`);
      navigate(`/scm/delivery-returns/${res.id}`);
    } catch (e) {
      toast.error(failureMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/delivery-returns")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Delivery Returns
      </button>
      <PageHeader
        eyebrow="Supply Chain"
        title="New Delivery Return"
        description="Take delivered goods back from a customer. Pick the customer, set return quantities and reasons, then post."
      />

      {/* Step 1 — pick the customer */}
      <Section title="1 · Select the customer">
        {linesQ.loading ? (
          <p className="text-[13px] text-ink-muted">Loading returnable delivery orders…</p>
        ) : linesQ.error ? (
          <EmptyState message="Failed to load returnable delivery orders" description={linesQ.error} />
        ) : customers.length === 0 ? (
          <EmptyState
            message="Nothing to return"
            description="There are no delivered DO lines with a quantity left to return."
          />
        ) : (
          <div className="space-y-2">
            {customers.map((cst) => {
              const active = cst.key === customer;
              return (
                <button
                  key={cst.key}
                  onClick={() => pickCustomer(cst.key)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-accent/40",
                  )}
                >
                  <span className="min-w-0 truncate font-medium text-ink">{cst.label}</span>
                  <span className="shrink-0 text-[11px] text-ink-muted">
                    {cst.lineCount} returnable line{cst.lineCount === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {/* Step 2 — set return quantities */}
      {customer && (
        <>
          <Section title="2 · Lines to return">
            {lines.length === 0 ? (
              <EmptyState
                message="Nothing left to return"
                description="Every delivered line for this customer has already been invoiced or returned."
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                        <th className="py-2 pr-2 font-semibold">Return</th>
                        <th className="py-2 pr-2 font-semibold">DO</th>
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
                      {lines.map((l) => {
                        const pick = pickFor(l);
                        const lineRefund = pick.include ? pick.qty * l.unitPriceCenti : 0;
                        return (
                          <tr key={l.doItemId} className="border-b border-border-subtle">
                            <td className="py-2 pr-2">
                              <input
                                type="checkbox"
                                checked={pick.include}
                                onChange={() => toggleLine(l)}
                                className="h-4 w-4 accent-accent"
                              />
                            </td>
                            <td className="py-2 pr-2 font-mono text-[11px] text-ink-secondary">{l.doNumber}</td>
                            <td className="py-2 pr-2 font-mono text-[11px] text-ink">{l.itemCode}</td>
                            <td className="py-2 pr-2 text-ink-secondary">
                              {l.description || l.description2 || "—"}
                            </td>
                            <td className="py-2 pr-2 text-right font-mono text-ink-secondary">{l.remaining}</td>
                            <td className="py-2 pr-2 text-right">
                              <input
                                type="number"
                                min={0}
                                max={l.remaining}
                                step="1"
                                value={pick.qty}
                                onChange={(e) => setLineQty(l, e.target.value)}
                                className="h-9 w-24 rounded-md border border-border bg-surface px-2 text-right text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              />
                            </td>
                            <td className="py-2 pr-2 text-right font-mono text-ink-secondary">
                              {fmtCenti(l.unitPriceCenti)}
                            </td>
                            <td className="py-2 pr-2">
                              <input
                                type="text"
                                value={pick.reason}
                                onChange={(e) => setLineReason(l, e.target.value)}
                                placeholder="e.g. damaged"
                                disabled={!pick.include}
                                className="h-9 w-40 rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
                              />
                            </td>
                            <td className="py-2 text-right font-mono font-semibold text-ink">
                              {fmtCenti(lineRefund)}
                            </td>
                          </tr>
                        );
                      })}
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
                <p className="mt-2 text-[11px] text-ink-muted">
                  Only delivered, not-yet-invoiced quantity can be returned. A return restocks the goods
                  into the warehouse the DO shipped from and re-opens the source Sales Order.
                </p>
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
            <Button variant="secondary" onClick={() => navigate("/scm/delivery-returns")} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || chosen.length === 0}>
              {saving ? "Creating…" : "Create Return"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// Map an API error message to a friendly toast. The mutate helper throws
// `${status}: ${jsonBody}`, so the server's error code is a substring.
function failureMessage(e: unknown): string {
  const msg = String((e as Error)?.message ?? "");
  if (msg.includes("over_remaining"))
    return "A line returns more than its remaining (delivered − invoiced − returned) quantity.";
  if (msg.includes("race_conflict"))
    return "Another operator just returned overlapping qty — refresh and retry.";
  if (msg.includes("service_lines_not_returnable"))
    return "A service line (delivery / disposal) can't be returned — remove it.";
  if (msg.includes("do_link_required"))
    return "Every return line must reference a delivered Delivery Order line.";
  return "Failed to create return";
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
