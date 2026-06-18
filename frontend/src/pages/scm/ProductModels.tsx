import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { Panel } from "../../components/Panel";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { api, buildQuery } from "../../api/client";
import { SCM, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { Field, Input, Select } from "./Suppliers";

// Response shape from GET /api/scm/product-models — snake_case, verbatim from
// the Hono route (backend/src/scm/routes/product-models.ts `productModels.get('/')`).
// Each Model is the second-layer template that groups many mfg_products SKUs
// (via model_id). The list returns master columns; the SKU count + variant rows
// come from GET /product-models/:id (see ProductModelDetail). Accepts ?category=.
export interface ProductModelRow {
  id: string;
  branding: string | null;
  model_code: string;
  name: string;
  category: string;
  description: string | null;
  photo_url: string | null;
  allowed_options: unknown;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// product_models.category enum (route CATEGORIES). `all` omits the ?category=
// param so the server returns every Model.
const CATEGORIES = [
  { value: "all", label: "All" },
  { value: "SOFA", label: "Sofa" },
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "ACCESSORY", label: "Accessory" },
  { value: "SERVICE", label: "Service" },
] as const;
type Category = (typeof CATEGORIES)[number]["value"];

function ActivePill({ active }: { active: boolean }) {
  const label = active ? "ACTIVE" : "INACTIVE";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(active ? "ACTIVE" : "BLOCKED"),
      )}
    >
      {label}
    </span>
  );
}

export function ScmProductModels() {
  const navigate = useNavigate();
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  // The route filters by category server-side, but has no ?search= param —
  // it returns the full (optionally category-scoped) set ordered by
  // category, model_code. Search is applied client-side over the loaded rows
  // (Model lists are small — no Model has more than a few dozen rows).
  const list = useQuery<{ models: ProductModelRow[] }>(
    () => api.get(`${SCM}/product-models${buildQuery({ category: category === "all" ? undefined : category })}`),
    [category],
  );

  const all = list.data?.models ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all == null
      ? null
      : q
        ? all.filter(
            (m) =>
              m.model_code.toLowerCase().includes(q) ||
              m.name.toLowerCase().includes(q) ||
              (m.branding ?? "").toLowerCase().includes(q),
          )
        : all;

  const columns: Column<ProductModelRow>[] = [
    {
      key: "model_code",
      label: "Code",
      render: (m) => <span className="font-mono text-[12px] font-semibold text-ink">{m.model_code}</span>,
      getValue: (m) => m.model_code,
    },
    {
      key: "name",
      label: "Name",
      render: (m) => <span className="font-medium text-ink">{m.name}</span>,
      getValue: (m) => m.name,
    },
    {
      key: "category",
      label: "Category",
      render: (m) => <span className="text-[12px] capitalize text-ink-secondary">{m.category.toLowerCase()}</span>,
      getValue: (m) => m.category,
    },
    {
      key: "branding",
      label: "Branding",
      render: (m) =>
        m.branding ? (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">{m.branding}</span>
        ) : (
          "—"
        ),
      getValue: (m) => m.branding || "",
    },
    {
      key: "description",
      label: "Description",
      render: (m) => <span className="text-ink-secondary">{m.description || "—"}</span>,
      getValue: (m) => m.description || "",
    },
    {
      key: "active",
      label: "Status",
      render: (m) => <ActivePill active={m.active} />,
      getValue: (m) => (m.active ? "ACTIVE" : "INACTIVE"),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Product Models"
        description="Model templates that group product SKUs by base model. Open one to see its variant SKUs."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => setShowCreate(true)}>
            New Model
          </Button>
        }
      />

      {/* Category filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            onClick={() => setCategory(c.value)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold transition-colors",
              category === c.value
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_product_models"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(m) => m.id}
        onRowClick={(m) => navigate(`/scm/product-models/${m.id}`)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, name, branding…",
        }}
        emptyLabel="No product models found"
        exportName="product-models"
      />

      {showCreate && (
        <CreateProductModelPanel
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            list.reload();
            navigate(`/scm/product-models/${id}`);
          }}
        />
      )}
    </div>
  );
}

// Real category values (drops the list's "all" sentinel) — mirrors the route's
// CATEGORIES enum. Category is set at create time and cannot be patched later
// (it would orphan SKUs in the other category — see PATCH route).
const MODEL_CATEGORIES = ["SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY", "SERVICE"];

function CreateProductModelPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    modelCode: "",
    name: "",
    category: "SOFA",
    branding: "",
    description: "",
  });
  const dirty =
    form.modelCode.trim() !== "" ||
    form.name.trim() !== "" ||
    form.branding.trim() !== "" ||
    form.description.trim() !== "" ||
    form.category !== "SOFA";
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

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
      const res = await api.post<{ model: { id: string } }>(`${SCM}/product-models`, {
        modelCode: form.modelCode.trim(),
        name: form.name.trim(),
        category: form.category,
        branding: form.branding.trim() || undefined,
        description: form.description.trim() || undefined,
      });
      toast.success("Model created");
      onCreated(res.model.id);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(msg.includes("duplicate_code") ? "That model code already exists" : "Failed to create model");
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
      title="New Model"
      subtitle="Create a model template. Add the allowed-options pools after saving."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Create Model"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Model Code" required>
          <Input value={form.modelCode} onChange={(v) => set("modelCode", v)} placeholder="e.g. 5530" />
        </Field>
        <Field label="Name" required>
          <Input value={form.name} onChange={(v) => set("name", v)} placeholder="e.g. SOFA 5530" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" required>
            <Select value={form.category} onChange={(v) => set("category", v)} options={MODEL_CATEGORIES} />
          </Field>
          <Field label="Branding">
            <Input value={form.branding} onChange={(v) => set("branding", v)} placeholder="optional" />
          </Field>
        </div>
        <Field label="Description">
          <textarea
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </Field>
      </div>
    </Panel>
  );
}
