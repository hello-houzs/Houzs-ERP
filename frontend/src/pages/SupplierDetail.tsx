import { useState } from "react";
import { useParams } from "react-router-dom";
import { Plus, Trash2, Pencil, Star, Package, X } from "lucide-react";
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
import { SupplierFormModal, type ScmSupplier } from "./SupplierMaster";

interface Binding {
  id: string;
  supplier_id: string;
  material_kind: string;
  material_code: string;
  material_name: string;
  supplier_sku: string;
  unit_price_centi: number;
  currency: string;
  lead_time_days: number;
  payment_terms_override: string | null;
  moq: number;
  is_main_supplier: boolean;
  notes: string | null;
}

interface DetailResp {
  supplier: ScmSupplier;
  bindings: Binding[];
}

function rm(centi: number): string {
  return `RM ${(centi / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function SupplierDetail() {
  const { id = "" } = useParams();
  const toast = useToast();
  const detail = useQuery<DetailResp>(() => api.get(`/api/scm-suppliers/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [bindingEdit, setBindingEdit] = useState<Binding | "new" | null>(null);

  const s = detail.data?.supplier;
  const bindings = detail.data?.bindings ?? [];

  async function removeBinding(b: Binding) {
    if (!confirm(`Remove binding ${b.material_code} → ${b.supplier_sku}?`)) return;
    try {
      await api.del(`/api/scm-suppliers/bindings/${b.id}`);
      toast.success("Binding removed");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Remove failed");
    }
  }

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Suppliers", to: "/scm/suppliers" },
        { label: s?.name || "Supplier" },
      ]}
      eyebrow={s ? `Supplier · ${s.code}` : "Supplier"}
      title={s?.name || "Supplier"}
      backTo="/scm/suppliers"
      loading={detail.loading}
      error={detail.error}
      actions={
        s ? (
          <HeaderButton variant="primary" onClick={() => setEditing(true)}>
            <Pencil size={13} /> Edit
          </HeaderButton>
        ) : undefined
      }
    >
      {s && (
        <DetailGrid>
          <DetailMain>
            <Section
              title="Material bindings"
              actions={
                <Button
                  onClick={() => setBindingEdit("new")}
                  icon={<Plus size={12} />}
                  variant="secondary"
                >
                  Add binding
                </Button>
              }
            >
              {bindings.length === 0 ? (
                <EmptyState
                  icon={<Package size={18} />}
                  message="No material bindings"
                  description="Map your material codes to this supplier's SKU + price."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                        <th className="py-1.5 pr-2">Material</th>
                        <th className="px-2">Supplier SKU</th>
                        <th className="px-2 text-right">Unit price</th>
                        <th className="px-2 text-right">Lead</th>
                        <th className="px-2 text-right">MOQ</th>
                        <th className="px-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {bindings.map((b) => (
                        <tr key={b.id} className="hover:bg-bg/40">
                          <td className="py-1.5 pr-2">
                            <button
                              onClick={() => setBindingEdit(b)}
                              className="text-left"
                              title="Edit binding"
                            >
                              <span className="flex items-center gap-1 font-mono font-medium text-ink">
                                {b.is_main_supplier && (
                                  <Star size={11} className="text-accent" fill="currentColor" />
                                )}
                                {b.material_code}
                              </span>
                              {b.material_name && b.material_name !== b.material_code && (
                                <span className="block text-[10px] text-ink-muted">
                                  {b.material_name}
                                </span>
                              )}
                            </button>
                          </td>
                          <td className="px-2 font-mono">{b.supplier_sku}</td>
                          <td className="px-2 text-right font-mono">
                            {rm(b.unit_price_centi)}
                            {b.currency !== "MYR" ? ` ${b.currency}` : ""}
                          </td>
                          <td className="px-2 text-right">{b.lead_time_days}d</td>
                          <td className="px-2 text-right">{b.moq || "—"}</td>
                          <td className="px-2 text-right">
                            <button
                              onClick={() => removeBinding(b)}
                              className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                              title="Remove binding"
                            >
                              <Trash2 size={13} />
                            </button>
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
            <Section title="Details">
              <DefinitionList
                items={[
                  { label: "Code", value: s.code, mono: true },
                  { label: "Status", value: s.status },
                  { label: "Category", value: s.category || "—" },
                  { label: "Type", value: s.supplier_type || "—" },
                  { label: "Contact", value: s.contact_person || "—" },
                  { label: "Phone", value: s.phone || "—" },
                  { label: "WhatsApp", value: s.whatsapp_number || "—" },
                  { label: "Email", value: s.email || "—" },
                  { label: "Terms", value: s.payment_terms || "—" },
                  { label: "Currency", value: s.currency },
                  { label: "Address", value: s.address || "—", full: true },
                  { label: "State", value: s.state || "—" },
                  { label: "Postcode", value: s.postcode || "—" },
                  { label: "Notes", value: s.notes || "—", full: true },
                ]}
              />
            </Section>
          </DetailAside>
        </DetailGrid>
      )}

      {editing && s && (
        <SupplierFormModal
          supplier={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            detail.reload();
            toast.success("Supplier updated");
          }}
        />
      )}

      {bindingEdit && s && (
        <BindingModal
          supplierId={s.id}
          binding={bindingEdit === "new" ? null : bindingEdit}
          onClose={() => setBindingEdit(null)}
          onSaved={() => {
            const wasNew = bindingEdit === "new";
            setBindingEdit(null);
            detail.reload();
            toast.success(wasNew ? "Binding added" : "Binding updated");
          }}
        />
      )}
    </DetailLayout>
  );
}

