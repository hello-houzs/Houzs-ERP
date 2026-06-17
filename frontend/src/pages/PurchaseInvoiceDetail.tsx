import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, Trash2, X, Banknote, Package } from "lucide-react";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
  DefinitionList,
  HeaderButton,
} from "../components/DetailLayout";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import type { ScmSupplier } from "./SupplierMaster";

interface InvoiceItem {
  id: string;
  material_kind: string;
  material_code: string;
  material_name: string | null;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  line_total_centi: number;
  notes: string | null;
}
interface ScmInvoice {
  id: string;
  invoice_number: string;
  supplier_invoice_no: string | null;
  supplier_id: string;
  purchase_order_id: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  amount_paid_centi: number;
  status: string;
  notes: string | null;
}
interface ScmPoLite {
  id: string;
  po_number: string;
}
interface DetailResp {
  invoice: ScmInvoice;
  supplier: ScmSupplier | null;
  purchase_order: ScmPoLite | null;
  items: InvoiceItem[];
}

const rm = (c: number) =>
  `RM ${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TONE: Record<string, string> = {
  UNPAID: "bg-amber-50 text-amber-700",
  PARTIAL: "bg-accent-soft/60 text-accent-ink",
  PAID: "bg-synced/10 text-synced",
  CANCELLED: "bg-bg text-ink-muted",
};

export function PurchaseInvoiceDetail() {
  const { id = "" } = useParams();
  if (id === "new") return <NewInvoice />;
  return <InvoiceView id={id} />;
}

// ── New Invoice ──────────────────────────────────────────────────────────────
interface PoListRow {
  id: string;
  po_number: string;
  supplier_id: string;
  supplier_name: string | null;
  status: string;
}
interface PoItemRow {
  id: string;
  material_kind: string;
  material_code: string;
  material_name: string;
  qty: number;
  unit_price_centi: number;
}
interface PoDetailResp {
  po: { id: string; supplier_id: string };
  items: PoItemRow[];
}
// One editable invoice line in the New Invoice form.
interface DraftLine {
  material_kind: string;
  material_code: string;
  material_name: string;
  qty: string;
  unit_price_centi: number;
}

function NewInvoice() {
  const navigate = useNavigate();
  const toast = useToast();
  const suppliers = useQuery<{ data: ScmSupplier[] }>(
    () => api.get("/api/scm-suppliers?per_page=200&status=ACTIVE"),
    [],
  );
  // Any non-cancelled PO is a valid billing reference (a PI may bill any stage).
  const pos = useQuery<{ data: PoListRow[] }>(
    () => api.get("/api/scm-purchase-orders?per_page=200"),
    [],
  );

  const [supplierId, setSupplierId] = useState("");
  const [poId, setPoId] = useState("");
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [loadingPo, setLoadingPo] = useState(false);
  const [busy, setBusy] = useState(false);

  const poOptions = (pos.data?.data ?? []).filter((p) => p.status !== "CANCELLED");

  async function selectPo(nextPoId: string) {
    setPoId(nextPoId);
    if (!nextPoId) return;
    setLoadingPo(true);
    try {
      const r = await api.get<PoDetailResp>(`/api/scm-purchase-orders/${nextPoId}`);
      if (r.po.supplier_id) setSupplierId(r.po.supplier_id);
      // Prefill one line per PO item (qty + unit price snapshot).
      const prefilled: DraftLine[] = r.items.map((it) => ({
        material_kind: it.material_kind,
        material_code: it.material_code,
        material_name: it.material_name,
        qty: String(it.qty || 0),
        unit_price_centi: it.unit_price_centi,
      }));
      setLines(prefilled);
    } catch (e: any) {
      toast.error(e?.message || "Could not load PO");
    } finally {
      setLoadingPo(false);
    }
  }

  function addLine() {
    setLines((prev) => [
      ...prev,
      { material_kind: "mfg_product", material_code: "", material_name: "", qty: "1", unit_price_centi: 0 },
    ]);
  }
  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }
  function setLine(idx: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function create() {
    if (!supplierId) {
      toast.error("Pick a supplier");
      return;
    }
    const items = lines
      .map((l) => ({
        material_kind: l.material_kind,
        material_code: l.material_code.trim(),
        material_name: l.material_name.trim() || l.material_code.trim(),
        qty: parseInt(l.qty, 10) || 0,
        unit_price_centi: l.unit_price_centi,
      }))
      .filter((l) => l.material_code && l.qty > 0);
    if (items.length === 0) {
      toast.error("Add at least one line with a material code and quantity");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ invoice: ScmInvoice }>("/api/scm-purchase-invoices", {
        supplier_id: supplierId,
        purchase_order_id: poId || null,
        supplier_invoice_no: supplierInvoiceNo.trim() || null,
        invoice_date: invoiceDate || null,
        due_date: dueDate || null,
        notes: notes.trim() || null,
        items,
      });
      toast.success(`Created ${r.invoice.invoice_number}`);
      navigate(`/scm/purchase-invoices/${r.invoice.id}`, { replace: true });
    } catch (e: any) {
      toast.error(e?.message || "Create failed");
    } finally {
      setBusy(false);
    }
  }

  const total = lines.reduce((s, l) => {
    const qty = parseInt(l.qty, 10) || 0;
    return s + qty * (l.unit_price_centi || 0);
  }, 0);

  const field = "mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]";
  const lbl = "text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

  return (
    <DetailLayout
      breadcrumbs={[{ label: "Purchase Invoices", to: "/scm/purchase-invoices" }, { label: "New" }]}
      eyebrow="Supply Chain"
      title="New purchase invoice"
      backTo="/scm/purchase-invoices"
    >
      <div className="max-w-2xl space-y-3">
        <div className="space-y-3 rounded-md border border-border bg-surface p-4 shadow-stone">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={lbl}>Supplier *</span>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={field}>
                <option value="">— pick a supplier —</option>
                {(suppliers.data?.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={lbl}>From a purchase order</span>
              <select value={poId} onChange={(e) => selectPo(e.target.value)} className={field}>
                <option value="">— none / manual lines —</option>
                {poOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.po_number} · {p.supplier_name || ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className={lbl}>Supplier invoice ref</span>
              <input value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} className={field} />
            </label>
            <label className="block">
              <span className={lbl}>Invoice date</span>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className={field} />
            </label>
            <label className="block">
              <span className={lbl}>Due date</span>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} />
            </label>
          </div>
          <label className="block">
            <span className={lbl}>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={cn(field, "resize-none")} />
          </label>
        </div>

        <Section
          title="Invoice lines"
          actions={
            <Button variant="secondary" icon={<Plus size={12} />} onClick={addLine}>
              Add line
            </Button>
          }
        >
          {loadingPo ? (
            <p className="px-1 py-2 text-[12px] text-ink-muted">Loading PO lines…</p>
          ) : lines.length === 0 ? (
            <EmptyState
              icon={<Package size={18} />}
              message="No lines yet"
              description="Add lines manually, or pick a purchase order above to prefill them."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                    <th className="py-1.5 pr-2">Material code</th>
                    <th className="px-2">Name</th>
                    <th className="px-2 text-right">Qty</th>
                    <th className="px-2 text-right">Unit (RM)</th>
                    <th className="px-2 text-right">Line</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {lines.map((l, idx) => {
                    const qty = parseInt(l.qty, 10) || 0;
                    return (
                      <tr key={idx} className="hover:bg-bg/40">
                        <td className="py-1.5 pr-2">
                          <input
                            value={l.material_code}
                            onChange={(e) => setLine(idx, { material_code: e.target.value })}
                            className="w-28 rounded-md border border-border bg-paper px-2 py-1 text-[12px] font-mono"
                          />
                        </td>
                        <td className="px-2">
                          <input
                            value={l.material_name}
                            onChange={(e) => setLine(idx, { material_name: e.target.value })}
                            className="w-36 rounded-md border border-border bg-paper px-2 py-1 text-[12px]"
                          />
                        </td>
                        <td className="px-2 text-right">
                          <input
                            type="number"
                            min="0"
                            value={l.qty}
                            onChange={(e) => setLine(idx, { qty: e.target.value })}
                            className="w-16 rounded-md border border-border bg-paper px-2 py-1 text-right text-[12px]"
                          />
                        </td>
                        <td className="px-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={(l.unit_price_centi / 100).toString()}
                            onChange={(e) =>
                              setLine(idx, { unit_price_centi: Math.round((parseFloat(e.target.value) || 0) * 100) })
                            }
                            className="w-20 rounded-md border border-border bg-paper px-2 py-1 text-right text-[12px]"
                          />
                        </td>
                        <td className="px-2 text-right font-mono font-semibold">{rm(qty * l.unit_price_centi)}</td>
                        <td className="px-2 text-right">
                          <button
                            onClick={() => removeLine(idx)}
                            className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                            title="Remove line"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border text-[12px] font-semibold">
                    <td className="py-1.5 pr-2" colSpan={4}>
                      Subtotal
                    </td>
                    <td className="px-2 text-right font-mono">{rm(total)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Section>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate("/scm/purchase-invoices")} className="flex-1">
            Cancel
          </Button>
          <Button onClick={create} disabled={busy || !supplierId || lines.length === 0} className="flex-1" icon={<Plus size={13} />}>
            {busy ? "Creating…" : "Create invoice"}
          </Button>
        </div>
        <p className="text-[11px] text-ink-muted">
          Invoices are a finance record only — they don't move stock. Receive stock with a Goods Receipt.
        </p>
      </div>
    </DetailLayout>
  );
}

// ── Invoice view ──────────────────────────────────────────────────────────────
function InvoiceView({ id }: { id: string }) {
  const toast = useToast();
  const detail = useQuery<DetailResp>(() => api.get(`/api/scm-purchase-invoices/${id}`), [id]);
  const [paying, setPaying] = useState(false);
  const invoice = detail.data?.invoice;
  const supplier = detail.data?.supplier;
  const po = detail.data?.purchase_order;
  const items = detail.data?.items ?? [];

  const balance = invoice ? Math.max(0, invoice.total_centi - invoice.amount_paid_centi) : 0;

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Purchase Invoices", to: "/scm/purchase-invoices" },
        { label: invoice?.invoice_number || "Invoice" },
      ]}
      eyebrow={invoice ? `Invoice · ${supplier?.name || ""}` : "Purchase Invoice"}
      title={invoice?.invoice_number || "Purchase Invoice"}
      backTo="/scm/purchase-invoices"
      loading={detail.loading}
      error={detail.error}
      actions={
        invoice && invoice.status !== "CANCELLED" && invoice.status !== "PAID" ? (
          <HeaderButton variant="primary" onClick={() => setPaying(true)}>
            <Banknote size={13} /> Record payment
          </HeaderButton>
        ) : undefined
      }
    >
      {invoice && (
        <DetailGrid>
          <DetailMain>
            <Section title="Invoice lines">
              {items.length === 0 ? (
                <EmptyState icon={<Package size={18} />} message="No lines" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                        <th className="py-1.5 pr-2">Material</th>
                        <th className="px-2 text-right">Qty</th>
                        <th className="px-2 text-right">Unit</th>
                        <th className="px-2 text-right">Discount</th>
                        <th className="px-2 text-right">Line</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {items.map((it) => (
                        <tr key={it.id} className="hover:bg-bg/40">
                          <td className="py-1.5 pr-2">
                            <span className="font-mono font-medium text-ink">{it.material_code}</span>
                            {it.material_name && it.material_name !== it.material_code && (
                              <span className="block text-[10px] text-ink-muted">{it.material_name}</span>
                            )}
                          </td>
                          <td className="px-2 text-right">{it.qty}</td>
                          <td className="px-2 text-right font-mono">{rm(it.unit_price_centi)}</td>
                          <td className="px-2 text-right font-mono">{rm(it.discount_centi)}</td>
                          <td className="px-2 text-right font-mono font-semibold">{rm(it.line_total_centi)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </DetailMain>

          <DetailAside>
            <Section title="Summary">
              <DefinitionList
                items={[
                  {
                    label: "Status",
                    value: (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          STATUS_TONE[invoice.status] || "bg-bg text-ink-muted",
                        )}
                      >
                        {invoice.status}
                      </span>
                    ),
                  },
                  { label: "Supplier", value: supplier ? `${supplier.code} · ${supplier.name}` : "—", full: true },
                  { label: "Supplier ref", value: invoice.supplier_invoice_no || "—" },
                  { label: "PO", value: po?.po_number || "—" },
                  { label: "Invoice date", value: invoice.invoice_date || "—" },
                  { label: "Due date", value: invoice.due_date || "—" },
                  { label: "Currency", value: invoice.currency },
                  { label: "Subtotal", value: rm(invoice.subtotal_centi), mono: true },
                  { label: "Tax", value: rm(invoice.tax_centi), mono: true },
                  { label: "Total", value: rm(invoice.total_centi), mono: true },
                  { label: "Paid", value: rm(invoice.amount_paid_centi), mono: true },
                  { label: "Balance", value: rm(balance), mono: true },
                  { label: "Notes", value: invoice.notes || "—", full: true },
                ]}
              />
            </Section>
          </DetailAside>
        </DetailGrid>
      )}

      {paying && invoice && (
        <RecordPaymentModal
          invoice={invoice}
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            detail.reload();
            toast.success("Payment recorded");
          }}
        />
      )}
    </DetailLayout>
  );
}

// ── record payment ──────────────────────────────────────────────────────────
function RecordPaymentModal({
  invoice,
  onClose,
  onSaved,
}: {
  invoice: ScmInvoice;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const balance = Math.max(0, invoice.total_centi - invoice.amount_paid_centi);
  // Pre-fill the running paid figure with the remaining balance settled.
  const [paidRm, setPaidRm] = useState(((invoice.amount_paid_centi + balance) / 100).toString());
  const [busy, setBusy] = useState(false);

  async function save() {
    const cents = Math.round((parseFloat(paidRm) || 0) * 100);
    if (cents < 0) {
      toast.error("Amount cannot be negative");
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/api/scm-purchase-invoices/${invoice.id}`, { amount_paid_centi: cents });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]";
  const lbl = "text-[10px] font-semibold uppercase tracking-brand text-ink-muted";
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-xl border border-border bg-surface shadow-slab animate-rise">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="font-display text-[15px] font-bold text-ink">Record payment</div>
          <button onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-bg/60 hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-[12px] text-ink-muted">
            Total {rm(invoice.total_centi)} · balance {rm(balance)}. Enter the new cumulative amount paid.
          </p>
          <label className="block">
            <span className={lbl}>Total paid to date (RM)</span>
            <input type="number" step="0.01" min="0" value={paidRm} onChange={(e) => setPaidRm(e.target.value)} className={field} />
          </label>
        </div>
        <div className="flex gap-2 border-t border-border px-4 py-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} className="flex-1" icon={<Banknote size={13} />}>
            {busy ? "Saving…" : "Save payment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
