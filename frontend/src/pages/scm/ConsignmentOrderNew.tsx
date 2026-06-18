import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { Field, Input, Select } from "./Suppliers";

// GET /api/scm/mfg-products — the sellable SKU catalogue. The CO authors the
// selling price server-side from this master, but we seed the line's unit price
// from sell_price_sen so the operator sees a figure before saving.
interface ProductRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
  sell_price_sen?: number | null;
  price1_sen?: number | null;
  base_price_sen?: number | null;
}

function rmToSen(rm: string): number {
  const n = parseFloat(rm);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}
function senToRm(sen: number): string {
  return (sen / 100).toFixed(2);
}

// Per-line draft. item_group drives the CO header category split server-side, so
// seed it from the picked SKU's category (lowercased).
interface DraftLine {
  rid: string;
  itemCode: string;
  description: string;
  itemGroup: string;
  qty: number;
  unitPriceRm: string;
}

let ridCounter = 0;
function newLine(): DraftLine {
  ridCounter += 1;
  return { rid: `l${ridCounter}`, itemCode: "", description: "", itemGroup: "others", qty: 1, unitPriceRm: "" };
}

const CURRENCIES = ["MYR", "RMB", "USD", "SGD"];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ScmConsignmentOrderNew — full-page Create Consignment Order at
 * /scm/consignment-orders/new. Consignee is free-text (name + phone required);
 * lines pick a SKU from the mfg-products master. The CO writes NO inventory
 * (order only) and is created CONFIRMED.
 */
