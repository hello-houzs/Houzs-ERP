import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Plus, Save, Trash2 } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM } from "../../lib/scm";
import { Field, Input } from "./Suppliers";

// ── Picker response shapes (snake_case, verbatim from the Hono routes) ──────
// GET /api/scm/inventory/warehouses
interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}
// GET /api/scm/mfg-products — full SKU catalogue for the line picker.
interface ProductRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
}

// ── Per-line draft row ──────────────────────────────────────────────────────
// A stock transfer line carries no money — just SKU + qty (+ optional notes).
// Maps to the POST body items: [{ productCode, productName?, qty, notes? }].
interface DraftLine {
  rid: string;
  productCode: string;
  productName: string;
  qty: number;
  notes: string;
}

let ridCounter = 0;
function newLine(): DraftLine {
  ridCounter += 1;
  return { rid: `l${ridCounter}`, productCode: "", productName: "", qty: 1, notes: "" };
}

// Today's date as YYYY-MM-DD for the <input type="date"> default.
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ScmStockTransferNew — full-page Create Stock Transfer at
 * /scm/stock-transfers/new.
 *
 * Header (from + to warehouse, transfer date, notes) above an inline line
 * editor (SKU + qty per row). The backend posts the transfer immediately on
 * create — paired OUT@from / IN@to inventory movements are written inline and
 * the move is irreversible without an explicit Cancel — so Save is confirm-
 * gated. On success we navigate to the new transfer's detail page.
 */
