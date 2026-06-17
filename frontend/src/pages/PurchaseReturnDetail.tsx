import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, Trash2, Undo2, Ban, Package, type LucideIcon } from "lucide-react";
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

interface ReturnItem {
  id: string;
  material_kind: string;
  material_code: string;
  material_name: string | null;
  qty_returned: number;
  unit_cost_centi: number;
  notes: string | null;
}
interface ScmReturn {
  id: string;
  return_number: string;
  supplier_id: string;
  warehouse_code: string;
  purchase_order_id: string | null;
  status: string;
  reason: string | null;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
}
interface ScmPoLite {
  id: string;
  po_number: string;
}
interface DetailResp {
  ret: ScmReturn;
  supplier: ScmSupplier | null;
  purchase_order: ScmPoLite | null;
  items: ReturnItem[];
}

const rm = (c: number) =>
  `RM ${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-bg text-ink-muted",
  POSTED: "bg-synced/10 text-synced",
  CANCELLED: "bg-err/10 text-err",
};

export function PurchaseReturnDetail() {
  const { id = "" } = useParams();
  if (id === "new") return <NewReturn />;
  return <ReturnView id={id} />;
}

// ── New Return ────────────────────────────────────────────────────────────────
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
  received_qty: number;
  unit_price_centi: number;
}
interface PoDetailResp {
  po: { id: string; supplier_id: string };
  items: PoItemRow[];
}
interface Warehouse {
  code: string;
  name: string;
}
// One editable return line in the New Return form.
interface DraftLine {
  material_kind: string;
  material_code: string;
  material_name: string;
  qty_returned: string;
  unit_cost_centi: number;
}

function NewReturn() {
  const navigate = useNavigate();
  const toast = useToast();
  const suppliers = useQuery<{ data: ScmSupplier[] }>(
    () => api.get("/api/scm-suppliers?per_page=200&status=ACTIVE"),
    [],
  );
  const warehouses = useQuery<{ data: Warehouse[] }>(() => api.get("/api/warehouses"), []);
  // Any non-cancelled PO can seed return lines (a received PO is the common case).
  const pos = useQuery<{ data: PoListRow[] }>(
    () => api.get("/api/scm-purchase-orders?per_page=200"),
    [],
  );

  const [supplierId, setSupplierId] = useState("");
  const [warehouseCode, setWarehouseCode] = useState("");
  const [poId, setPoId] = useState("");
  const [reason, setReason] = useState("");
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
      // Prefill one line per PO item, default qty to what was received.
      const prefilled: DraftLine[] = r.items.map((it) => ({
        material_kind: it.material_kind,
        material_code: it.material_code,
        material_name: it.material_name,
        qty_returned: String(Math.max(0, it.received_qty || 0)),
        unit_cost_centi: it.unit_price_centi,
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
      { material_kind: "mfg_product", material_code: "", material_name: "", qty_returned: "1", unit_cost_centi: 0 },
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
    if (!warehouseCode) {
      toast.error("Pick a warehouse");
      return;
    }
    const items = lines
      .map((l) => ({
        material_kind: l.material_kind,
        material_code: l.material_code.trim(),
        material_name: l.material_name.trim() || l.material_code.trim(),
        qty_returned: parseInt(l.qty_returned, 10) || 0,
        unit_cost_centi: l.unit_cost_centi,
      }))
      .filter((l) => l.material_code && l.qty_returned > 0);
    if (items.length === 0) {
      toast.error("Add at least one line with a material code and return quantity");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ ret: ScmReturn }>("/api/scm-purchase-returns", {
        supplier_id: supplierId,
        warehouse_code: warehouseCode,
        purchase_order_id: poId || null,
        reason: reason.trim() || null,
        notes: notes.trim() || null,
        items,
      });
      toast.success(`Created ${r.ret.return_number}`);
      navigate(`/scm/returns/${r.ret.id}`, { replace: true });
    } catch (e: any) {
      toast.error(e?.message || "Create failed");
    } finally {
      setBusy(false);
    }
  }

  const total = lines.reduce((s, l) => {
    const qty = parseInt(l.qty_returned, 10) || 0;
    return s + qty * (l.unit_cost_centi || 0);
  }, 0);

  const field = "mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]";
  const lbl = "text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

  return (
    <DetailLayout
      breadcrumbs={[{ label: "Returns", to: "/scm/returns" }, { label: "New" }]}
      eyebrow="Supply Chain"
      title="New purchase return"
      backTo="/scm/returns"
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
              <span className={lbl}>Warehouse *</span>
              <select value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)} className={field}>
                <option value="">— pick a warehouse —</option>
                {(warehouses.data?.data ?? []).map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
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
            <label className="block">
              <span className={lbl}>Reason</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className={field} placeholder="Damaged, wrong item…" />
            </label>
          </div>
          <label className="block">
            <span className={lbl}>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={cn(field, "resize-none")} />
          </label>
        </div>

        <Section
          title="Return lines"
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
                    <th className="px-2 text-right">Return qty</th>
                    <th className="px-2 text-right">Unit cost (RM)</th>
                    <th className="px-2 text-right">Line value</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {lines.map((l, idx) => {
                    const qty = parseInt(l.qty_returned, 10) || 0;
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
                            value={l.qty_returned}
                            onChange={(e) => setLine(idx, { qty_returned: e.target.value })}
                            className="w-16 rounded-md border border-border bg-paper px-2 py-1 text-right text-[12px]"
                          />
                        </td>
                        <td className="px-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={(l.unit_cost_centi / 100).toString()}
                            onChange={(e) =>
                              setLine(idx, { unit_cost_centi: Math.round((parseFloat(e.target.value) || 0) * 100) })
                            }
                            className="w-20 rounded-md border border-border bg-paper px-2 py-1 text-right text-[12px]"
                          />
                        </td>
                        <td className="px-2 text-right font-mono font-semibold">{rm(qty * l.unit_cost_centi)}</td>
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
                      Total value
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
          <Button variant="secondary" onClick={() => navigate("/scm/returns")} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={busy || !supplierId || !warehouseCode || lines.length === 0}
            className="flex-1"
            icon={<Plus size={13} />}
          >
            {busy ? "Creating…" : "Create draft return"}
          </Button>
        </div>
        <p className="text-[11px] text-ink-muted">
          Saved as a draft. Stock is only reduced when you post it on the next screen.
        </p>
      </div>
    </DetailLayout>
  );
}

// ── Return view ────────────────────────────────────────────────────────────────
const NEXT_STATUS: Record<string, { label: string; action: "post"; icon: LucideIcon }[]> = {
  DRAFT: [{ label: "Post return", action: "post", icon: Undo2 }],
};

function ReturnView({ id }: { id: string }) {
  const toast = useToast();
  const detail = useQuery<DetailResp>(() => api.get(`/api/scm-purchase-returns/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const ret = detail.data?.ret;
  const supplier = detail.data?.supplier;
  const po = detail.data?.purchase_order;
  const items = detail.data?.items ?? [];

  async function post() {
    if (!confirm("Post this return? Stock will be reduced and this cannot be undone.")) return;
    setBusy(true);
    try {
      await api.post(`/api/scm-purchase-returns/${id}/post`);
      toast.success("Return posted — stock reduced");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Post failed");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!confirm("Cancel this draft return?")) return;
    setBusy(true);
    try {
      await api.post(`/api/scm-purchase-returns/${id}/cancel`);
      toast.success("Return cancelled");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  const totalValue = items.reduce((s, it) => s + (it.qty_returned || 0) * (it.unit_cost_centi || 0), 0);

  return (
    <DetailLayout
      breadcrumbs={[{ label: "Returns", to: "/scm/returns" }, { label: ret?.return_number || "Return" }]}
      eyebrow={ret ? `Return · ${supplier?.name || ""}` : "Purchase Return"}
      title={ret?.return_number || "Purchase Return"}
      backTo="/scm/returns"
      loading={detail.loading}
      error={detail.error}
      actions={
        ret ? (
          <div className="flex items-center gap-1.5">
            {(NEXT_STATUS[ret.status] || []).map((s) => {
              const Icon = s.icon;
              return (
                <HeaderButton key={s.action} variant="primary" disabled={busy} onClick={post}>
                  <Icon size={13} /> {s.label}
                </HeaderButton>
              );
            })}
            {ret.status === "DRAFT" && (
              <HeaderButton variant="danger" disabled={busy} onClick={cancel}>
                <Ban size={13} /> Cancel
              </HeaderButton>
            )}
          </div>
        ) : undefined
      }
    >
      {ret && (
        <DetailGrid>
          <DetailMain>
            <Section title="Returned lines">
              {items.length === 0 ? (
                <EmptyState icon={<Package size={18} />} message="No lines" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                        <th className="py-1.5 pr-2">Material</th>
                        <th className="px-2 text-right">Qty returned</th>
                        <th className="px-2 text-right">Unit cost</th>
                        <th className="px-2 text-right">Line value</th>
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
                          <td className="px-2 text-right">{it.qty_returned}</td>
                          <td className="px-2 text-right font-mono">{rm(it.unit_cost_centi)}</td>
                          <td className="px-2 text-right font-mono font-semibold">
                            {rm((it.qty_returned || 0) * (it.unit_cost_centi || 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
            {ret.status === "POSTED" && (
              <p className="mt-2 text-[11px] text-synced">
                Stock was reduced from {ret.warehouse_code} when this return was posted.
              </p>
            )}
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
                          STATUS_TONE[ret.status] || "bg-bg text-ink-muted",
                        )}
                      >
                        {ret.status}
                      </span>
                    ),
                  },
                  { label: "Supplier", value: supplier ? `${supplier.code} · ${supplier.name}` : "—", full: true },
                  { label: "PO", value: po?.po_number || "—" },
                  { label: "Warehouse", value: ret.warehouse_code },
                  { label: "Reason", value: ret.reason || "—", full: true },
                  { label: "Total value", value: rm(totalValue), mono: true },
                  { label: "Notes", value: ret.notes || "—", full: true },
                ]}
              />
            </Section>
          </DetailAside>
        </DetailGrid>
      )}
    </DetailLayout>
  );
}
