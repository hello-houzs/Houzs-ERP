import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ImagePlus, Plus, Save, X } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { Field, Input, Select } from "./Suppliers";
import { LineCard, LineField, lineInputCls, LineTotalRow } from "./_lineKit";

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
  // Client-only staged photos — uploaded after the CO is created (the create
  // POST carries no multipart). Consignment lines never split server-side, so
  // positional item_code matching is always unambiguous here.
  stagedPhotos: File[];
}

// Server photo guard (consignment-orders.ts): 10 MB, image/* only.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

let ridCounter = 0;
function newLine(): DraftLine {
  ridCounter += 1;
  return { rid: `l${ridCounter}`, itemCode: "", description: "", itemGroup: "others", qty: 1, unitPriceRm: "", stagedPhotos: [] };
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
      // ── Post-create photo upload ─────────────────────────────────────────
      // Consignment lines never split server-side (1 draft → 1 saved item), so
      // matching by item_code in document order is unambiguous. Still guard each
      // upload + soft-warn on any miss; never block the created order.
      const linesWithPhotos = validLines.filter((l) => l.stagedPhotos.length > 0);
      if (linesWithPhotos.length > 0) {
        try {
          const detail = await api.get<{ items: Array<{ id: string; item_code: string; cancelled?: boolean }> }>(
            `${SCM}/consignment-orders/${encodeURIComponent(res.docNo)}`,
          );
          const savedByCode = new Map<string, string[]>();
          for (const it of detail.items ?? []) {
            if (it.cancelled) continue;
            const arr = savedByCode.get(it.item_code) ?? [];
            arr.push(it.id);
            savedByCode.set(it.item_code, arr);
          }
          const draftCountByCode = new Map<string, number>();
          for (const l of linesWithPhotos) {
            draftCountByCode.set(l.itemCode, (draftCountByCode.get(l.itemCode) ?? 0) + 1);
          }
          let uploaded = 0;
          let skipped = 0;
          let failed = 0;
          for (const l of linesWithPhotos) {
            const queue = savedByCode.get(l.itemCode) ?? [];
            // One saved row per draft is the norm; >1 with the same code on
            // multiple photo drafts is the only ambiguity we skip.
            const ambiguous =
              queue.length === 0 ||
              ((draftCountByCode.get(l.itemCode) ?? 0) > 1 && queue.length !== draftCountByCode.get(l.itemCode));
            if (ambiguous) {
              skipped += 1;
              continue;
            }
            const itemId = queue.shift()!;
            for (const file of l.stagedPhotos) {
              try {
                await api.uploadFile(
                  `${SCM}/consignment-orders/${encodeURIComponent(res.docNo)}/items/${encodeURIComponent(itemId)}/photos`,
                  file,
                );
                uploaded += 1;
              } catch {
                failed += 1;
              }
            }
          }
          if (uploaded > 0) toast.success(`Uploaded ${uploaded} photo${uploaded === 1 ? "" : "s"}`);
          if (skipped > 0)
            toast.warning(
              `${skipped} line${skipped === 1 ? "" : "s"} had photos that couldn't be matched — add them on the order detail page.`,
            );
          if (failed > 0)
            toast.error(`${failed} photo${failed === 1 ? "" : "s"} failed to upload — retry on the order detail page.`);
        } catch {
          toast.warning("Order created, but photos couldn't be uploaded — add them on the order detail page.");
        }
      }

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

      <div className="space-y-2.5">
        {lines.map((l, idx) => (
          <LineCard key={l.rid} index={idx + 1} onRemove={() => dropLine(l.rid)}>
            <LineField label="Item" required>
              <input
                type="text"
                list={`co-items-${l.rid}`}
                value={l.itemCode}
                onChange={(e) => pickItem(l.rid, e.target.value)}
                placeholder="Type or pick a SKU…"
                className={`${lineInputCls} font-mono`}
              />
              <datalist id={`co-items-${l.rid}`}>
                {products.map((p) => (
                  <option key={p.id} value={p.code}>
                    {p.name} · {p.category ?? ""}
                  </option>
                ))}
              </datalist>
            </LineField>

            <LineField label="Description">
              <input
                type="text"
                value={l.description}
                onChange={(e) => setLine(l.rid, { description: e.target.value })}
                placeholder="Auto-filled from the SKU — editable"
                className={lineInputCls}
              />
            </LineField>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              <LineField label="Qty" align="right">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={l.qty}
                  onChange={(e) => setLine(l.rid, { qty: Math.max(0, Number(e.target.value)) })}
                  className={`${lineInputCls} text-right`}
                />
              </LineField>
              <LineField label={`Unit Price (${currency})`} align="right">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={l.unitPriceRm}
                  onChange={(e) => setLine(l.rid, { unitPriceRm: e.target.value })}
                  placeholder="0.00"
                  className={`${lineInputCls} text-right font-mono`}
                />
              </LineField>
            </div>

            {l.itemCode.trim() && (
              <LineField label="Photos">
                <PhotoStrip
                  files={l.stagedPhotos}
                  onAdd={(files) => setLine(l.rid, { stagedPhotos: [...l.stagedPhotos, ...files] })}
                  onRemove={(idx) => setLine(l.rid, { stagedPhotos: l.stagedPhotos.filter((_, i) => i !== idx) })}
                />
              </LineField>
            )}

            <LineTotalRow>
              <span className="text-ink-muted">Line total</span>
              <span className="font-mono font-semibold text-ink">{fmt(lineTotalSen(l))}</span>
            </LineTotalRow>
          </LineCard>
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

// ── PhotoStrip — staged per-line photos with object-URL previews ─────────────
// Files upload AFTER the CO is created (the create POST has no multipart). The
// strip validates against the server guard (image/* + 10MB) up front and
// confirm-gates removal so there are no naked deletes.
function PhotoStrip({
  files,
  onAdd,
  onRemove,
}: {
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (idx: number) => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const next = files.map((f) => URL.createObjectURL(f));
    setUrls(next);
    return () => next.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    const accepted: File[] = [];
    for (const f of picked) {
      if (!f.type || !f.type.toLowerCase().startsWith("image/")) {
        toast.error(`"${f.name}" isn't an image — skipped`);
        continue;
      }
      if (f.size > MAX_PHOTO_BYTES) {
        toast.error(`"${f.name}" is over 10MB — skipped`);
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length > 0) onAdd(accepted);
  }

  async function remove(idx: number) {
    const ok = await dialog.confirm({
      title: "Remove photo",
      message: "Remove this staged photo? It hasn't been uploaded yet.",
      danger: true,
      confirmLabel: "Remove",
    });
    if (ok) onRemove(idx);
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={onPick} />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-accent/50 px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent-soft"
        >
          <ImagePlus size={13} /> Add Photos
        </button>
        {files.length > 0 && (
          <span className="text-[11px] text-ink-muted">
            {files.length} staged · uploaded after the order is created
          </span>
        )}
      </div>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <div
              key={`${f.name}-${f.size}-${i}`}
              className="relative h-16 w-16 overflow-hidden rounded-md border border-border bg-surface-dim"
            >
              {urls[i] && <img src={urls[i]} alt={f.name} className="h-full w-full object-cover" />}
              <button
                type="button"
                onClick={() => void remove(i)}
                title="Remove photo"
                aria-label="Remove photo"
                className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink/60 text-white transition-colors hover:bg-err"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
