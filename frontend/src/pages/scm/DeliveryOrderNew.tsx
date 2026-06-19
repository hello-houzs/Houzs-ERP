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
import { LineCard, LineField, lineInputCls, LineTotalRow } from "./_lineKit";

/* GET /api/scm/delivery-orders-mfg/deliverable-so-lines → { lines } — one row
   per SO LINE that can still be delivered (remaining = qty − delivered +
   returned, derived live). camelCase verbatim from soDeliverableRemaining
   (backend/src/scm/routes/delivery-orders-mfg.ts). A DO ships ONE customer's
   lines, so the picker groups these by customer and only lets you combine
   lines that share a debtor (the /from-sos endpoint enforces the same rule). */
interface DeliverableSoLine {
  soItemId: string;
  docNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unitPriceCenti: number;
  unitCostCenti: number;
  discountCenti: number;
  variants: unknown;
  delivered: number;
  returned: number;
  remaining: number;
  lineSeq: number;
}

// Same-customer key — debtor_code when present, else debtor_name. Mirrors
// custKey in the /from-sos endpoint so the client groups exactly how the server
// validates (a DO can only combine lines of ONE customer).
function custKey(l: DeliverableSoLine): string {
  return l.debtorCode && l.debtorCode.trim()
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? "").trim().toUpperCase()}`;
}

function custLabel(l: DeliverableSoLine): string {
  return l.debtorName || l.debtorCode || "(no customer)";
}

interface PickState {
  include: boolean;
  qty: number;
}

/**
 * ScmDeliveryOrderNew — full-page Create Delivery Order from Sales Order lines
 * at /scm/delivery-orders/new.
 *
 * Step 1: pick a customer (deliverable SO lines are grouped by debtor — a DO
 * ships one customer). Step 2: opt each of that customer's outstanding SO lines
 * in and set a qty (1..remaining). Post hits POST /from-sos, which builds one
 * DO, deducts stock and navigates to the new DO. Short-stock (409) is surfaced
 * as a confirm that retries with confirmShortStock so the operator can ship
 * anyway, switch warehouse, or reduce qty.
 */
export function ScmDeliveryOrderNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  const linesQ = useQuery<{ lines: DeliverableSoLine[] }>(
    () => api.get(`${SCM}/delivery-orders-mfg/deliverable-so-lines`),
    [],
  );

  const [customer, setCustomer] = useState<string | null>(null);
  // qty edits keyed by soItemId so they survive re-renders / customer switches.
  const [picks, setPicks] = useState<Record<string, PickState>>({});
  const [saving, setSaving] = useState(false);

  const allLines = useMemo(
    () => (linesQ.data?.lines ?? []).filter((l) => l.remaining > 0),
    [linesQ.data],
  );

  // Distinct customers for the picker, each carrying a line count.
  const customers = useMemo(() => {
    const byCust = new Map<
      string,
      { key: string; label: string; lineCount: number }
    >();
    for (const l of allLines) {
      const k = custKey(l);
      const cur = byCust.get(k);
      if (cur) cur.lineCount += 1;
      else byCust.set(k, { key: k, label: custLabel(l), lineCount: 1 });
    }
    return [...byCust.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [allLines]);

  // The selected customer's deliverable lines, in each SO's listing order.
  const lines = useMemo(() => {
    if (!customer) return [];
    return allLines
      .filter((l) => custKey(l) === customer)
      .sort(
        (a, b) =>
          a.docNo.localeCompare(b.docNo) || a.lineSeq - b.lineSeq || a.soItemId.localeCompare(b.soItemId),
      );
  }, [allLines, customer]);

  function pickFor(l: DeliverableSoLine): PickState {
    return picks[l.soItemId] ?? { include: false, qty: l.remaining };
  }

  function toggleLine(l: DeliverableSoLine) {
    setPicks((prev) => {
      const cur = prev[l.soItemId] ?? { include: false, qty: l.remaining };
      return { ...prev, [l.soItemId]: { ...cur, include: !cur.include } };
    });
  }

  function setLineQty(l: DeliverableSoLine, raw: string) {
    const n = Math.max(0, Number(raw) || 0);
    const capped = Math.min(n, l.remaining);
    setPicks((prev) => {
      const cur = prev[l.soItemId] ?? { include: false, qty: l.remaining };
      return {
        ...prev,
        [l.soItemId]: { include: capped > 0 ? true : cur.include, qty: capped },
      };
    });
  }

  // Switching customer clears the prior customer's selections so a DO can't
  // accidentally mix two debtors (the server rejects that anyway).
  function pickCustomer(key: string) {
    setCustomer(key);
    setPicks({});
  }

  const chosen = lines
    .map((l) => ({ line: l, pick: pickFor(l) }))
    .filter(({ pick }) => pick.include && pick.qty > 0);
  const subtotalCenti = chosen.reduce(
    (s, { line, pick }) => s + (pick.qty * line.unitPriceCenti - line.discountCenti),
    0,
  );

  async function postPicks(confirmShortStock: boolean): Promise<boolean> {
    const res = await api.post<{ id: string; doNumber: string }>(
      `${SCM}/delivery-orders-mfg/from-sos`,
      {
        picks: chosen.map(({ line, pick }) => ({ soItemId: line.soItemId, qty: pick.qty })),
        ...(confirmShortStock ? { confirmShortStock: true } : {}),
      },
    );
    toast.success(`Delivery order ${res.doNumber} created`);
    navigate(`/scm/delivery-orders/${res.id}`);
    return true;
  }

  async function submit() {
    if (!customer) {
      toast.error("Pick a customer to deliver to");
      return;
    }
    if (chosen.length === 0) {
      toast.error("Select at least one line with a quantity to deliver");
      return;
    }
    const ok = await dialog.confirm({
      title: "Create delivery order?",
      message:
        `This ships ${chosen.length} line(s) to ${custLabel(chosen[0].line)} (stock OUT) and posts a delivery order immediately. ` +
        "A DO ships on creation and cannot be un-shipped — it can only be cancelled.",
      confirmLabel: "Create Delivery Order",
    });
    if (!ok) return;

    setSaving(true);
    try {
      await postPicks(false);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      // Short-stock 409 — offer to ship anyway (the server waives the soft stock
      // check on retry; the no-sofa-batch rule still applies and re-rejects).
      if (msg.includes("short_stock")) {
        const shipAnyway = await dialog.confirm({
          title: "Stock not enough",
          message:
            "The selected warehouse is short on stock for one or more lines. " +
            "Ship anyway (stock goes negative), or cancel to switch warehouse / reduce qty first.",
          confirmLabel: "Ship anyway",
          danger: true,
        });
        if (shipAnyway) {
          try {
            await postPicks(true);
            return;
          } catch (e2) {
            toast.error(failureMessage(e2));
          }
        }
      } else {
        toast.error(failureMessage(e));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/delivery-orders")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Delivery Orders
      </button>
      <PageHeader
        eyebrow="Supply Chain"
        title="New Delivery Order"
        description="Ship a customer's outstanding Sales Order lines. Pick the customer, set delivery quantities, then post."
      />

      {/* Step 1 — pick the customer */}
      <Section title="1 · Select the customer">
        {linesQ.loading ? (
          <p className="text-[13px] text-ink-muted">Loading deliverable sales orders…</p>
        ) : linesQ.error ? (
          <EmptyState message="Failed to load deliverable sales orders" description={linesQ.error} />
        ) : customers.length === 0 ? (
          <EmptyState
            message="Nothing to deliver"
            description="There are no sales order lines with an outstanding quantity to ship."
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
                    {cst.lineCount} deliverable line{cst.lineCount === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {/* Step 2 — set delivery quantities */}
      {customer && (
        <>
          <Section title="2 · Lines to deliver">
            {lines.length === 0 ? (
              <EmptyState
                message="Nothing left to deliver"
                description="Every line for this customer has already been fully delivered."
              />
            ) : (
              <>
                <div className="space-y-2.5">
                  {lines.map((l, idx) => {
                    const pick = pickFor(l);
                    const lineTotal = pick.include
                      ? pick.qty * l.unitPriceCenti - l.discountCenti
                      : 0;
                    return (
                      <LineCard key={l.soItemId} index={idx + 1}>
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                          <LineField label="Ship">
                            <label className="flex h-9 items-center gap-2">
                              <input
                                type="checkbox"
                                checked={pick.include}
                                onChange={() => toggleLine(l)}
                                className="h-4 w-4 accent-accent"
                              />
                              <span className="text-[13px] text-ink-secondary">
                                {pick.include ? "Included" : "Excluded"}
                              </span>
                            </label>
                          </LineField>
                          <LineField label="SO">
                            <div className="flex h-9 items-center rounded-md border border-border-subtle bg-bg/50 px-2.5 font-mono text-[13px] text-ink-secondary">
                              {l.docNo}
                            </div>
                          </LineField>
                          <LineField label="Item">
                            <div className="flex h-9 items-center rounded-md border border-border-subtle bg-bg/50 px-2.5 font-mono text-[13px] text-ink">
                              {l.itemCode}
                            </div>
                          </LineField>
                        </div>
                        <LineField label="Description">
                          <div className="flex min-h-9 items-center rounded-md border border-border-subtle bg-bg/50 px-2.5 py-1.5 text-[13px] text-ink-secondary">
                            {l.description || l.description2 || "—"}
                          </div>
                        </LineField>
                        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                          <LineField label="Remaining" align="right">
                            <div className="flex h-9 items-center justify-end rounded-md border border-border-subtle bg-bg/50 px-2.5 font-mono text-[13px] text-ink-secondary">
                              {l.remaining}
                            </div>
                          </LineField>
                          <LineField label="Qty to Ship" align="right">
                            <input
                              type="number"
                              min={0}
                              max={l.remaining}
                              step="1"
                              value={pick.qty}
                              onChange={(e) => setLineQty(l, e.target.value)}
                              className={cn(lineInputCls, "text-right")}
                            />
                          </LineField>
                          <LineField label="Unit Price" align="right">
                            <div className="flex h-9 items-center justify-end rounded-md border border-border-subtle bg-bg/50 px-2.5 font-mono text-[13px] text-ink-secondary">
                              {fmtCenti(l.unitPriceCenti)}
                            </div>
                          </LineField>
                        </div>
                        <LineTotalRow>
                          <span className="text-[11px] uppercase tracking-brand text-ink-muted">Line Total</span>
                          <span className="font-mono font-semibold text-ink">{fmtCenti(lineTotal)}</span>
                        </LineTotalRow>
                      </LineCard>
                    );
                  })}
                </div>
                <div className="mt-3 flex justify-end border-t border-border pt-3">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Delivery Total
                    </span>
                    <span className="font-mono text-[15px] font-bold text-ink">
                      {fmtCenti(subtotalCenti)}
                    </span>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-ink-muted">
                  The delivery ships from each Sales Order line's bound warehouse. A DO posts immediately
                  (stock OUT) and is irreversible (cancel only).
                </p>
              </>
            )}
          </Section>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => navigate("/scm/delivery-orders")} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || chosen.length === 0}>
              {saving ? "Creating…" : "Create Delivery Order"}
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
  if (msg.includes("mixed_customers"))
    return "All picked lines must belong to the same customer.";
  if (msg.includes("over_remaining"))
    return "A line ships more than its remaining quantity — refresh and retry.";
  if (msg.includes("race_conflict"))
    return "Another operator just shipped overlapping qty — refresh and retry.";
  if (msg.includes("sofa_no_batch") || msg.includes("sofa_partial_set"))
    return "A sofa line has no complete production batch (or set) yet — it can't ship.";
  return "Failed to create delivery order";
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
