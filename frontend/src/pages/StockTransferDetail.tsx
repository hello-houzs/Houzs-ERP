import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, Trash2, ArrowLeftRight, Ban, Package, ArrowRight, type LucideIcon } from "lucide-react";
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

interface TransferItem {
  id: string;
  material_kind: string;
  material_code: string;
  material_name: string | null;
  qty: number;
  notes: string | null;
}
interface ScmTransfer {
  id: string;
  transfer_number: string;
  from_warehouse_code: string;
  to_warehouse_code: string;
  status: string;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
}
interface DetailResp {
  transfer: ScmTransfer;
  items: TransferItem[];
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

export function StockTransferDetail() {
  const { id = "" } = useParams();
  if (id === "new") return <NewTransfer />;
  return <TransferView id={id} />;
}

// ── New Transfer ─────────────────────────────────────────────────────────────
// One editable transfer line in the New Transfer form.
interface DraftLine {
  material_kind: string;
  material_code: string;
  material_name: string;
  qty: string;
}

function NewTransfer() {
  const navigate = useNavigate();
  const toast = useToast();
  const warehouses = useQuery<{ data: Warehouse[] }>(() => api.get("/api/warehouses"), []);

  const [fromWarehouse, setFromWarehouse] = useState("");
  const [toWarehouse, setToWarehouse] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);

