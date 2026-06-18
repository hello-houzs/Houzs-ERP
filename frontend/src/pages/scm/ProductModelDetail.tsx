import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { Panel } from "../../components/Panel";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { Field, Input, Select } from "./Suppliers";

// GET /api/scm/product-models/:id returns { model, skus } — the Model master
// row plus its side-loaded variant SKUs (one row per mfg_products row whose
// model_id = this Model). The master record (name / branding / description /
// active / allowed-options pools) is editable via the Edit panel; per-SKU
// pricing and the SKU generator stay in the source 2990's editor, out of
// scope for this port.
interface ProductModelDetail {
  id: string;
  branding: string | null;
  model_code: string;
  name: string;
  category: string;
  description: string | null;
  photo_url: string | null;
  allowed_options: Record<string, unknown> | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// Side-loaded SKU rows — the subset of mfg_products columns the route selects.
interface ModelSku {
  id: string;
  code: string;
  name: string;
  size_code: string | null;
  size_label: string | null;
  status: string;
  base_price_sen: number | null;
  price1_sen: number | null;
  cost_price_sen: number | null;
  unit_m3_milli: number;
  pos_active: boolean | null;
  one_shot: boolean | null;
  source_doc_no: string | null;
}

// allowed_options is a free-form JSONB pool map (sizes / compartments /
// leg_heights / specials / …). Render each non-empty array key as a labelled
// chip group so the Model's variant axes are visible without an editor.
function allowedOptionGroups(opts: Record<string, unknown> | null): Array<{ key: string; values: string[] }> {
  if (!opts) return [];
  const out: Array<{ key: string; values: string[] }> = [];
  for (const [key, raw] of Object.entries(opts)) {
    if (Array.isArray(raw) && raw.length > 0) {
      out.push({ key, values: raw.map((v) => String(v)) });
    }
  }
  return out;
}

function fmtUnitM3(milli: number): string {
  return (milli / 1000).toFixed(3);
}

export function ScmProductModelDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);

  const detail = useQuery<{ model: ProductModelDetail; skus: ModelSku[] }>(
    () => api.get(`${SCM}/product-models/${encodeURIComponent(id ?? "")}`),
    [id],
  );

  const model = detail.data?.model;
  const skus = detail.data?.skus ?? null;

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/product-models")} />
        <EmptyState message="Failed to load product model" description={detail.error} />
      </div>
    );
  }

  const optionGroups = allowedOptionGroups(model?.allowed_options ?? null);

  const skuCols: Column<ModelSku>[] = [
    {
      key: "code",
      label: "SKU Code",
      render: (s) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[12px] font-semibold text-ink">{s.code}</span>
          {s.one_shot && (
            <span
              className="rounded bg-surface-dim px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-muted"
              title={s.source_doc_no ? `One-shot from ${s.source_doc_no}` : "One-shot SKU"}
            >
              one-shot
            </span>
          )}
        </span>
      ),
      getValue: (s) => s.code,
    },
    { key: "name", label: "Description", render: (s) => s.name, getValue: (s) => s.name },
    {
      key: "size_label",
      label: "Size",
      render: (s) => s.size_label || s.size_code || "—",
      getValue: (s) => s.size_label || s.size_code || "",
    },
    {
      key: "base_price_sen",
      label: "Price 2",
      align: "right",
      render: (s) => (
        <span className={cn("font-mono", s.base_price_sen ? "text-ink" : "text-ink-muted")}>
          {s.base_price_sen ? fmtCenti(s.base_price_sen) : "—"}
        </span>
      ),
      getValue: (s) => s.base_price_sen ?? 0,
    },
    {
      key: "price1_sen",
      label: "Price 1",
      align: "right",
      render: (s) => (
        <span className={cn("font-mono", s.price1_sen ? "text-ink" : "text-ink-muted")}>
          {s.price1_sen ? fmtCenti(s.price1_sen) : "—"}
        </span>
      ),
      getValue: (s) => s.price1_sen ?? 0,
    },
    {
      key: "cost_price_sen",
      label: "Cost",
      align: "right",
      defaultHidden: true,
      render: (s) => (
        <span className={cn("font-mono", s.cost_price_sen ? "text-ink-secondary" : "text-ink-muted")}>
          {s.cost_price_sen ? fmtCenti(s.cost_price_sen) : "—"}
        </span>
      ),
      getValue: (s) => s.cost_price_sen ?? 0,
    },
    {
      key: "unit_m3_milli",
      label: "Unit (m³)",
      align: "right",
      defaultHidden: true,
      render: (s) => <span className="font-mono text-ink-secondary">{fmtUnitM3(s.unit_m3_milli)}</span>,
      getValue: (s) => s.unit_m3_milli,
    },
    {
      key: "status",
      label: "Status",
      render: (s) => (
        <span
          className={cn(
            "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
            scmStatusClasses(s.status),
          )}
        >
          {s.status}
        </span>
      ),
      getValue: (s) => s.status,
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/product-models")} />
      <PageHeader
        eyebrow={model ? `Model · ${model.model_code}` : "Product Model"}
        title={model?.name ?? (detail.loading ? "Loading…" : "Product Model")}
        primaryAction={
          model ? (
            <Button variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : undefined
        }
      />

      {/* Master info */}
      {model && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Model Record</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(model.active ? "ACTIVE" : "BLOCKED"),
              )}
            >
              {model.active ? "ACTIVE" : "INACTIVE"}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Model Code" value={model.model_code} mono />
            <Info label="Category" value={model.category} />
            <Info label="Branding" value={model.branding} />
            <Info label="SKU Variants" value={skus ? String(skus.length) : "—"} />
          </dl>
          {model.description && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {model.description}
            </div>
          )}

          {/* Allowed-options pools — the Model's variant axes (read-only). */}
          {optionGroups.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-border-subtle pt-3">
              {optionGroups.map((g) => (
                <div key={g.key} className="flex flex-wrap items-baseline gap-1.5">
                  <span className="mr-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    {g.key.replace(/_/g, " ")}
                  </span>
                  {g.values.map((v) => (
                    <span
                      key={v}
                      className="rounded border border-border bg-surface-dim px-1.5 py-0.5 text-[11px] text-ink-secondary"
                    >
                      {v}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SKU variants */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">SKU Variants</h3>
      </div>
      <DataTable
        tableId="scm_product_model_skus"
        columns={skuCols}
        rows={skus}
        loading={detail.loading}
        getRowKey={(s) => s.id}
        emptyLabel="No SKU variants under this model yet"
        exportName="product-model-skus"
      />

      {editing && model && (
        <EditProductModelPanel
          model={model}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            detail.reload();
          }}
        />
      )}
    </div>
  );
}

// ── Allowed-options pool serialization ──────────────────────────────────────
// allowed_options is a free-form JSONB map of pool key → string[] (sizes /
// compartments / leg_heights / specials / …). For a pragmatic editor we expose
// each ARRAY-valued pool as one CSV textarea row. Non-array values (if any
// future pool stores a scalar/object) are preserved untouched and NOT shown —
// we only round-trip the array pools the UI understands.
interface PoolField {
  key: string;
  csv: string;
}

function poolsToFields(opts: Record<string, unknown> | null): PoolField[] {
  if (!opts) return [];
  const out: PoolField[] = [];
  for (const [key, raw] of Object.entries(opts)) {
    if (Array.isArray(raw)) out.push({ key, csv: raw.map((v) => String(v)).join(", ") });
  }
  return out;
}

// Rebuild allowed_options: start from the original (to keep any non-array keys
// the UI didn't surface), then overwrite each edited array pool with its parsed
// CSV. Empty CSV → empty array (keeps the pool key present). Only sends when the
// model actually had pools or the user has some — caller decides inclusion.
function fieldsToPools(
  original: Record<string, unknown> | null,
  fields: PoolField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Preserve non-array keys from the original payload verbatim.
  if (original) {
    for (const [key, raw] of Object.entries(original)) {
      if (!Array.isArray(raw)) out[key] = raw;
    }
  }
  for (const f of fields) {
    out[f.key] = f.csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return out;
}

const MODEL_STATUSES = ["Active", "Inactive"];

function EditProductModelPanel({
  model,
  onClose,
  onSaved,
}: {
  model: ProductModelDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    modelCode: model.model_code ?? "",
    name: model.name ?? "",
    branding: model.branding ?? "",
    description: model.description ?? "",
    status: model.active ? "Active" : "Inactive",
  });
  const [pools, setPools] = useState<PoolField[]>(() => poolsToFields(model.allowed_options));
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setPool = (i: number, csv: string) =>
    setPools((p) => p.map((f, idx) => (idx === i ? { ...f, csv } : f)));

  async function submit() {
    if (!form.modelCode.trim()) {
      toast.error("Model code is required");
      return;
    }
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`${SCM}/product-models/${model.id}`, {
        modelCode: form.modelCode.trim(),
        name: form.name.trim(),
        branding: form.branding.trim() || null,
        description: form.description.trim() || null,
        active: form.status === "Active",
        allowedOptions: fieldsToPools(model.allowed_options, pools),
      });
      toast.success("Model updated");
      onSaved();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(msg.includes("duplicate_code") ? "That model code already exists" : "Failed to update model");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      dirty
      onAttemptClose={onClose}
      title={`Edit ${model.model_code}`}
      subtitle="Update the model master record."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Model Code" required>
          <Input value={form.modelCode} onChange={(v) => set("modelCode", v)} />
        </Field>
        <Field label="Name" required>
          <Input value={form.name} onChange={(v) => set("name", v)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Branding">
            <Input value={form.branding} onChange={(v) => set("branding", v)} />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={(v) => set("status", v)} options={MODEL_STATUSES} />
          </Field>
        </div>
        {/* Category is fixed after create — patching it would orphan SKUs. */}
        <Field label="Category">
          <div className="flex h-10 items-center rounded-md border border-border bg-surface-dim px-3 text-[13px] capitalize text-ink-secondary">
            {model.category.toLowerCase()}
          </div>
        </Field>
        <Field label="Description">
          <textarea
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </Field>

        {/* Allowed-options pools — one CSV textarea per array pool. */}
        {pools.length > 0 && (
          <div className="space-y-3 border-t border-border-subtle pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
              Allowed-Options Pools
            </div>
            {pools.map((f, i) => (
              <Field key={f.key} label={f.key.replace(/_/g, " ")}>
                <textarea
                  value={f.csv}
                  onChange={(e) => setPool(i, e.target.value)}
                  rows={2}
                  placeholder="comma-separated values"
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </Field>
            ))}
            <p className="text-[11px] leading-relaxed text-ink-muted">
              Comma-separated. These are the variant axes the SO/PO picker reads. New pool keys are added
              from the source editor.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
    >
      <ArrowLeft size={14} />
      Product Models
    </button>
  );
}

function Info({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}
