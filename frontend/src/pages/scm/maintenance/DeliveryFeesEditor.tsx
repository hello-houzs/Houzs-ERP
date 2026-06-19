// ----------------------------------------------------------------------------
// DeliveryFeesEditor — Maintenance tab body for delivery pricing. Two sections:
//   1. The global delivery-fee config singleton (base fee, cross-category fee,
//      lead days) — explicit Edit → Save.
//   2. Per-Model special delivery fees — a list that overrides the base fee for
//      a tagged Model (add / edit / delete).
// Self-contained: fetches its own config, special list, and the model picker.
//
// API — backend/src/scm/routes/delivery-fees.ts, /api/scm/delivery-fees:
//   GET   /          -> { baseFee, crossCategoryFee, mattressBedframeLeadDays,
//                         sofaLeadDays, updatedAt, updatedBy }
//   PATCH /          -> { ok }   body: any subset of the four camelCase fields
//   GET    /special  -> [{ modelId, modelName, modelCode, category,
//                          standaloneFee, crossCatFollowupFee, updatedAt }]
//   PUT    /special  -> { ok }   body { modelId, standaloneFee, crossCatFollowupFee }
//   DELETE /special/:modelId -> { ok }
// Model picker — GET /api/scm/product-models -> { models }.
//
// UNITS: every fee here is WHOLE MYR (the route validates int().nonnegative();
// NOT *_centi / *_sen). So inputs are plain integer ringgit, no sen decimals.
// PATCH/PUT are editor-role gated (403 → friendly toast). No naked edits.
// pg camelCase trap: config + special rows are dual-read camelCase ?? snake_case.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "../../../components/Button";
import { DataTable, type Column } from "../../../components/DataTable";
import { Panel } from "../../../components/Panel";
import { useQuery } from "../../../hooks/useQuery";
import { useToast } from "../../../hooks/useToast";
import { useDialog } from "../../../hooks/useDialog";
import { api } from "../../../api/client";
import { SCM } from "../../../lib/scm";
import { cn } from "../../../lib/utils";
import { Field, Input } from "../Suppliers";

// ── Config singleton ─────────────────────────────────────────────────────────
interface ConfigApi {
  baseFee?: number;
  base_fee?: number;
  crossCategoryFee?: number;
  cross_category_fee?: number;
  mattressBedframeLeadDays?: number;
  mattress_bedframe_lead_days?: number;
  sofaLeadDays?: number;
  sofa_lead_days?: number;
  updatedAt?: string | null;
  updated_at?: string | null;
}

interface Config {
  baseFee: number;
  crossCategoryFee: number;
  mattressBedframeLeadDays: number;
  sofaLeadDays: number;
  updatedAt: string | null;
}

function normalizeConfig(r: ConfigApi): Config {
  return {
    baseFee: r.baseFee ?? r.base_fee ?? 0,
    crossCategoryFee: r.crossCategoryFee ?? r.cross_category_fee ?? 0,
    mattressBedframeLeadDays: r.mattressBedframeLeadDays ?? r.mattress_bedframe_lead_days ?? 0,
    sofaLeadDays: r.sofaLeadDays ?? r.sofa_lead_days ?? 0,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
  };
}

// ── Per-Model special fees ───────────────────────────────────────────────────
interface SpecialApi {
  modelId?: string;
  model_id?: string;
  modelName?: string;
  model_name?: string;
  modelCode?: string | null;
  model_code?: string | null;
  category?: string | null;
  standaloneFee?: number;
  standalone_fee?: number;
  crossCatFollowupFee?: number;
  cross_cat_followup_fee?: number;
}

interface Special {
  modelId: string;
  modelName: string;
  modelCode: string | null;
  category: string | null;
  standaloneFee: number;
  crossCatFollowupFee: number;
}