  function addLine() {
    setLines((prev) => [
      ...prev,
      { material_kind: "mfg_product", material_code: "", material_name: "", qty: "1" },
    ]);
  }
  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }
  function setLine(idx: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function create() {
    if (!fromWarehouse) {
      toast.error("Pick a source warehouse");
      return;
    }
    if (!toWarehouse) {
      toast.error("Pick a destination warehouse");
      return;
    }
    if (fromWarehouse === toWarehouse) {
      toast.error("From and to warehouse must differ");
      return;
    }
    const items = lines
      .map((l) => ({
        material_kind: l.material_kind,
        material_code: l.material_code.trim(),
        material_name: l.material_name.trim() || l.material_code.trim(),
        qty: parseInt(l.qty, 10) || 0,
      }))
      .filter((l) => l.material_code && l.qty > 0);
    if (items.length === 0) {
      toast.error("Add at least one line with a material code and quantity");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ transfer: ScmTransfer }>("/api/scm-stock-transfers", {
        from_warehouse_code: fromWarehouse,
        to_warehouse_code: toWarehouse,
        notes: notes.trim() || null,
        items,
      });
      toast.success(`Created ${r.transfer.transfer_number}`);
      navigate(`/scm/transfers/${r.transfer.id}`, { replace: true });
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
      breadcrumbs={[{ label: "Stock Transfers", to: "/scm/transfers" }, { label: "New" }]}
      eyebrow="Supply Chain"
      title="New stock transfer"
      backTo="/scm/transfers"
    >
      <div className="max-w-2xl space-y-3">
        <div className="space-y-3 rounded-md border border-border bg-surface p-4 shadow-stone">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={lbl}>From warehouse *</span>
              <select value={fromWarehouse} onChange={(e) => setFromWarehouse(e.target.value)} className={field}>
                <option value="">— pick a source —</option>
                {(warehouses.data?.data ?? []).map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={lbl}>To warehouse *</span>
              <select value={toWarehouse} onChange={(e) => setToWarehouse(e.target.value)} className={field}>
                <option value="">— pick a destination —</option>
                {(warehouses.data?.data ?? []).map((w) => (
                  <option key={w.code} value={w.code} disabled={w.code === fromWarehouse}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className={lbl}>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={cn(field, "resize-none")} />
          </label>
        </div>

        <Section
          title="Transfer lines"
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
              description="Add the materials and quantities to move between the two warehouses."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                    <th className="py-1.5 pr-2">Material code</th>
                    <th className="px-2">Name</th>
                    <th className="px-2 text-right">Qty</th>
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
                          min="1"
                          value={l.qty}
                          onChange={(e) => setLine(idx, { qty: e.target.value })}
                          className="w-16 rounded-md border border-border bg-paper px-2 py-1 text-right text-[12px]"
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
          <Button variant="secondary" onClick={() => navigate("/scm/transfers")} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={busy || !fromWarehouse || !toWarehouse || lines.length === 0}
            className="flex-1"
            icon={<Plus size={13} />}
          >
            {busy ? "Creating…" : "Create draft transfer"}
          </Button>
        </div>
        <p className="text-[11px] text-ink-muted">
          Saved as a draft. Stock is only moved when you post it on the next screen.
        </p>
      </div>
    </DetailLayout>
  );
}

// ── Transfer view ────────────────────────────────────────────────────────────
const NEXT_STATUS: Record<string, { label: string; action: "post"; icon: LucideIcon }[]> = {
  DRAFT: [{ label: "Post transfer", action: "post", icon: ArrowLeftRight }],
};

function TransferView({ id }: { id: string }) {
  const toast = useToast();
  const detail = useQuery<DetailResp>(() => api.get(`/api/scm-stock-transfers/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const transfer = detail.data?.transfer;
  const items = detail.data?.items ?? [];

  async function post() {
    if (!confirm("Post this transfer? Stock will be moved between the warehouses and this cannot be undone.")) return;
    setBusy(true);
    try {
      await api.post(`/api/scm-stock-transfers/${id}/post`);
      toast.success("Transfer posted — stock moved");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Post failed");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!confirm("Cancel this draft transfer?")) return;
    setBusy(true);
    try {
      await api.post(`/api/scm-stock-transfers/${id}/cancel`);
      toast.success("Transfer cancelled");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  const totalQty = items.reduce((s, it) => s + (it.qty || 0), 0);

  return (
    <DetailLayout
      breadcrumbs={[{ label: "Stock Transfers", to: "/scm/transfers" }, { label: transfer?.transfer_number || "Transfer" }]}
      eyebrow={transfer ? "Stock Transfer" : "Stock Transfer"}
      title={transfer?.transfer_number || "Stock Transfer"}
      backTo="/scm/transfers"
      loading={detail.loading}
      error={detail.error}
      actions={
        transfer ? (
          <div className="flex items-center gap-1.5">
            {(NEXT_STATUS[transfer.status] || []).map((s) => {
              const Icon = s.icon;
              return (
                <HeaderButton key={s.action} variant="primary" disabled={busy} onClick={post}>
                  <Icon size={13} /> {s.label}
                </HeaderButton>
              );
            })}
            {transfer.status === "DRAFT" && (
              <HeaderButton variant="danger" disabled={busy} onClick={cancel}>
                <Ban size={13} /> Cancel
              </HeaderButton>
            )}
          </div>
        ) : undefined
      }
    >
      {transfer && (
        <DetailGrid>
          <DetailMain>
            <Section title="Transfer lines">
              {items.length === 0 ? (
                <EmptyState icon={<Package size={18} />} message="No lines" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-brand text-ink-muted">
                        <th className="py-1.5 pr-2">Material</th>
                        <th className="px-2 text-right">Qty</th>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
            {transfer.status === "POSTED" && (
              <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-synced">
                Stock was moved from {transfer.from_warehouse_code}
                <ArrowRight size={12} /> {transfer.to_warehouse_code} when this transfer was posted.
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
                          STATUS_TONE[transfer.status] || "bg-bg text-ink-muted",
                        )}
                      >
                        {transfer.status}
                      </span>
                    ),
                  },
                  { label: "From", value: transfer.from_warehouse_code },
                  { label: "To", value: transfer.to_warehouse_code },
                  { label: "Total qty", value: String(totalQty) },
                  { label: "Notes", value: transfer.notes || "—", full: true },
                ]}
              />
            </Section>
          </DetailAside>
        </DetailGrid>
      )}
    </DetailLayout>
  );
}
