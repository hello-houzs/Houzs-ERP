import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, Trash2, ClipboardCheck, Ban, Package, type LucideIcon } from "lucide-react";
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

interface StocktakeItem {
  id: string;
  material_kind: string;
  material_code: string;
  material_name: string | null;
  system_qty: number;
  counted_qty: number;
  notes: string | null;
}
interface ScmStocktake {
  id: string;
  stocktake_number: string;
  warehouse_code: string;
  status: string;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
}
interface DetailResp {
  stocktake: ScmStocktake;
  items: StocktakeItem[];
}
interface Warehouse {
  code: string;
  name: string;
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-bg text-ink-muted",
  POSTED: "bg-synced/10 text-synced",
  CANCELLED: "bg-err/10 text-err",
};

export function StocktakeDetail() {
  const { id = "" } = useParams();
  if (id === "new") return <NewStocktake />;
  return <StocktakeView id={id} />;
}

// ── New Stocktake ────────────────────────────────────────────────────────────
// One editable count line in the New Stocktake form (system_qty is snapshotted
// server-side on save).
interface DraftLine {
  material_kind: string;
  material_code: string;
  material_name: string;
  counted_qty: string;
}

function NewStocktake() {
  const navigate = useNavigate();
  const toast = useToast();
  const warehouses = useQuery<{ data: Warehouse[] }>(() => api.get("/api/warehouses"), []);

  const [warehouseCode, setWarehouseCode] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);

  function addLine() {
    setLines((prev) => [
      ...prev,
      { material_kind: "mfg_product", material_code: "", material_name: "", counted_qty: "0" },
    ]);
  }
  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }
  function setLine(idx: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function create() {
    if (!warehouseCode) {
      toast.error("Pick a warehouse");
      return;
    }
    const items = lines
      .map((l) => ({
        material_kind: l.material_kind,
        material_code: l.material_code.trim(),
        material_name: l.material_name.trim() || l.material_code.trim(),
        counted_qty: parseInt(l.counted_qty, 10) || 0,
      }))
      .filter((l) => l.material_code);
    if (items.length === 0) {
      toast.error("Add at least one line with a material code");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ stocktake: ScmStocktake }>("/api/scm-stocktakes", {
        warehouse_code: warehouseCode,
        notes: notes.trim() || null,
        items,
      });
      toast.success(`Created ${r.stocktake.stocktake_number}`);
      navigate(`/scm/stocktakes/${r.stocktake.id}`, { replace: true });
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
      breadcrumbs={[{ label: "Stocktake", to: "/scm/stocktakes" }, { label: "New" }]}
      eyebrow="Supply Chain"
      title="New stocktake"
      backTo="/scm/stocktakes"
    >
      <div className="max-w-2xl space-y-3">
        <div className="space-y-3 rounded-md border border-border bg-surface p-4 shadow-stone">
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
            <span className={lbl}>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={cn(field, "resize-none")} />
          </label>
        </div>

        <Section
          title="Count lines"
          actions={
            <Button variant="secondary" icon={<Plus size={12} />} onClick={addLine}>
              Add line
            </Button>
          }
        >
          {lines.length === 0 ? (
            <EmptyState
              icon={<Package size={18} />}
              message="No lines yet"
              description="Add the materials you counted. The system on-hand is snapshotted when you save."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                    <th className="py-1.5 pr-2">Material code</th>
                    <th className="px-2">Name</th>
                    <th className="px-2 text-right">Counted qty</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {lines.map((l, idx) => (
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
                          value={l.counted_qty}
                          onChange={(e) => setLine(idx, { counted_qty: e.target.value })}
                          className="w-20 rounded-md border border-border bg-paper px-2 py-1 text-right text-[12px]"
                        />
                      </td>
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
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate("/scm/stocktakes")} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={busy || !warehouseCode || lines.length === 0}
            className="flex-1"
            icon={<Plus size={13} />}
          >
            {busy ? "Creating…" : "Create draft stocktake"}
          </Button>
        </div>
        <p className="text-[11px] text-ink-muted">
          Saved as a draft. Stock adjustments are only applied when you post it on the next screen.
        </p>
      </div>
    </DetailLayout>
  );
}

// ── Stocktake view ───────────────────────────────────────────────────────────
const NEXT_STATUS: Record<string, { label: string; action: "post"; icon: LucideIcon }[]> = {
  DRAFT: [{ label: "Post stocktake", action: "post", icon: ClipboardCheck }],
};

function StocktakeView({ id }: { id: string }) {
  const toast = useToast();
  const detail = useQuery<DetailResp>(() => api.get(`/api/scm-stocktakes/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const stocktake = detail.data?.stocktake;
  const items = detail.data?.items ?? [];

  async function post() {
    if (!confirm("Post this stocktake? On-hand stock will be adjusted to the counted figures and this cannot be undone.")) return;
    setBusy(true);
    try {
      await api.post(`/api/scm-stocktakes/${id}/post`);
      toast.success("Stocktake posted — adjustments applied");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Post failed");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!confirm("Cancel this draft stocktake?")) return;
    setBusy(true);
    try {
      await api.post(`/api/scm-stocktakes/${id}/cancel`);
      toast.success("Stocktake cancelled");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  const adjustingLines = items.filter((it) => (it.counted_qty || 0) - (it.system_qty || 0) !== 0).length;

  return (
    <DetailLayout
      breadcrumbs={[{ label: "Stocktake", to: "/scm/stocktakes" }, { label: stocktake?.stocktake_number || "Stocktake" }]}
      eyebrow={stocktake ? "Stocktake" : "Stocktake"}
      title={stocktake?.stocktake_number || "Stocktake"}
      backTo="/scm/stocktakes"
      loading={detail.loading}
      error={detail.error}
      actions={
        stocktake ? (
          <div className="flex items-center gap-1.5">
            {(NEXT_STATUS[stocktake.status] || []).map((s) => {
              const Icon = s.icon;
              return (
                <HeaderButton key={s.action} variant="primary" disabled={busy} onClick={post}>
                  <Icon size={13} /> {s.label}
                </HeaderButton>
              );
            })}
            {stocktake.status === "DRAFT" && (
              <HeaderButton variant="danger" disabled={busy} onClick={cancel}>
                <Ban size={13} /> Cancel
              </HeaderButton>
            )}
          </div>
        ) : undefined
      }
    >
      {stocktake && (
        <DetailGrid>
          <DetailMain>
            <Section title="Count lines">
              {items.length === 0 ? (
                <EmptyState icon={<Package size={18} />} message="No lines" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                        <th className="py-1.5 pr-2">Material</th>
                        <th className="px-2 text-right">System</th>
                        <th className="px-2 text-right">Counted</th>
                        <th className="px-2 text-right">Diff</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {items.map((it) => {
                        const diff = (it.counted_qty || 0) - (it.system_qty || 0);
                        return (
                          <tr key={it.id} className="hover:bg-bg/40">
                            <td className="py-1.5 pr-2">
                              <span className="font-mono font-medium text-ink">{it.material_code}</span>
                              {it.material_name && it.material_name !== it.material_code && (
                                <span className="block text-[10px] text-ink-muted">{it.material_name}</span>
                              )}
                            </td>
                            <td className="px-2 text-right">{it.system_qty}</td>
                            <td className="px-2 text-right">{it.counted_qty}</td>
                            <td
                              className={cn(
                                "px-2 text-right font-mono font-semibold",
                                diff > 0 ? "text-synced" : diff < 0 ? "text-err" : "text-ink-muted",
                              )}
                            >
                              {diff > 0 ? `+${diff}` : diff}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
            {stocktake.status === "POSTED" && (
              <p className="mt-2 text-[11px] text-synced">
                On-hand stock in {stocktake.warehouse_code} was reconciled to the counted figures when this stocktake was posted.
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
                          STATUS_TONE[stocktake.status] || "bg-bg text-ink-muted",
                        )}
                      >
                        {stocktake.status}
                      </span>
                    ),
                  },
                  { label: "Warehouse", value: stocktake.warehouse_code },
                  { label: "Lines", value: String(items.length) },
                  {
                    label: stocktake.status === "POSTED" ? "Lines adjusted" : "Lines with variance",
                    value: String(adjustingLines),
                  },
                  { label: "Notes", value: stocktake.notes || "—", full: true },
                ]}
              />
            </Section>
          </DetailAside>
        </DetailGrid>
      )}
    </DetailLayout>
  );
}