function normalizeSpecial(r: SpecialApi): Special {
  return {
    modelId: r.modelId ?? r.model_id ?? "",
    modelName: r.modelName ?? r.model_name ?? "(unknown model)",
    modelCode: r.modelCode ?? r.model_code ?? null,
    category: r.category ?? null,
    standaloneFee: r.standaloneFee ?? r.standalone_fee ?? 0,
    crossCatFollowupFee: r.crossCatFollowupFee ?? r.cross_cat_followup_fee ?? 0,
  };
}

interface ModelApi {
  id: string;
  model_code?: string;
  modelCode?: string;
  name: string;
  category?: string | null;
}

// Whole-MYR integer parse: empty/non-numeric → 0, negatives clamped, decimals trunc'd.
function parseFee(s: string): number {
  const n = Number(s.trim());
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}
function fmtRm(n: number): string {
  return `RM ${n.toLocaleString("en-MY")}`;
}
function isForbidden(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? "");
  return msg.includes("forbidden") || msg.includes("403");
}

export function DeliveryFeesEditor() {
  const config = useQuery<ConfigApi>(() => api.get(`${SCM}/delivery-fees`), []);
  const specials = useQuery<SpecialApi[]>(() => api.get(`${SCM}/delivery-fees/special`), []);

  return (
    <div className="space-y-6">
      <ConfigSection
        loading={config.loading}
        error={config.error}
        data={config.data ? normalizeConfig(config.data) : null}
        reload={config.reload}
      />
      <SpecialSection
        loading={specials.loading}
        error={specials.error}
        rows={specials.data ? specials.data.map(normalizeSpecial) : null}
        reload={specials.reload}
      />
    </div>
  );
}