export function ScmConsignmentOrderNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  // ── Header state ──────────────────────────────────────────────────────
  const [debtorName, setDebtorName] = useState("");
  const [phone, setPhone] = useState("");
  const [debtorCode, setDebtorCode] = useState("");
  const [agent, setAgent] = useState("");
  const [venue, setVenue] = useState("");
  const [ref, setRef] = useState("");
  const [soDate, setSoDate] = useState(todayIso());
  const [currency, setCurrency] = useState("MYR");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [saving, setSaving] = useState(false);

  const productsQ = useQuery<{ products: ProductRow[] }>(
    () => api.get(`${SCM}/mfg-products`),
    [],
  );
  const products = productsQ.data?.products ?? [];

  const setLine = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);

  async function dropLine(rid: string) {
    const line = lines.find((l) => l.rid === rid);
    const hasData = line && (line.itemCode.trim() || line.unitPriceRm.trim());
    if (hasData) {
      const ok = await dialog.confirm({
        title: "Remove this line?",
        message: "The entered item, quantity and price on this line will be discarded.",
        confirmLabel: "Remove line",
        danger: true,
      });
      if (!ok) return;
    }
    setLines((prev) => {
      const next = prev.filter((l) => l.rid !== rid);
      return next.length ? next : [newLine()];
    });
  }

  function pickItem(rid: string, code: string) {
    const sku = products.find((p) => p.code === code);
    if (!sku) {
      setLine(rid, { itemCode: code });
      return;
    }
    const seed = sku.sell_price_sen ?? sku.price1_sen ?? sku.base_price_sen ?? 0;
    setLine(rid, {
      itemCode: sku.code,
      description: sku.name,
      itemGroup: sku.category?.toLowerCase() || "others",
      unitPriceRm: seed > 0 ? senToRm(seed) : "",
    });
  }

  const lineTotalSen = (l: DraftLine) => Math.max(0, l.qty * rmToSen(l.unitPriceRm));
  const subtotalSen = useMemo(() => lines.reduce((s, l) => s + lineTotalSen(l), 0), [lines]);

  const dirty =
    Boolean(debtorName.trim() || phone.trim() || agent.trim() || venue.trim() || note.trim()) ||
    lines.some((l) => l.itemCode.trim() || l.unitPriceRm.trim());

  const fmt = (sen: number) => fmtCenti(sen, currency);

  async function submit() {
    if (!debtorName.trim()) {
      toast.error("Consignee name is required");
      return;
    }
    if (!phone.trim()) {
      toast.error("A phone number is required on every consignment order");
      return;
    }
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      toast.error("Add at least one line item with a quantity");
      return;
    }

    setSaving(true);
    try {
      // POST /consignment-orders: { debtorName, phone (required), debtorCode?,
      // agent?, venue?, ref?, soDate?, currency, note?, items:[{ itemCode,
      // itemGroup, description?, qty, unitPriceCenti }] } → 201 { docNo }. The
      // server re-authors the selling price + computes the header totals.
      const res = await api.post<{ docNo: string }>(`${SCM}/consignment-orders`, {
        debtorName: debtorName.trim(),
        phone: phone.trim(),
        debtorCode: debtorCode.trim() || undefined,
        agent: agent.trim() || undefined,
        venue: venue.trim() || undefined,
        ref: ref.trim() || undefined,
        soDate,
        currency,
        note: note.trim() || undefined,
        items: validLines.map((l) => ({
          itemCode: l.itemCode.trim(),
          itemGroup: l.itemGroup || "others",
          description: l.description.trim() || undefined,
          qty: l.qty,
          unitPriceCenti: rmToSen(l.unitPriceRm),
        })),
      });
      toast.success(`Consignment order ${res.docNo} created`);
      navigate(`/scm/consignment-orders/${encodeURIComponent(res.docNo)}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(
        msg.includes("unknown_item_code")
          ? "One or more item codes are not in the catalogue"
          : `Failed to create consignment order${msg ? `: ${msg}` : ""}`,
      );
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/consignment-orders")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Consignment Orders
      </button>

      <PageHeader
        eyebrow="Supply Chain"
        title="New Consignment Order"
        description="Place goods on consignment at a consignee. The order writes no inventory — the note ships it out later."
        primaryAction={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate("/scm/consignment-orders")} disabled={saving}>
              Cancel
            </Button>
            <Button icon={<Save size={15} />} onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Create Order"}
            </Button>
          </div>
        }
      />

      {/* Header card */}
      <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-px w-3 bg-accent/60" />
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Consignee</h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Consignee Name" required>
            <Input value={debtorName} onChange={setDebtorName} placeholder="Consignee / debtor name" />
          </Field>
          <Field label="Phone" required>
            <Input value={phone} onChange={setPhone} placeholder="Contact phone" />
          </Field>
          <Field label="Debtor Code">
            <Input value={debtorCode} onChange={setDebtorCode} placeholder="Optional account code" />
          </Field>
          <Field label="Agent">
            <Input value={agent} onChange={setAgent} placeholder="Sales agent" />
          </Field>
          <Field label="Venue">
            <Input value={venue} onChange={setVenue} placeholder="Consignment venue" />
          </Field>
          <Field label="Reference">
            <Input value={ref} onChange={setRef} placeholder="Customer ref / PO" />
          </Field>
          <Field label="Order Date">
            <input
              type="date"
              value={soDate}
              onChange={(e) => setSoDate(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </Field>
          <Field label="Currency">
            <Select value={currency} onChange={setCurrency} options={CURRENCIES} />
          </Field>
          <Field label="Notes">
            <Input value={note} onChange={setNote} placeholder="Internal notes…" />
          </Field>
        </div>
      </div>

      {/* Line items */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Line Items ({lines.length})
        </h3>
      </div>

      <div className="space-y-3">
        {lines.map((l, idx) => (
          <div key={l.rid} className="rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-[11px] font-bold uppercase tracking-brand text-ink-muted">Line {idx + 1}</span>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[13px] font-semibold text-ink">{fmt(lineTotalSen(l))}</span>
                <button
                  type="button"
                  onClick={() => dropLine(l.rid)}
                  title="Remove line"
                  aria-label="Remove line"
                  className="inline-flex items-center justify-center rounded p-1 text-ink-muted transition-colors hover:bg-err/5 hover:text-err"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Item Code">
                <input
                  type="text"
                  list={`co-items-${l.rid}`}
                  value={l.itemCode}
                  onChange={(e) => pickItem(l.rid, e.target.value)}
                  placeholder="Type or pick a SKU…"
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <datalist id={`co-items-${l.rid}`}>
                  {products.map((p) => (
                    <option key={p.id} value={p.code}>
                      {p.name} · {p.category ?? ""}
                    </option>
                  ))}
                </datalist>
              </Field>
              <Field label="Description">
                <Input
                  value={l.description}
                  onChange={(v) => setLine(l.rid, { description: v })}
                  placeholder="Auto-filled from the SKU — editable"
                />
              </Field>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Qty">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={l.qty}
                  onChange={(e) => setLine(l.rid, { qty: Math.max(0, Number(e.target.value)) })}
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 text-right text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </Field>
              <Field label={`Unit Price (${currency})`}>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={l.unitPriceRm}
                  onChange={(e) => setLine(l.rid, { unitPriceRm: e.target.value })}
                  placeholder="0.00"
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 text-right font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </Field>
              <Field label="Line Total">
                <div className="flex h-10 items-center justify-end rounded-md border border-border-subtle bg-bg/50 px-3 font-mono text-[13px] font-semibold text-ink">
                  {fmt(lineTotalSen(l))}
                </div>
              </Field>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={addLine}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-accent/50 px-4 py-3 text-[13px] font-semibold text-accent transition-colors hover:bg-accent-soft"
        >
          <Plus size={15} /> Add another item
        </button>
      </div>

      {/* Totals */}
      <div className="mt-5 flex justify-end">
        <div className="w-full max-w-xs rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="flex items-center justify-between text-[13px] text-ink-secondary">
            <span>Subtotal</span>
            <span className="font-mono text-ink">{fmt(subtotalSen)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border-subtle pt-2 text-[15px] font-bold text-ink">
            <span>Total</span>
            <span className="font-mono">{fmt(subtotalSen)}</span>
          </div>
          <p className="mt-2 text-[11px] text-ink-muted">
            The server re-authors the selling price from the catalogue on save — this is an estimate.
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => navigate("/scm/consignment-orders")} disabled={saving}>
          Cancel
        </Button>
        <Button icon={<Save size={15} />} onClick={submit} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Create Order"}
        </Button>
      </div>
    </div>
  );
}