const MATERIAL_KINDS = ["mfg_product", "fabric", "raw"];

function BindingModal({
  supplierId,
  binding,
  onClose,
  onSaved,
}: {
  supplierId: string;
  binding: Binding | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isEdit = !!binding;
  const [f, setF] = useState({
    material_kind: binding?.material_kind || "mfg_product",
    material_code: binding?.material_code || "",
    material_name: binding?.material_name || "",
    supplier_sku: binding?.supplier_sku || "",
    unit_price: binding ? (binding.unit_price_centi / 100).toString() : "",
    currency: binding?.currency || "MYR",
    lead_time_days: binding ? String(binding.lead_time_days) : "0",
    moq: binding ? String(binding.moq) : "0",
    is_main_supplier: binding?.is_main_supplier ?? false,
    notes: binding?.notes || "",
  });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.material_code.trim()) {
      toast.error("Material code is required");
      return;
    }
    if (!f.supplier_sku.trim()) {
      toast.error("Supplier SKU is required");
      return;
    }
    const payload = {
      material_kind: f.material_kind,
      material_code: f.material_code.trim(),
      material_name: f.material_name.trim() || f.material_code.trim(),
      supplier_sku: f.supplier_sku.trim(),
      unit_price_centi: Math.round((parseFloat(f.unit_price) || 0) * 100),
      currency: f.currency.trim() || "MYR",
      lead_time_days: parseInt(f.lead_time_days, 10) || 0,
      moq: parseInt(f.moq, 10) || 0,
      is_main_supplier: f.is_main_supplier,
      notes: f.notes.trim() || undefined,
    };
    setBusy(true);
    try {
      if (isEdit) await api.patch(`/api/scm-suppliers/bindings/${binding!.id}`, payload);
      else await api.post(`/api/scm-suppliers/${supplierId}/bindings`, payload);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]";
  const lbl = "text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

  return (
    <Modal onClose={onClose} aria-label={isEdit ? "Edit binding" : "Add binding"}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-slab animate-rise"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="font-display text-[15px] font-bold text-ink">
            {isEdit ? "Edit binding" : "Add material binding"}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-muted hover:bg-bg/60 hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 p-4">
          <label className="block">
            <span className={lbl}>Material kind</span>
            <select
              value={f.material_kind}
              onChange={(e) => setF({ ...f, material_kind: e.target.value })}
              className={field}
            >
              {MATERIAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={lbl}>Our material code *</span>
            <input
              value={f.material_code}
              onChange={(e) => setF({ ...f, material_code: e.target.value })}
              className={field}
              placeholder="1003-(K)"
              autoFocus
              required
            />
          </label>
          <label className="col-span-2 block">
            <span className={lbl}>Material name</span>
            <input
              value={f.material_name}
              onChange={(e) => setF({ ...f, material_name: e.target.value })}
              className={field}
            />
          </label>
          <label className="block">
            <span className={lbl}>Supplier SKU *</span>
            <input
              value={f.supplier_sku}
              onChange={(e) => setF({ ...f, supplier_sku: e.target.value })}
              className={field}
              required
            />
          </label>
          <label className="block">
            <span className={lbl}>Unit price (RM)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={f.unit_price}
              onChange={(e) => setF({ ...f, unit_price: e.target.value })}
              className={field}
              placeholder="0.00"
            />
          </label>
          <label className="block">
            <span className={lbl}>Currency</span>
            <input
              value={f.currency}
              onChange={(e) => setF({ ...f, currency: e.target.value })}
              className={field}
            />
          </label>
          <label className="block">
            <span className={lbl}>Lead time (days)</span>
            <input
              type="number"
              min="0"
              value={f.lead_time_days}
              onChange={(e) => setF({ ...f, lead_time_days: e.target.value })}
              className={field}
            />
          </label>
          <label className="block">
            <span className={lbl}>MOQ</span>
            <input
              type="number"
              min="0"
              value={f.moq}
              onChange={(e) => setF({ ...f, moq: e.target.value })}
              className={field}
            />
          </label>
          <label className="col-span-2 flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={f.is_main_supplier}
              onChange={(e) => setF({ ...f, is_main_supplier: e.target.checked })}
            />
            <span className="text-[12px] text-ink">Main supplier for this material</span>
          </label>
          <label className="col-span-2 block">
            <span className={lbl}>Notes</span>
            <textarea
              value={f.notes}
              onChange={(e) => setF({ ...f, notes: e.target.value })}
              rows={2}
              className={cn(field, "resize-none")}
            />
          </label>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" disabled={busy} className="flex-1">
            {busy ? "Saving…" : isEdit ? "Save" : "Add binding"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
