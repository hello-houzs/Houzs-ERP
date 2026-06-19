import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { Field, Input, Select } from "./Suppliers";
import { LineCard, LineField, lineInputCls, LineTotalRow } from "./_lineKit";

// ── Picker response shapes (snake_case, verbatim from the Hono routes) ──────
// GET /api/scm/suppliers
interface SupplierOption {
  id: string;
  code: string;
  name: string;
  currency: string | null;
  status: string;
}
// GET /api/scm/inventory/warehouses
interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}
// GET /api/scm/suppliers/:id/bindings — the supplier's per-material cost book.
interface BindingRow {
  id: string;
  material_kind: string;
  material_code: string;
  material_name: string;
  supplier_sku: string | null;
  unit_price_centi: number;
  currency: string | null;
}
// GET /api/scm/mfg-products — full SKU catalogue (fallback picker for an item
// the supplier isn't bound to).
interface ProductRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
}

// ── Money helpers — the form holds RM strings, the API takes integer sen ────
function rmToSen(rm: string): number {
  const n = parseFloat(rm);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}
function senToRm(sen: number): string {
  return (sen / 100).toFixed(2);
}

// ── Per-line draft row ──────────────────────────────────────────────────────
// materialKind uses the schema's lowercase enum so the POST body lines up with
// purchase-consignment-orders.ts VALID_KINDS.
interface DraftLine {
  rid: string;
  bindingId?: string;
  materialKind: "mfg_product" | "fabric" | "raw";
  materialCode: string;
  materialName: string;
  supplierSku: string;
  qty: number;
  unitPriceRm: string;
  itemGroup?: string;
}

let ridCounter = 0;
function newLine(): DraftLine {
  ridCounter += 1;
  return {
    rid: `l${ridCounter}`,
    materialKind: "mfg_product",
    materialCode: "",
    materialName: "",
    supplierSku: "",
    qty: 1,
    unitPriceRm: "",
  };
}

const CURRENCIES = ["MYR", "RMB", "USD", "SGD"];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ScmPurchaseConsignmentOrderNew — full-page Create PC Order at
 * /scm/purchase-consignment-orders/new. A faithful clone of the owned-stock
 * Purchase Order create: supplier + lines, posting the order as SUBMITTED. A PC
 * Order writes NO inventory (order only) — the receive books the IN later.
 */
export function ScmPurchaseConsignmentOrderNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  // ── Header state ──────────────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState("");
  const [poDate, setPoDate] = useState(todayIso());
  const [expectedAt, setExpectedAt] = useState("");
  const [purchaseLocationId, setPurchaseLocationId] = useState("");
  const [currency, setCurrency] = useState("MYR");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [saving, setSaving] = useState(false);

  // ── Pickers ───────────────────────────────────────────────────────────
  const suppliersQ = useQuery<{ suppliers: SupplierOption[] }>(
    () => api.get(`${SCM}/suppliers?status=ACTIVE`),
    [],
  );
  const warehousesQ = useQuery<{ warehouses: WarehouseOption[] }>(
    () => api.get(`${SCM}/inventory/warehouses`),
    [],
  );
  const productsQ = useQuery<{ products: ProductRow[] }>(
    () => api.get(`${SCM}/mfg-products`),
    [],
  );
  const bindingsQ = useQuery<{ bindings: BindingRow[] }>(
    () => api.get(`${SCM}/suppliers/${supplierId}/bindings`),
    [supplierId],
  );

  const suppliers = suppliersQ.data?.suppliers ?? [];
  const warehouses = warehousesQ.data?.warehouses ?? [];
  const products = productsQ.data?.products ?? [];
  const bindings = useMemo(
    () => (supplierId ? bindingsQ.data?.bindings ?? [] : []),
    [supplierId, bindingsQ.data],
  );

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
  useEffect(() => {
    if (supplier?.currency) setCurrency(supplier.currency);
  }, [supplier?.currency]);

  // ── Line helpers ──────────────────────────────────────────────────────
  const setLine = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);

  async function dropLine(rid: string) {
    const line = lines.find((l) => l.rid === rid);
    const hasData = line && (line.materialCode.trim() || line.unitPriceRm.trim());
    if (hasData) {
      const ok = await dialog.confirm({
        title: "Remove this line?",
        message: "The entered item, quantity and cost on this line will be discarded.",
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

  function pickMaterial(rid: string, code: string) {
    const binding = bindings.find((b) => b.material_code === code);
    if (binding) {
      setLine(rid, {
        bindingId: binding.id,
        materialKind: (binding.material_kind as DraftLine["materialKind"]) || "mfg_product",
        materialCode: binding.material_code,
        materialName: binding.material_name,
        supplierSku: binding.supplier_sku ?? "",
        unitPriceRm: senToRm(binding.unit_price_centi),
        itemGroup: products.find((p) => p.code === code)?.category?.toLowerCase() ?? undefined,
      });
      return;
    }
    const sku = products.find((p) => p.code === code);
    setLine(rid, {
      bindingId: undefined,
      materialCode: code,
      materialName: sku?.name ?? "",
      supplierSku: "",
      itemGroup: sku?.category?.toLowerCase() ?? undefined,
    });
  }

  const lineTotalSen = (l: DraftLine) => Math.max(0, l.qty * rmToSen(l.unitPriceRm));
  const subtotalSen = useMemo(
    () => lines.reduce((s, l) => s + lineTotalSen(l), 0),
    [lines],
  );

  const dirty =
    Boolean(supplierId || expectedAt || purchaseLocationId || notes.trim()) ||
    lines.some((l) => l.materialCode.trim() || l.unitPriceRm.trim());

  // ── Save ──────────────────────────────────────────────────────────────
  async function submit() {
    if (!supplierId) {
      toast.error("Pick a supplier first");
      return;
    }
    if (!expectedAt) {
      toast.error("Expected delivery date is required");
      return;
    }
    if (!purchaseLocationId) {
      toast.error("Purchase location is required");
      return;
    }
    const validLines = lines.filter((l) => l.materialCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      toast.error("Add at least one line item with a quantity");
      return;
    }

    setSaving(true);
    try {
      const res = await api.post<{ id: string; pcNumber: string }>(
        `${SCM}/purchase-consignment-orders`,
        {
          supplierId,
          currency,
          poDate,
          expectedAt,
          purchaseLocationId,
          notes: notes.trim() || undefined,
          items: validLines.map((l) => ({
            materialKind: l.materialKind,
            materialCode: l.materialCode.trim(),
            materialName: l.materialName.trim() || l.materialCode.trim(),
            supplierSku: l.supplierSku.trim() || undefined,
            qty: l.qty,
            unitPriceCenti: rmToSen(l.unitPriceRm),
            bindingId: l.bindingId,
            itemGroup: l.itemGroup,
          })),
        },
      );
      toast.success(`Consignment order ${res.pcNumber} created`);
      navigate(`/scm/purchase-consignment-orders/${res.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(`Failed to create consignment order${msg ? `: ${msg}` : ""}`);
      setSaving(false);
    }
  }

  const fmt = (sen: number) => fmtCenti(sen, currency);

  return (
    <div>
      <button
        onClick={() => navigate("/scm/purchase-consignment-orders")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Purchase Consignment Orders
      </button>

      <PageHeader
        eyebrow="Supply Chain"
        title="New Purchase Consignment Order"
        description="Order a supplier's stock onto consignment. The order writes no inventory — the receive books it in later."
        primaryAction={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => navigate("/scm/purchase-consignment-orders")}
              disabled={saving}
            >
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
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Header
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Supplier" required>
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— Pick a supplier —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <Select value={currency} onChange={setCurrency} options={CURRENCIES} />
          </Field>
          <Field label="Order Date">
            <input
              type="date"
              value={poDate}
              onChange={(e) => setPoDate(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </Field>
          <Field label="Expected Delivery" required>
            <input
              type="date"
              value={expectedAt}
              onChange={(e) => setExpectedAt(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </Field>
          <Field label="Purchase Location" required>
            <select
              value={purchaseLocationId}
              onChange={(e) => setPurchaseLocationId(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— Pick a warehouse —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <Input value={notes} onChange={setNotes} placeholder="Supplier instructions, internal notes…" />
          </Field>
        </div>
        {supplier && (
          <p className="mt-3 text-[11.5px] text-ink-muted">
            Prices auto-fill from this supplier's cost bindings when available.
            {bindings.length > 0
              ? ` ${bindings.length} bound item(s).`
              : " This supplier has no bound items yet — enter cost manually."}
          </p>
        )}
      </div>

      {/* Line items */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Line Items ({lines.length})
        </h3>
      </div>

      <div className="space-y-2.5">
        {lines.map((l, idx) => {
          const pickOptions =
            bindings.length > 0
              ? bindings.map((b) => ({
                  code: b.material_code,
                  label: `${b.material_name} · ${b.supplier_sku ?? "—"} · ${fmtCenti(b.unit_price_centi, b.currency ?? currency)}`,
                }))
              : products.map((p) => ({ code: p.code, label: `${p.name} · ${p.category ?? ""}` }));
          return (
            <LineCard key={l.rid} index={idx + 1} onRemove={() => dropLine(l.rid)}>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <LineField label="Item" required>
                  <input
                    type="text"
                    list={`pco-items-${l.rid}`}
                    value={l.materialCode}
                    onChange={(e) => pickMaterial(l.rid, e.target.value)}
                    placeholder={supplierId ? "Type or pick a SKU…" : "Pick a supplier first"}
                    disabled={!supplierId}
                    className={`${lineInputCls} font-mono`}
                  />
                  <datalist id={`pco-items-${l.rid}`}>
                    {pickOptions.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </datalist>
                </LineField>
                <LineField label="Supplier SKU">
                  <input
                    type="text"
                    value={l.supplierSku}
                    onChange={(e) => setLine(l.rid, { supplierSku: e.target.value })}
                    placeholder="Supplier's own code"
                    className={lineInputCls}
                  />
                </LineField>
              </div>

              <LineField label="Description">
                <input
                  type="text"
                  value={l.materialName}
                  onChange={(e) => setLine(l.rid, { materialName: e.target.value })}
                  placeholder="Auto-filled when bound — editable for one-off purchases"
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
                <LineField label={`Unit Cost (${currency})`} align="right">
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

              <LineTotalRow>
                <span className="text-ink-muted">Line total</span>
                <span className="font-mono font-semibold text-ink">{fmt(lineTotalSen(l))}</span>
              </LineTotalRow>
            </LineCard>
          );
        })}

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
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => navigate("/scm/purchase-consignment-orders")}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button icon={<Save size={15} />} onClick={submit} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Create Order"}
        </Button>
      </div>
    </div>
  );
}