export function ScmStockTransferNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  // ── Header state ──────────────────────────────────────────────────────
  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [transferDate, setTransferDate] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [saving, setSaving] = useState(false);

  // ── Pickers ───────────────────────────────────────────────────────────
  const warehousesQ = useQuery<{ warehouses: WarehouseOption[] }>(
    () => api.get(`${SCM}/inventory/warehouses`),
    [],
  );
  const productsQ = useQuery<{ products: ProductRow[] }>(
    () => api.get(`${SCM}/mfg-products`),
    [],
  );

  const warehouses = warehousesQ.data?.warehouses ?? [];
  const products = productsQ.data?.products ?? [];
  const skuByCode = useMemo(
    () => new Map(products.map((p) => [p.code, p])),
    [products],
  );

  // ── Line helpers ──────────────────────────────────────────────────────
  const setLine = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);

  // Picking a code auto-fills the description from the master SKU list.
  function pickCode(rid: string, code: string) {
    const sku = skuByCode.get(code);
    setLine(rid, { productCode: code, productName: sku?.name ?? "" });
  }

  async function dropLine(rid: string) {
    const line = lines.find((l) => l.rid === rid);
    const hasData = line && (line.productCode.trim() || line.notes.trim());
    if (hasData) {
      const ok = await dialog.confirm({
        title: "Remove this line?",
        message: "The entered item and quantity on this line will be discarded.",
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

  const sameWarehouse = Boolean(
    fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId,
  );

  const dirty =
    Boolean(fromWarehouseId || toWarehouseId || notes.trim()) ||
    lines.some((l) => l.productCode.trim());

  // ── Save (post) — confirm-gated, irreversible ─────────────────────────
  async function submit() {
    if (!fromWarehouseId) {
      toast.error("Pick a source warehouse");
      return;
    }
    if (!toWarehouseId) {
      toast.error("Pick a destination warehouse");
      return;
    }
    if (sameWarehouse) {
      toast.error("Source and destination must be different warehouses");
      return;
    }
    if (!transferDate) {
      toast.error("Transfer date is required");
      return;
    }
    const validLines = lines.filter((l) => l.productCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      toast.error("Add at least one line item with a quantity");
      return;
    }

    const fromName = warehouses.find((w) => w.id === fromWarehouseId);
    const toName = warehouses.find((w) => w.id === toWarehouseId);
    const ok = await dialog.confirm({
      title: "Post this stock transfer?",
      message:
        `${validLines.length} item line(s) will move from ` +
        `${fromName ? `${fromName.code} · ${fromName.name}` : "the source"} to ` +
        `${toName ? `${toName.code} · ${toName.name}` : "the destination"}. ` +
        "Posting writes the inventory movements immediately and can only be undone by cancelling the transfer.",
      confirmLabel: "Post Transfer",
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await api.post<{ id: string; transferNo: string; movementErrors?: string[] }>(
        `${SCM}/stock-transfers`,
        {
          fromWarehouseId,
          toWarehouseId,
          transferDate,
          notes: notes.trim() || undefined,
          items: validLines.map((l) => ({
            productCode: l.productCode.trim(),
            productName: l.productName.trim() || undefined,
            qty: l.qty,
            notes: l.notes.trim() || undefined,
          })),
        },
      );
      if (res.movementErrors && res.movementErrors.length > 0) {
        toast.error(
          `Transfer ${res.transferNo} posted with ${res.movementErrors.length} movement issue(s)`,
        );
      } else {
        toast.success(`Stock transfer ${res.transferNo} posted`);
      }
      navigate(`/scm/stock-transfers/${res.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(`Failed to post stock transfer${msg ? `: ${msg}` : ""}`);
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/stock-transfers")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Stock Transfers
      </button>

      <PageHeader
        eyebrow="Supply Chain"
        title="New Stock Transfer"
        description="Move stock between warehouses — a paired out/in movement per posted transfer."
        primaryAction={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => navigate("/scm/stock-transfers")}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button icon={<Save size={15} />} onClick={submit} disabled={saving}>
              {saving ? "Posting…" : "Post Transfer"}
            </Button>
          </div>
        }
      />

      {/* Header card */}
      <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-px w-3 bg-accent/60" />
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Transfer
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="From Warehouse" required>
            <select
              value={fromWarehouseId}
              onChange={(e) => setFromWarehouseId(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— Pick source —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To Warehouse" required>
            <select
              value={toWarehouseId}
              onChange={(e) => setToWarehouseId(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— Pick destination —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id} disabled={w.id === fromWarehouseId}>
                  {w.code} · {w.name}
                  {w.id === fromWarehouseId ? " (source)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Transfer Date" required>
            <input
              type="date"
              value={transferDate}
              onChange={(e) => setTransferDate(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </Field>
          <Field label="Notes">
            <Input value={notes} onChange={setNotes} placeholder="Reason, reference…" />
          </Field>
        </div>
        {sameWarehouse && (
          <p className="mt-3 text-[11.5px] font-medium text-err">
            Source and destination warehouses must be different.
          </p>
        )}
      </div>

      {/* Line items */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Items ({lines.length})
        </h3>
      </div>

      <div className="space-y-3">
        {lines.map((l, idx) => (
          <div
            key={l.rid}
            className="rounded-lg border border-border bg-surface p-4 shadow-stone"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-brand text-ink-muted">
                Line {idx + 1}
                <ArrowRight size={11} className="text-ink-muted/70" />
              </span>
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

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Item Code">
                <input
                  type="text"
                  list={`xfer-items-${l.rid}`}
                  value={l.productCode}
                  onChange={(e) => pickCode(l.rid, e.target.value)}
                  placeholder="Type or pick a SKU…"
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <datalist id={`xfer-items-${l.rid}`}>
                  {products.map((p) => (
                    <option key={p.id} value={p.code}>
                      {p.name}
                      {p.category ? ` · ${p.category}` : ""}
                    </option>
                  ))}
                </datalist>
              </Field>
              <Field label="Qty">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={l.qty}
                  onChange={(e) =>
                    setLine(l.rid, { qty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                  }
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 text-right text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </Field>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Description">
                <Input
                  value={l.productName}
                  onChange={(v) => setLine(l.rid, { productName: v })}
                  placeholder="Auto-filled when a SKU is picked"
                />
              </Field>
              <Field label="Line Notes">
                <Input
                  value={l.notes}
                  onChange={(v) => setLine(l.rid, { notes: v })}
                  placeholder="Optional"
                />
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

      {/* Footer save mirrors the header action for long forms */}
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => navigate("/scm/stock-transfers")}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button icon={<Save size={15} />} onClick={submit} disabled={saving || !dirty}>
          {saving ? "Posting…" : "Post Transfer"}
        </Button>
      </div>
    </div>
  );
}
