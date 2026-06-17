import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, PackageCheck, Ban, Package, type LucideIcon } from "lucide-react";
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

interface GrnItem {
  id: string;
  po_item_id: string | null;
  material_kind: string;
  material_code: string;
  material_name: string | null;
  qty_received: number;
  unit_cost_centi: number;
  notes: string | null;
}
interface ScmGrn {
  id: string;
  grn_number: string;
  supplier_id: string;
  purchase_order_id: string | null;
  warehouse_code: string;
  status: string;
  received_date: string | null;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
}
interface ScmPoLite {
  id: string;
  po_number: string;
}
interface DetailResp {
  grn: ScmGrn;
  supplier: ScmSupplier | null;
  purchase_order: ScmPoLite | null;
  items: GrnItem[];
}

const rm = (c: number) =>
  `RM ${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-bg text-ink-muted",
  POSTED: "bg-synced/10 text-synced",
  CANCELLED: "bg-err/10 text-err",
};

export function GoodsReceiptDetail() {
  const { id = "" } = useParams();
  if (id === "new") return <NewGrn />;
  return <GrnView id={id} />;
}

// ── New GRN ────────────────────────────────────────────────────────────────
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
// One editable receipt line in the New GRN form.
interface DraftLine {
  po_item_id: string | null;
  material_kind: string;
  material_code: string;
  material_name: string;
  qty_received: string;
  unit_cost_centi: number;
}

function NewGrn() {
  const navigate = useNavigate();
  const toast = useToast();
  // Only POs that still have stock to receive are selectable.
  const pos = useQuery<{ data: PoListRow[] }>(
    () => api.get("/api/scm-purchase-orders?per_page=200&status=SCHEDULED"),
    [],
  );
  const posPartial = useQuery<{ data: PoListRow[] }>(
    () => api.get("/api/scm-purchase-orders?per_page=200&status=PARTIALLY_RECEIVED"),
    [],
  );
  const warehouses = useQuery<{ data: Warehouse[] }>(() => api.get("/api/warehouses"), []);

  const [poId, setPoId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [warehouseCode, setWarehouseCode] = useState("");
  const [receivedDate, setReceivedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [loadingPo, setLoadingPo] = useState(false);
  const [busy, setBusy] = useState(false);

  const poOptions = [...(pos.data?.data ?? []), ...(posPartial.data?.data ?? [])];

  async function selectPo(nextPoId: string) {
    setPoId(nextPoId);
    setLines([]);
    setSupplierId("");
    if (!nextPoId) return;
    setLoadingPo(true);
    try {
      const r = await api.get<PoDetailResp>(`/api/scm-purchase-orders/${nextPoId}`);
      setSupplierId(r.po.supplier_id);
      // Prefill a line per PO item, qty defaulted to the outstanding balance.
      const prefilled: DraftLine[] = r.items.map((it) => {
        const outstanding = Math.max(0, (it.qty || 0) - (it.received_qty || 0));
        return {
          po_item_id: it.id,
          material_kind: it.material_kind,
          material_code: it.material_code,
          material_name: it.material_name,
          qty_received: String(outstanding),
          unit_cost_centi: it.unit_price_centi,
        };
      });
      setLines(prefilled);
    } catch (e: any) {
      toast.error(e?.message || "Could not load PO");
    } finally {
      setLoadingPo(false);
    }
  }

  function setLineQty(idx: number, v: string) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty_received: v } : l)));
  }

  async function create() {
    if (!supplierId) {
      toast.error("Pick a purchase order first");
      return;
    }
    if (!warehouseCode) {
      toast.error("Pick a warehouse");
      return;
    }
    const items = lines
      .map((l) => ({
        po_item_id: l.po_item_id,
        material_kind: l.material_kind,
        material_code: l.material_code,
        material_name: l.material_name,
        qty_received: parseInt(l.qty_received, 10) || 0,
        unit_cost_centi: l.unit_cost_centi,
      }))
      .filter((l) => l.qty_received > 0);
    if (items.length === 0) {
      toast.error("Enter a received quantity on at least one line");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ grn: ScmGrn }>("/api/scm-goods-receipts", {
        supplier_id: supplierId,
        purchase_order_id: poId || null,
        warehouse_code: warehouseCode,
        received_date: receivedDate || null,
        notes: notes.trim() || null,
        items,
      });
      toast.success(`Created ${r.grn.grn_number}`);
      navigate(`/scm/goods-receipts/${r.grn.id}`, { replace: true });
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
      breadcrumbs={[{ label: "Goods Receipts", to: "/scm/goods-receipts" }, { label: "New" }]}
      eyebrow="Supply Chain"
      title="New goods receipt"
      backTo="/scm/goods-receipts"
    >
      <div className="max-w-2xl space-y-3">
        <div className="space-y-3 rounded-md border border-border bg-surface p-4 shadow-stone">
          <label className="block">
            <span className={lbl}>Purchase order *</span>
            <select value={poId} onChange={(e) => selectPo(e.target.value)} className={field}>
              <option value="">— pick a PO to receive —</option>
              {poOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.po_number} · {p.supplier_name || ""} ({p.status.replace(/_/g, " ")})
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
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
            <label className="block">
              <span className={lbl}>Received date</span>
              <input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className={field} />
            </label>
          </div>
          <label className="block">
            <span className={lbl}>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={cn(field, "resize-none")} />
          </label>
        </div>

        <Section title="Receipt lines">
          {loadingPo ? (
            <p className="px-1 py-2 text-[12px] text-ink-muted">Loading PO lines…</p>
          ) : lines.length === 0 ? (
            <EmptyState
              icon={<Package size={18} />}
              message="No lines yet"
              description="Pick a purchase order above to load its outstanding lines."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                    <th className="py-1.5 pr-2">Material</th>
                    <th className="px-2 text-right">Unit cost</th>
                    <th className="px-2 text-right">Receive qty</th>
                    <th className="px-2 text-right">Line value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {lines.map((l, idx) => {
                    const qty = parseInt(l.qty_received, 10) || 0;
                    return (
                      <tr key={l.po_item_id || idx} className="hover:bg-bg/40">
                        <td className="py-1.5 pr-2">
                          <span className="font-mono font-medium text-ink">{l.material_code}</span>
                          {l.material_name && l.material_name !== l.material_code && (
                            <span className="block text-[10px] text-ink-muted">{l.material_name}</span>
                          )}
                        </td>
                        <td className="px-2 text-right font-mono">{rm(l.unit_cost_centi)}</td>
                        <td className="px-2 text-right">
                          <input
                            type="number"
                            min="0"
                            value={l.qty_received}
                            onChange={(e) => setLineQty(idx, e.target.value)}
                            className="w-20 rounded-md border border-border bg-paper px-2 py-1 text-right text-[12px]"
                          />
                        </td>
                        <td className="px-2 text-right font-mono font-semibold">{rm(qty * l.unit_cost_centi)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate("/scm/goods-receipts")} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={busy || !poId || !warehouseCode || lines.length === 0}
            className="flex-1"
            icon={<Plus size={13} />}
          >
            {busy ? "Creating…" : "Create draft GRN"}
          </Button>
        </div>
        <p className="text-[11px] text-ink-muted">
          Saved as a draft. Stock is only received when you post it on the next screen.
        </p>
      </div>
    </DetailLayout>
  );
}

// ── GRN view ────────────────────────────────────────────────────────────────
const NEXT_STATUS: Record<string, { label: string; action: "post"; icon: LucideIcon }[]> = {
  DRAFT: [{ label: "Post receipt", action: "post", icon: PackageCheck }],
};

function GrnView({ id }: { id: string }) {
  const toast = useToast();
  const detail = useQuery<DetailResp>(() => api.get(`/api/scm-goods-receipts/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const grn = detail.data?.grn;
  const supplier = detail.data?.supplier;
  const po = detail.data?.purchase_order;
  const items = detail.data?.items ?? [];

  async function post() {
    if (!confirm("Post this receipt? Stock will be received and the PO updated. This cannot be undone.")) return;
    setBusy(true);
    try {
      await api.post(`/api/scm-goods-receipts/${id}/post`);
      toast.success("Receipt posted — stock received");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Post failed");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!confirm("Cancel this draft GRN?")) return;
    setBusy(true);
    try {
      await api.post(`/api/scm-goods-receipts/${id}/cancel`);
      toast.success("GRN cancelled");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  const totalValue = items.reduce((s, it) => s + (it.qty_received || 0) * (it.unit_cost_centi || 0), 0);

  return (
    <DetailLayout
      breadcrumbs={[{ label: "Goods Receipts", to: "/scm/goods-receipts" }, { label: grn?.grn_number || "GRN" }]}
      eyebrow={grn ? `GRN · ${supplier?.name || ""}` : "Goods Receipt"}
      title={grn?.grn_number || "Goods Receipt"}
      backTo="/scm/goods-receipts"
      loading={detail.loading}
      error={detail.error}
      actions={
        grn ? (
          <div className="flex items-center gap-1.5">
            {(NEXT_STATUS[grn.status] || []).map((s) => {
              const Icon = s.icon;
              return (
                <HeaderButton key={s.action} variant="primary" disabled={busy} onClick={post}>
                  <Icon size={13} /> {s.label}
                </HeaderButton>
              );
            })}
            {grn.status === "DRAFT" && (
              <HeaderButton variant="danger" disabled={busy} onClick={cancel}>
                <Ban size={13} /> Cancel
              </HeaderButton>
            )}
          </div>
        ) : undefined
      }
    >
      {grn && (
        <DetailGrid>
          <DetailMain>
            <Section title="Received lines">
              {items.length === 0 ? (
                <EmptyState icon={<Package size={18} />} message="No lines" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                        <th className="py-1.5 pr-2">Material</th>
                        <th className="px-2 text-right">Qty received</th>
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
                          <td className="px-2 text-right">{it.qty_received}</td>
                          <td className="px-2 text-right font-mono">{rm(it.unit_cost_centi)}</td>
                          <td className="px-2 text-right font-mono font-semibold">
                            {rm((it.qty_received || 0) * (it.unit_cost_centi || 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
            {grn.status === "POSTED" && (
              <p className="mt-2 text-[11px] text-synced">
                Stock was received into {grn.warehouse_code} when this GRN was posted.
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
                          STATUS_TONE[grn.status] || "bg-bg text-ink-muted",
                        )}
                      >
                        {grn.status}
                      </span>
                    ),
                  },
                  { label: "Supplier", value: supplier ? `${supplier.code} · ${supplier.name}` : "—", full: true },
                  { label: "PO", value: po?.po_number || "—" },
                  { label: "Warehouse", value: grn.warehouse_code },
                  { label: "Received date", value: grn.received_date || "—" },
                  { label: "Total value", value: rm(totalValue), mono: true },
                  { label: "Notes", value: grn.notes || "—", full: true },
                ]}
              />
            </Section>
          </DetailAside>
        </DetailGrid>
      )}
    </DetailLayout>
  );
}
