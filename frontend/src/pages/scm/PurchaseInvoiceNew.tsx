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
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { Field, Input } from "./Suppliers";

/* GET /api/scm/purchase-invoices/outstanding-grn-items → { items } — every
   POSTED-GRN line that still has remaining (qty_accepted − invoiced − returned)
   to bill. Each row carries its parent GRN + supplier so we can group the picker
   by GRN. snake/camel mix is verbatim from the Hono route's mapped output. */
interface OutstandingGrnItem {
  grnItemId: string;
  grnId: string;
  grnDocNo: string;
  receivedAt: string | null;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  purchaseOrderId: string | null;
  poDocNo: string | null;
  itemCode: string | null;
  description: string | null;
  itemGroup: string | null;
  qtyAccepted: number;
  invoicedQty: number;
  remaining: number;
  unitPriceCenti: number;
}

interface GrnGroup {
  grnId: string;
  grnDocNo: string;
  receivedAt: string | null;
  supplierName: string;
  supplierCode: string;
  poDocNo: string | null;
  lines: OutstandingGrnItem[];
}

// A working line in the builder — qty is the (editable) amount to invoice,
// clamped to the GRN line's remaining.
interface DraftLine {
  grnItemId: string;
  itemCode: string | null;
  description: string | null;
  remaining: number;
  unitPriceCenti: number;
  qty: number;
  include: boolean;
}

export function ScmPurchaseInvoiceNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  const picker = useQuery<{ items: OutstandingGrnItem[] }>(
    () => api.get(`${SCM}/purchase-invoices/outstanding-grn-items`),
    [],
  );

  const [grnId, setGrnId] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Group the flat outstanding lines by their parent GRN for the picker.
  const groups = useMemo<GrnGroup[]>(() => {
    const items = picker.data?.items ?? [];
    const byGrn = new Map<string, GrnGroup>();
    for (const it of items) {
      const g = byGrn.get(it.grnId) ?? {
        grnId: it.grnId,
        grnDocNo: it.grnDocNo,
        receivedAt: it.receivedAt,
        supplierName: it.supplierName,
        supplierCode: it.supplierCode,
        poDocNo: it.poDocNo,
        lines: [],
      };
      g.lines.push(it);
      byGrn.set(it.grnId, g);
    }
    return [...byGrn.values()];
  }, [picker.data]);

  const selectedGroup = groups.find((g) => g.grnId === grnId) ?? null;

  function pickGrn(g: GrnGroup) {
    setGrnId(g.grnId);
    setLines(
      g.lines.map((l) => ({
        grnItemId: l.grnItemId,
        itemCode: l.itemCode,
        description: l.description,
        remaining: l.remaining,
        unitPriceCenti: l.unitPriceCenti,
        qty: l.remaining, // default to billing the whole remaining qty
        include: true,
      })),
    );
  }

  function setLineQty(grnItemId: string, raw: string) {
    const n = Math.max(0, Number(raw) || 0);
    setLines((prev) =>
      prev.map((l) =>
        l.grnItemId === grnItemId ? { ...l, qty: Math.min(n, l.remaining) } : l,
      ),
    );
  }

  function toggleLine(grnItemId: string) {
    setLines((prev) =>
      prev.map((l) => (l.grnItemId === grnItemId ? { ...l, include: !l.include } : l)),
    );
  }

  const picks = lines.filter((l) => l.include && l.qty > 0);
  const subtotal = picks.reduce((s, l) => s + l.qty * l.unitPriceCenti, 0);
  const dirty = grnId !== null;

  async function submit() {
    if (!selectedGroup) {
      toast.error("Pick a GRN to invoice");
      return;
    }
    if (picks.length === 0) {
      toast.error("Select at least one line with a quantity");
      return;
    }
    const ok = await dialog.confirm({
      title: "Post purchase invoice?",
      message: `This creates and posts a purchase invoice for ${picks.length} line(s) from ${selectedGroup.grnDocNo} (subtotal ${fmtCenti(subtotal)}). A posted invoice can't be un-posted.`,
      confirmLabel: "Post Invoice",
    });
    if (!ok) return;

    setSaving(true);
    try {
      // POST /from-grn-items: { picks:[{grnItemId, qty}], supplierInvoiceNumber?,
      // invoiceDate?, dueDate?, notes? } → 201 { created:[{id,...}], total }.
      // One GRN ↔ one PI, so a single-GRN pick yields exactly one created PI.
      const res = await api.post<{
        created: Array<{ id: string; invoiceNumber: string }>;
        total: number;
      }>(`${SCM}/purchase-invoices/from-grn-items`, {
        picks: picks.map((l) => ({ grnItemId: l.grnItemId, qty: l.qty })),
        supplierInvoiceNumber: supplierInvoiceNumber.trim() || undefined,
        invoiceDate: invoiceDate || undefined,
        dueDate: dueDate || undefined,
        notes: notes.trim() || undefined,
      });
      const created = res.created?.[0];
      if (!created) {
        toast.error("No invoice was created — the GRN may already be fully invoiced");
        return;
      }
      toast.success(`Invoice ${created.invoiceNumber} posted`);
      navigate(`/scm/purchase-invoices/${created.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(
        msg.includes("qty_exceeds_remaining")
          ? "A line exceeds its remaining quantity — reload and try again"
          : "Failed to post invoice",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/purchase-invoices")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Purchase Invoices
      </button>
      <PageHeader
        eyebrow="Supply Chain"
        title="New Purchase Invoice"
        description="Bill a posted goods receipt (GRN). Pick the GRN, confirm the quantities, then post."
      />

      {/* Step 1 — pick a GRN */}
      <Section title="1 · Select a GRN to invoice">
        {picker.loading ? (
          <p className="text-[13px] text-ink-muted">Loading goods receipts…</p>
        ) : picker.error ? (
          <EmptyState message="Failed to load goods receipts" description={picker.error} />
        ) : groups.length === 0 ? (
          <EmptyState
            message="Nothing to invoice"
            description="Every posted GRN has been fully invoiced."
          />
        ) : (
          <div className="space-y-2">
            {groups.map((g) => {
              const active = g.grnId === grnId;
              return (
                <button
                  key={g.grnId}
                  onClick={() => pickGrn(g)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-accent bg-accent-soft"
                      : "border-border bg-surface hover:border-accent/40",
                  )}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[12px] font-semibold text-ink">{g.grnDocNo}</div>
                    <div className="truncate text-[12px] text-ink-secondary">
                      {g.supplierName || g.supplierCode || "—"}
                      {g.poDocNo ? ` · ${g.poDocNo}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-ink-muted">
                    <div>{g.receivedAt ? formatDate(g.receivedAt) : "—"}</div>
                    <div>{g.lines.length} line(s) to bill</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {/* Step 2 — confirm lines + enter header */}
      {selectedGroup && (
        <>
          <Section title={`2 · Lines from ${selectedGroup.grnDocNo}`}>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    <th className="py-2 pr-2 font-semibold">Bill</th>
                    <th className="py-2 pr-2 font-semibold">Item</th>
                    <th className="py-2 pr-2 font-semibold">Description</th>
                    <th className="py-2 pr-2 text-right font-semibold">Remaining</th>
                    <th className="py-2 pr-2 text-right font-semibold">Qty to Bill</th>
                    <th className="py-2 pr-2 text-right font-semibold">Unit Price</th>
                    <th className="py-2 text-right font-semibold">Line Total</th>
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
                      <td className="py-2 pr-2 font-mono text-[11px] text-ink">{l.itemCode || "—"}</td>
                      <td className="py-2 pr-2 text-ink-secondary">{l.description || "—"}</td>
                      <td className="py-2 pr-2 text-right font-mono text-ink-secondary">{l.remaining}</td>
                      <td className="py-2 pr-2 text-right">
                        <input
                          type="number"
                          min={0}
                          max={l.remaining}
                          step="0.01"
                          value={l.qty}
                          disabled={!l.include}
                          onChange={(e) => setLineQty(l.grnItemId, e.target.value)}
                          className="h-9 w-24 rounded-md border border-border bg-surface px-2 text-right text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
                        />
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-ink-secondary">
                        {fmtCenti(l.unitPriceCenti)}
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
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Subtotal</span>
                <span className="font-mono text-[15px] font-bold text-ink">{fmtCenti(subtotal)}</span>
              </div>
            </div>
          </Section>

          <Section title="3 · Invoice details">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Supplier Invoice No.">
                <Input
                  value={supplierInvoiceNumber}
                  onChange={setSupplierInvoiceNumber}
                  placeholder="Supplier's reference"
                />
              </Field>
              <Field label="Invoice Date">
                <Input value={invoiceDate} onChange={setInvoiceDate} type="date" />
              </Field>
              <Field label="Due Date">
                <Input value={dueDate} onChange={setDueDate} type="date" />
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
              onClick={() => navigate("/scm/purchase-invoices")}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || picks.length === 0}>
              {saving ? "Posting…" : "Post Invoice"}
            </Button>
          </div>
        </>
      )}

      {/* Guard against accidental nav-away while a draft is in progress is left
          to the route (no Panel here); the dirty flag is tracked for parity. */}
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
