import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, Trash2, X, Truck, Ban, Package, Pencil, type LucideIcon } from "lucide-react";
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
import { Modal } from "../components/Modal";
import { EmptyState } from "../components/EmptyState";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import type { ScmSupplier } from "./SupplierMaster";

interface PoItem {
  id: string;
  binding_id: string | null;
  material_kind: string;
  material_code: string;
  material_name: string;
  supplier_sku: string | null;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  line_total_centi: number;
  received_qty: number;
  uom: string;
  notes: string | null;
  delivery_date: string | null;
}
interface ScmPo {
  id: string;
  po_number: string;
  supplier_id: string;
  status: string;
  po_date: string | null;
  expected_at: string | null;
  currency: string;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  notes: string | null;
}
interface DetailResp {
  po: ScmPo;
  supplier: ScmSupplier | null;
  items: PoItem[];
}
interface Binding {
  id: string;
  material_code: string;
  material_name: string;
  supplier_sku: string;
  unit_price_centi: number;
}

const rm = (c: number) =>
  `RM ${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TONE: Record<string, string> = {
  SUBMITTED: "bg-accent-soft/60 text-accent-ink",
  SCHEDULED: "bg-accent-soft/60 text-accent-ink",
  PARTIALLY_RECEIVED: "bg-amber-50 text-amber-700",
  RECEIVED: "bg-synced/10 text-synced",
  CANCELLED: "bg-err/10 text-err",
};

export function PurchaseOrderDetail() {
  const { id = "" } = useParams();
  if (id === "new") return <NewPo />;
  return <PoView id={id} />;
}

// ── New PO ───────────────────────────────────────────────────────────────
function NewPo() {
  const navigate = useNavigate();
  const toast = useToast();
  const suppliers = useQuery<{ data: ScmSupplier[] }>(
    () => api.get("/api/scm-suppliers?per_page=200&status=ACTIVE"),
    [],
  );
  const [supplierId, setSupplierId] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!supplierId) {
      toast.error("Pick a supplier");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ po: ScmPo }>("/api/scm-purchase-orders", {
        supplier_id: supplierId,
        expected_at: expectedAt || null,
        notes: notes.trim() || null,
        items: [],
      });
      toast.success(`Created ${r.po.po_number}`);
      navigate(`/scm/purchase-orders/${r.po.id}`, { replace: true });
    } catch (e: any) {
      toast.error(e?.message || "Create failed");
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]";
  const lbl = "text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

  return (
    <DetailLayout
      breadcrumbs={[{ label: "Purchase Orders", to: "/scm/purchase-orders" }, { label: "New" }]}
      eyebrow="Supply Chain"
      title="New purchase order"
      backTo="/scm/purchase-orders"
    >
      <div className="max-w-lg space-y-3 rounded-md border border-border bg-surface p-4 shadow-stone">
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
          <span className={lbl}>Expected delivery (ETA)</span>
          <input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className={lbl}>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={cn(field, "resize-none")} />
        </label>
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={() => navigate("/scm/purchase-orders")} className="flex-1">
            Cancel
          </Button>
          <Button onClick={create} disabled={busy || !supplierId} className="flex-1" icon={<Plus size={13} />}>
            {busy ? "Creating…" : "Create PO"}
          </Button>
        </div>
        <p className="text-[11px] text-ink-muted">You'll add line items on the next screen.</p>
      </div>
    </DetailLayout>
  );
}

// ── PO view ──────────────────────────────────────────────────────────────
const NEXT_STATUS: Record<string, { label: string; to: string; icon: LucideIcon }[]> = {
  SUBMITTED: [{ label: "Mark scheduled", to: "SCHEDULED", icon: Package }],
  SCHEDULED: [{ label: "Mark received", to: "RECEIVED", icon: Truck }],
  PARTIALLY_RECEIVED: [{ label: "Mark received", to: "RECEIVED", icon: Truck }],
};

function PoView({ id }: { id: string }) {
  const toast = useToast();
  const detail = useQuery<DetailResp>(() => api.get(`/api/scm-purchase-orders/${id}`), [id]);
  const [adding, setAdding] = useState(false);
  const [editHdr, setEditHdr] = useState(false);
  const po = detail.data?.po;
  const supplier = detail.data?.supplier;
  const items = detail.data?.items ?? [];
  const editable = !!po && po.status !== "RECEIVED" && po.status !== "CANCELLED";

  async function setStatus(to: string) {
    if (to === "CANCELLED" && !confirm("Cancel this PO?")) return;
    try {
      await api.patch(`/api/scm-purchase-orders/${id}`, { status: to });
      toast.success("Status updated");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }
  async function removeItem(it: PoItem) {
    if (!confirm(`Remove ${it.material_code}?`)) return;
    try {
      await api.del(`/api/scm-purchase-orders/items/${it.id}`);
      toast.success("Line removed");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <DetailLayout
      breadcrumbs={[{ label: "Purchase Orders", to: "/scm/purchase-orders" }, { label: po?.po_number || "PO" }]}
      eyebrow={po ? `PO · ${supplier?.name || ""}` : "Purchase Order"}
      title={po?.po_number || "Purchase Order"}
      backTo="/scm/purchase-orders"
      loading={detail.loading}
      error={detail.error}
      actions={
        po ? (
          <div className="flex items-center gap-1.5">
            {(NEXT_STATUS[po.status] || []).map((s) => {
              const Icon = s.icon;
              return (
                <HeaderButton key={s.to} variant="primary" onClick={() => setStatus(s.to)}>
                  <Icon size={13} /> {s.label}
                </HeaderButton>
              );
            })}
            {po.status !== "CANCELLED" && po.status !== "RECEIVED" && (
              <HeaderButton variant="danger" onClick={() => setStatus("CANCELLED")}>
                <Ban size={13} /> Cancel
              </HeaderButton>
            )}
            {po.status === "CANCELLED" && (
              <HeaderButton variant="ghost" onClick={() => setStatus("SUBMITTED")}>
                Reopen
              </HeaderButton>
            )}
          </div>
        ) : undefined
      }
    >
      {po && (
        <DetailGrid>
          <DetailMain>
            <Section
              title="Line items"
              actions={
                editable ? (
                  <Button variant="secondary" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
                    Add line
                  </Button>
                ) : undefined
              }
            >
              {items.length === 0 ? (
                <EmptyState
                  icon={<Package size={18} />}
                  message="No line items"
                  description="Add what you're ordering from this supplier."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                        <th className="py-1.5 pr-2">Material</th>
                        <th className="px-2">Supplier SKU</th>
                        <th className="px-2 text-right">Qty</th>
                        <th className="px-2 text-right">Unit</th>
                        <th className="px-2 text-right">Line</th>
                        <th className="px-2 text-right">Recv</th>
                        <th />
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
                          <td className="px-2 font-mono">{it.supplier_sku || "—"}</td>
                          <td className="px-2 text-right">{it.qty}</td>
                          <td className="px-2 text-right font-mono">{rm(it.unit_price_centi)}</td>
                          <td className="px-2 text-right font-mono font-semibold">{rm(it.line_total_centi)}</td>
                          <td className="px-2 text-right">{it.received_qty}</td>
                          <td className="px-2 text-right">
                            {editable && (
                              <button
                                onClick={() => removeItem(it)}
                                className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                                title="Remove line"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </DetailMain>

          <DetailAside>
            <Section
              title="Summary"
              actions={
                editable ? (
                  <button
                    onClick={() => setEditHdr(true)}
                    className="rounded p-1 text-ink-muted hover:bg-bg/60 hover:text-accent"
                    title="Edit PO"
                  >
                    <Pencil size={13} />
                  </button>
                ) : undefined
              }
            >
              <DefinitionList
                items={[
                  {
                    label: "Status",
                    value: (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          STATUS_TONE[po.status] || "bg-bg text-ink-muted",
                        )}
                      >
                        {po.status.replace(/_/g, " ")}
                      </span>
                    ),
                  },
                  { label: "Supplier", value: supplier ? `${supplier.code} · ${supplier.name}` : "—", full: true },
                  { label: "PO date", value: po.po_date || "—" },
                  { label: "ETA", value: po.expected_at || "—" },
                  { label: "Currency", value: po.currency },
                  { label: "Subtotal", value: rm(po.subtotal_centi), mono: true },
                  { label: "Tax", value: rm(po.tax_centi), mono: true },
                  { label: "Total", value: rm(po.total_centi), mono: true },
                  { label: "Notes", value: po.notes || "—", full: true },
                ]}
              />
            </Section>
          </DetailAside>
        </DetailGrid>
      )}

      {adding && po && (
        <AddItemModal
          poId={id}
          supplierId={po.supplier_id}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            detail.reload();
            toast.success("Line added");
          }}
        />
      )}
      {editHdr && po && (
        <EditHeaderModal
          po={po}
          onClose={() => setEditHdr(false)}
          onSaved={() => {
            setEditHdr(false);
            detail.reload();
            toast.success("PO updated");
          }}
        />
      )}
    </DetailLayout>
  );
}

// ── add item (from supplier bindings, or manual) ──────────────────────────
function AddItemModal({
  poId,
  supplierId,
  onClose,
  onAdded,
}: {
  poId: string;
  supplierId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const bindings = useQuery<{ data: Binding[] }>(
    () => api.get(`/api/scm-suppliers/${supplierId}/bindings`),
    [supplierId],
  );
  const [pickId, setPickId] = useState("");
  const [materialCode, setMaterialCode] = useState("");
  const [materialName, setMaterialName] = useState("");
  const [supplierSku, setSupplierSku] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);

  function applyBinding(bid: string) {
    setPickId(bid);
    const b = (bindings.data?.data ?? []).find((x) => x.id === bid);
    if (b) {
      setMaterialCode(b.material_code);
      setMaterialName(b.material_name);
      setSupplierSku(b.supplier_sku);
      setUnitPrice((b.unit_price_centi / 100).toString());
    }
  }

  async function add() {
    if (!materialCode.trim()) {
      toast.error("Material code required");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/scm-purchase-orders/${poId}/items`, {
        binding_id: pickId || null,
        material_code: materialCode.trim(),
        material_name: materialName.trim() || materialCode.trim(),
        supplier_sku: supplierSku.trim() || null,
        qty: parseInt(qty, 10) || 0,
        unit_price_centi: Math.round((parseFloat(unitPrice) || 0) * 100),
      });
      onAdded();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]";
  const lbl = "text-[10px] font-semibold uppercase tracking-brand text-ink-muted";
  return (
    <Modal onClose={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-xl border border-border bg-surface shadow-slab animate-rise">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="font-display text-[15px] font-bold text-ink">Add line item</div>
          <button onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-bg/60 hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <label className="block">
            <span className={lbl}>From a binding (auto-fills price)</span>
            <select value={pickId} onChange={(e) => applyBinding(e.target.value)} className={field}>
              <option value="">— custom / type below —</option>
              {(bindings.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.material_code} → {b.supplier_sku} ({rm(b.unit_price_centi)})
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={lbl}>Material code *</span>
              <input value={materialCode} onChange={(e) => setMaterialCode(e.target.value)} className={field} />
            </label>
            <label className="block">
              <span className={lbl}>Supplier SKU</span>
              <input value={supplierSku} onChange={(e) => setSupplierSku(e.target.value)} className={field} />
            </label>
            <label className="col-span-2 block">
              <span className={lbl}>Material name</span>
              <input value={materialName} onChange={(e) => setMaterialName(e.target.value)} className={field} />
            </label>
            <label className="block">
              <span className={lbl}>Qty</span>
              <input type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} className={field} />
            </label>
            <label className="block">
              <span className={lbl}>Unit price (RM)</span>
              <input type="number" step="0.01" min="0" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className={field} />
            </label>
          </div>
        </div>
        <div className="flex gap-2 border-t border-border px-4 py-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button onClick={add} disabled={busy} className="flex-1" icon={<Plus size={13} />}>
            {busy ? "Adding…" : "Add line"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── edit header ───────────────────────────────────────────────────────────
function EditHeaderModal({ po, onClose, onSaved }: { po: ScmPo; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [expectedAt, setExpectedAt] = useState(po.expected_at || "");
  const [notes, setNotes] = useState(po.notes || "");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/scm-purchase-orders/${po.id}`, { expected_at: expectedAt || null, notes: notes.trim() || null });
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
    <Modal onClose={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-xl border border-border bg-surface shadow-slab animate-rise">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="font-display text-[15px] font-bold text-ink">Edit PO</div>
          <button onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-bg/60 hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <label className="block">
            <span className={lbl}>Expected delivery (ETA)</span>
            <input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} className={field} />
          </label>
          <label className="block">
            <span className={lbl}>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={cn(field, "resize-none")} />
          </label>
        </div>
        <div className="flex gap-2 border-t border-border px-4 py-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} className="flex-1">
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