// ── Section 1: global config ─────────────────────────────────────────────────
function ConfigSection({
  loading,
  error,
  data,
  reload,
}: {
  loading: boolean;
  error: string | null;
  data: Config | null;
  reload: () => void;
}) {
  const toast = useToast();
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ baseFee: "0", crossCategoryFee: "0", mattressBedframeLeadDays: "0", sofaLeadDays: "0" });

  function startEdit() {
    if (!data) return;
    setForm({
      baseFee: String(data.baseFee),
      crossCategoryFee: String(data.crossCategoryFee),
      mattressBedframeLeadDays: String(data.mattressBedframeLeadDays),
      sofaLeadDays: String(data.sofaLeadDays),
    });
    setEditMode(true);
  }
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      await api.patch(`${SCM}/delivery-fees`, {
        baseFee: parseFee(form.baseFee),
        crossCategoryFee: parseFee(form.crossCategoryFee),
        mattressBedframeLeadDays: parseFee(form.mattressBedframeLeadDays),
        sofaLeadDays: parseFee(form.sofaLeadDays),
      });
      toast.success("Delivery fee config saved");
      setEditMode(false);
      reload();
    } catch (e) {
      toast.error(isForbidden(e) ? "You don't have permission to edit delivery fees" : "Failed to save delivery fee config");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="py-8 text-center text-[13px] text-ink-muted">Loading delivery fee config…</p>;
  if (error) {
    return (
      <div className="rounded-lg border border-err/30 bg-err/5 p-4 text-[13px] text-ink">
        <strong>Failed to load delivery fee config.</strong>
        <div className="mt-1 text-ink-secondary">{error}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-[14px] font-bold text-ink">Global Delivery Config</h3>
          <p className="mt-0.5 max-w-xl text-[12px] text-ink-secondary">
            Base delivery fee, the cross-category follow-up fee, and per-category lead times. All fees are
            whole RM. Per-Model overrides live below.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editMode ? (
            <>
              <Button variant="secondary" onClick={() => setEditMode(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save Changes"}
              </Button>
            </>
          ) : (
            <Button icon={<Pencil size={15} />} onClick={startEdit}>
              Edit
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ConfigRow label="Base Delivery Fee" unit="RM" editMode={editMode} value={editMode ? form.baseFee : data?.baseFee ?? 0} onChange={(v) => set("baseFee", v)} />
        <ConfigRow label="Cross-Category Fee" unit="RM" editMode={editMode} value={editMode ? form.crossCategoryFee : data?.crossCategoryFee ?? 0} onChange={(v) => set("crossCategoryFee", v)} />
        <ConfigRow label="Mattress / Bedframe Lead" unit="days" editMode={editMode} value={editMode ? form.mattressBedframeLeadDays : data?.mattressBedframeLeadDays ?? 0} onChange={(v) => set("mattressBedframeLeadDays", v)} />
        <ConfigRow label="Sofa Lead" unit="days" editMode={editMode} value={editMode ? form.sofaLeadDays : data?.sofaLeadDays ?? 0} onChange={(v) => set("sofaLeadDays", v)} />
      </div>

      {data?.updatedAt && (
        <p className="text-[11px] text-ink-muted">
          Last updated{" "}
          <span className="font-mono text-ink-secondary">{new Date(data.updatedAt).toLocaleString("en-MY")}</span>
        </p>
      )}
    </div>
  );
}

function ConfigRow({
  label,
  unit,
  value,
  editMode,
  onChange,
}: {
  label: string;
  unit: string;
  value: number | string;
  editMode: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-stone">
      <span className="text-[13px] font-semibold text-ink">{label}</span>
      {editMode ? (
        <div className="flex items-center gap-1.5">
          {unit === "RM" && <span className="text-[12px] font-semibold text-ink-muted">RM</span>}
          <input
            type="number"
            min={0}
            step={1}
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            className={cn(
              "h-9 w-28 rounded-md border border-border bg-surface px-2 text-right font-mono text-[13px] text-ink outline-none transition-colors",
              "focus:border-accent focus:ring-2 focus:ring-accent/20",
            )}
          />
          {unit === "days" && <span className="text-[12px] font-semibold text-ink-muted">days</span>}
        </div>
      ) : (
        <span className="font-mono text-[14px] font-semibold text-ink">
          {unit === "RM" ? fmtRm(Number(value)) : `${Number(value).toLocaleString("en-MY")} days`}
        </span>
      )}
    </div>
  );
}

// ── Section 2: per-Model special fees ────────────────────────────────────────
function SpecialSection({
  loading,
  error,
  rows,
  reload,
}: {
  loading: boolean;
  error: string | null;
  rows: Special[] | null;
  reload: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Special | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const modelsQ = useQuery<{ models: ModelApi[] }>(() => api.get(`${SCM}/product-models`), []);
  const models = modelsQ.data?.models ?? [];
  const taggedIds = new Set((rows ?? []).map((r) => r.modelId));
  const untaggedModels = models.filter((m) => !taggedIds.has(m.id));

  async function remove(s: Special) {
    const ok = await dialog.confirm({
      title: "Remove special fee",
      message: `Remove the special delivery fee for "${s.modelName}"? It reverts to the base / cross-category fee.`,
      danger: true,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setDeleting(s.modelId);
    try {
      await api.del(`${SCM}/delivery-fees/special/${s.modelId}`);
      toast.success("Special fee removed");
      reload();
    } catch (e) {
      toast.error(isForbidden(e) ? "You don't have permission to edit delivery fees" : "Failed to remove special fee");
    } finally {
      setDeleting(null);
    }
  }

  const columns: Column<Special>[] = [
    {
      key: "model",
      label: "Model",
      render: (s) => (
        <span className="text-ink">
          {s.modelCode && <span className="font-mono text-[12px] text-ink-secondary">{s.modelCode} · </span>}
          <span className="font-medium">{s.modelName}</span>
        </span>
      ),
      getValue: (s) => `${s.modelCode ?? ""} ${s.modelName}`,
    },
    {
      key: "category",
      label: "Category",
      render: (s) => <span className="text-[12px] text-ink-secondary">{s.category || "—"}</span>,
      getValue: (s) => s.category ?? "",
    },
    {
      key: "standaloneFee",
      label: "Standalone Fee",
      align: "right",
      render: (s) => <span className="font-mono text-ink">{fmtRm(s.standaloneFee)}</span>,
      getValue: (s) => s.standaloneFee,
    },
    {
      key: "crossCatFollowupFee",
      label: "Cross-Cat Follow-up",
      align: "right",
      render: (s) => <span className="font-mono text-ink">{fmtRm(s.crossCatFollowupFee)}</span>,
      getValue: (s) => s.crossCatFollowupFee,
    },
    {
      key: "_actions",
      label: "",
      align: "right",
      alwaysVisible: true,
      render: (s) => (
        <span className="inline-flex items-center gap-1.5">
          <button
            onClick={() => setEditing(s)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
            title="Edit special fee"
          >
            <Pencil size={12} />
            Edit
          </button>
          <button
            onClick={() => void remove(s)}
            disabled={deleting === s.modelId}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-err/40 bg-surface px-2 text-[11px] font-semibold text-err transition-colors hover:bg-err/5 hover:border-err disabled:opacity-50"
            title="Remove special fee"
          >
            <Trash2 size={12} />
            Remove
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3 border-t border-border-subtle pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-[14px] font-bold text-ink">Per-Model Special Fees</h3>
          <p className="mt-0.5 max-w-xl text-[12px] text-ink-secondary">
            Tag a Model with its own standalone delivery fee plus a cross-category follow-up fee. Untagged
            Models use the global config above. All fees are whole RM.
          </p>
        </div>
        <Button icon={<Plus size={15} />} onClick={() => setShowCreate(true)} disabled={untaggedModels.length === 0}>
          Add Special Fee
        </Button>
      </div>

      <DataTable
        tableId="scm_delivery_special_fees"
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        getRowKey={(s) => s.modelId}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search model, category…",
        }}
        emptyLabel="No special fees yet"
        exportName="delivery-special-fees"
      />

      {showCreate && (
        <SpecialPanel
          mode="create"
          models={untaggedModels}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            reload();
          }}
        />
      )}

      {editing && (
        <SpecialPanel
          mode="edit"
          special={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function SpecialPanel({
  mode,
  special,
  models = [],
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  special?: Special;
  models?: ModelApi[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const isEdit = mode === "edit";
  const [modelId, setModelId] = useState(special?.modelId ?? models[0]?.id ?? "");
  const [standaloneFee, setStandaloneFee] = useState(String(special?.standaloneFee ?? ""));
  const [crossCatFollowupFee, setCrossCatFollowupFee] = useState(String(special?.crossCatFollowupFee ?? ""));

  const dirty = isEdit || standaloneFee.trim() !== "" || crossCatFollowupFee.trim() !== "";

  async function submit() {
    if (!modelId) {
      toast.error("Pick a model");
      return;
    }
    setSaving(true);
    try {
      await api.put(`${SCM}/delivery-fees/special`, {
        modelId,
        standaloneFee: parseFee(standaloneFee),
        crossCatFollowupFee: parseFee(crossCatFollowupFee),
      });
      toast.success(isEdit ? "Special fee updated" : "Special fee added");
      onSaved();
    } catch (e) {
      toast.error(isForbidden(e) ? "You don't have permission to edit delivery fees" : isEdit ? "Failed to update special fee" : "Failed to add special fee");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      dirty={dirty}
      onAttemptClose={onClose}
      title={isEdit ? `Edit ${special?.modelName}` : "Add Special Fee"}
      subtitle="A per-Model delivery fee override. Fees are whole RM."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Special Fee"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Model" required>
          {isEdit ? (
            <div className="flex h-10 items-center rounded-md border border-border bg-surface-dim px-3 text-[13px] font-semibold text-ink-secondary">
              {special?.modelCode ? `${special.modelCode} · ` : ""}
              {special?.modelName}
            </div>
          ) : (
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {(m.modelCode ?? m.model_code) ? `${m.modelCode ?? m.model_code} · ` : ""}
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Standalone Fee (RM)">
          <Input value={standaloneFee} onChange={setStandaloneFee} type="number" placeholder="0" />
        </Field>
        <Field label="Cross-Category Follow-up Fee (RM)">
          <Input value={crossCatFollowupFee} onChange={setCrossCatFollowupFee} type="number" placeholder="0" />
        </Field>
      </div>
    </Panel>
  );
}
