import { useMemo, useState } from "react";
import { Plus, Pencil } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { Panel } from "../../components/Panel";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { Field, Input, Select } from "./Suppliers";

// Response shape from GET /api/scm/mfg-products — snake_case, verbatim from the
// Hono route (backend/src/scm/routes/mfg-products.ts `mfgProducts.get('/')`).
//
// ENDPOINT CHOICE: this page hits /mfg-products (the manufacturer SKU master),
// NOT /products. /products is the retail/POS catalogue (a different `products`
// table joined to categories/series) and 2990's "Products & Maintenance" page
// (SkuMasterTab) reads from /mfg-products via useMfgProducts(). The whole SCM
// layer — suppliers, inventory, PO/GRN lines — keys off mfg_products.code, so
// this is the catalogue the SCM surfaces actually reference.
//
// Money is integer *_sen → fmtCenti. The route filters to status='ACTIVE' and
// accepts ?category= + ?search= (server-side; search also matches barcode).
export interface MfgProductRow {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string | null;
  base_model: string | null;
  size_code: string | null;
  size_label: string | null;
  base_price_sen: number | null;
  price1_sen: number | null;
  sell_price_sen: number | null;
  pwp_price_sen: number | null;
  unit_m3_milli: number;
  status: string;
  branding: string | null;
  barcode: string | null;
  one_shot?: boolean;
  source_doc_no?: string | null;
}

// Catalogue categories (mfg_products.category). `all` is the unfiltered view —
// it omits the ?category= param so the server returns every ACTIVE SKU.
const CATEGORIES = [
  { value: "all", label: "All" },
  { value: "ACCESSORY", label: "Accessory" },
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "SOFA", label: "Sofa" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "SERVICE", label: "Service" },
] as const;
type Category = (typeof CATEGORIES)[number]["value"];

// Categories the create/edit form offers — mirrors the backend VALID_CATEGORIES
// set (SOFA/BEDFRAME/ACCESSORY/MATTRESS/SERVICE). `all` is a list filter only.
const FORM_CATEGORIES = ["BEDFRAME", "SOFA", "MATTRESS", "ACCESSORY", "SERVICE"];

// Unit volume is stored as integer m³ × 1000 (unit_m3_milli) — show 3 dp.
function fmtUnitM3(milli: number): string {
  return (milli / 1000).toFixed(3);
}

// ── Money <-> sen helpers for the form fields ────────────────────────────
// The form holds RM strings; the API takes integer *_sen. An empty string maps
// to null (clear / unset); a non-numeric string also maps to null so a typo
// never lands a NaN in the column.
function rmToSen(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function senToRm(sen: number | null | undefined): string {
  if (sen == null) return "";
  return (sen / 100).toFixed(2);
}
function rmToMilli(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {status}
    </span>
  );
}

export function ScmProducts() {
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<MfgProductRow | null>(null);

  const list = useQuery<{ products: MfgProductRow[] }>(
    () =>
      api.get(
        `${SCM}/mfg-products${buildQuery({
          category: category === "all" ? undefined : category,
          search: search || undefined,
        })}`,
      ),
    [category, search],
  );

  const rows = list.data?.products ?? null;

  const stats = useMemo(() => {
    const r = rows ?? [];
    return {
      distinctSku: r.length,
      priced: r.filter((x) => (x.base_price_sen ?? 0) > 0).length,
    };
  }, [rows]);

  const columns: Column<MfgProductRow>[] = [
    {
      key: "code",
      label: "Product Code",
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[12px] font-semibold text-ink">{r.code}</span>
          {r.one_shot && (
            <span
              className="rounded bg-surface-dim px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-muted"
              title={r.source_doc_no ? `One-shot from ${r.source_doc_no}` : "One-shot SKU"}
            >
              one-shot
            </span>
          )}
        </span>
      ),
      getValue: (r) => r.code,
    },
    {
      key: "name",
      label: "Description",
      render: (r) => (
        <span className="text-ink">
          {r.name}
          {r.description && <span className="text-ink-muted"> · {r.description}</span>}
        </span>
      ),
      getValue: (r) => r.name,
    },
    {
      key: "category",
      label: "Category",
      render: (r) => <span className="text-[12px] capitalize text-ink-secondary">{r.category.toLowerCase()}</span>,
      getValue: (r) => r.category,
    },
    {
      key: "base_model",
      label: "Model",
      render: (r) => r.base_model || "—",
      getValue: (r) => r.base_model || "",
    },
    {
      key: "branding",
      label: "Branding",
      defaultHidden: true,
      render: (r) =>
        r.branding ? (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">{r.branding}</span>
        ) : (
          "—"
        ),
      getValue: (r) => r.branding || "",
    },
    {
      key: "size_label",
      label: "Size",
      render: (r) => r.size_label || "—",
      getValue: (r) => r.size_label || "",
    },
    {
      key: "base_price_sen",
      label: "Price 2",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono", r.base_price_sen ? "text-ink" : "text-ink-muted")}>
          {r.base_price_sen ? fmtCenti(r.base_price_sen) : "—"}
        </span>
      ),
      getValue: (r) => r.base_price_sen ?? 0,
    },
    {
      key: "price1_sen",
      label: "Price 1",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono", r.price1_sen ? "text-ink" : "text-ink-muted")}>
          {r.price1_sen ? fmtCenti(r.price1_sen) : "—"}
        </span>
      ),
      getValue: (r) => r.price1_sen ?? 0,
    },
    {
      key: "sell_price_sen",
      label: "Selling",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className={cn("font-mono", r.sell_price_sen ? "text-synced" : "text-ink-muted")}>
          {r.sell_price_sen ? fmtCenti(r.sell_price_sen) : "—"}
        </span>
      ),
      getValue: (r) => r.sell_price_sen ?? 0,
    },
    {
      key: "barcode",
      label: "Barcode",
      defaultHidden: true,
      render: (r) => (r.barcode ? <span className="font-mono text-[12px]">{r.barcode}</span> : "—"),
      getValue: (r) => r.barcode || "",
    },
    {
      key: "unit_m3_milli",
      label: "Unit (m³)",
      align: "right",
      defaultHidden: true,
      render: (r) => <span className="font-mono text-ink-secondary">{fmtUnitM3(r.unit_m3_milli)}</span>,
      getValue: (r) => r.unit_m3_milli,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill status={r.status} />,
      getValue: (r) => r.status,
    },
    {
      // Row action — Edit opens a prefilled Panel (no naked inline edit). Not
      // sortable/exportable; pinned so the column chooser can't bury it.
      key: "_edit",
      label: "",
      align: "right",
      alwaysVisible: true,
      render: (r) => (
        <button
          onClick={() => setEditing(r)}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
          title="Edit product"
        >
          <Pencil size={12} />
          Edit
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Products"
        description="Manufacturer SKU master — one row per sellable/purchasable product, with cost (Price 1/2) and selling prices."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => setShowCreate(true)}>
            New Product
          </Button>
        }
      />

      {/* KPI summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi label="Active SKUs" value={stats.distinctSku.toLocaleString("en-MY")} />
        <Kpi label="Priced SKUs" value={stats.priced.toLocaleString("en-MY")} />
        <Kpi
          label="Catalogue"
          value={category === "all" ? "All categories" : (CATEGORIES.find((c) => c.value === category)?.label ?? "—")}
        />
      </div>

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
        tableId="scm_products"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, name, barcode…",
        }}
        emptyLabel="No products match the filters"
        exportName="products"
      />

      {showCreate && (
        <CreateProductPanel
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            list.reload();
          }}
        />
      )}

      {editing && (
        <EditProductPanel
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-1 font-display text-[20px] font-bold tracking-tight text-ink">{value}</div>
    </div>
  );
}

// ── Create ────────────────────────────────────────────────────────────────
// POST /api/scm/mfg-products. Required: code, name, category (must be one of
// VALID_CATEGORIES). Optional: description, baseModel, sizeCode, sizeLabel,
// branding, barcode, basePriceSen, price1Sen, costPriceSen, unitM3Milli.
// Send camelCase — the route maps to snake_case columns. status defaults to
// ACTIVE server-side. Mirrors 2990's NewSkuDrawer.
function CreateProductPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    code: "",
    name: "",
    category: "BEDFRAME",
    description: "",
    baseModel: "",
    sizeLabel: "",
    branding: "",
    barcode: "",
    basePrice: "",
    price1: "",
    costPrice: "",
    unitM3: "",
  });
  const dirty = Object.entries(form).some(
    ([k, v]) => (k === "category" ? v !== "BEDFRAME" : v.trim() !== ""),
  );
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Mattress / service have no Price 1 (cost tier) in the 2990's model — hide it.
  const isMattress = form.category === "MATTRESS";
  const isService = form.category === "SERVICE";
  const isSofa = form.category === "SOFA";

  async function submit() {
    if (!form.code.trim()) {
      toast.error("Code is required");
      return;
    }
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      await api.post(`${SCM}/mfg-products`, {
        code: form.code.trim(),
        name: form.name.trim(),
        category: form.category,
        description: form.description.trim() || undefined,
        baseModel: form.baseModel.trim() || undefined,
        sizeLabel: form.sizeLabel.trim() || undefined,
        branding: form.branding.trim() || undefined,
        barcode: form.barcode.trim() || undefined,
        basePriceSen: rmToSen(form.basePrice),
        price1Sen: isMattress || isService ? null : rmToSen(form.price1),
        costPriceSen: rmToSen(form.costPrice) ?? 0,
        unitM3Milli: rmToMilli(form.unitM3),
      });
      toast.success("Product created");
      onCreated();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(
        msg.includes("duplicate_code")
          ? "That code already exists"
          : msg.includes("invalid_category")
            ? "Invalid category"
            : "Failed to create product",
      );
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
      title="New Product"
      subtitle="Create a manufacturer SKU master record."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Create Product"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Code" required>
          <Input value={form.code} onChange={(v) => set("code", v)} placeholder="e.g. BF-HILTON-Q" />
        </Field>
        <Field label="Name" required>
          <Input value={form.name} onChange={(v) => set("name", v)} placeholder="Product name" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" required>
            <Select value={form.category} onChange={(v) => set("category", v)} options={FORM_CATEGORIES} />
          </Field>
          <Field label="Size Label">
            <Input value={form.sizeLabel} onChange={(v) => set("sizeLabel", v)} placeholder="e.g. Queen" />
          </Field>
        </div>
        {isSofa && (
          <Field label="Base Model">
            <Input value={form.baseModel} onChange={(v) => set("baseModel", v)} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Branding">
            <Input value={form.branding} onChange={(v) => set("branding", v)} placeholder="e.g. Sealy" />
          </Field>
          <Field label="Barcode">
            <Input value={form.barcode} onChange={(v) => set("barcode", v)} placeholder="optional" />
          </Field>
        </div>
        <Field label="Description">
          <Input value={form.description} onChange={(v) => set("description", v)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={isMattress ? "Price (RM)" : "Base / Price 2 (RM)"}>
            <Input value={form.basePrice} onChange={(v) => set("basePrice", v)} type="number" />
          </Field>
          {!isMattress && !isService && (
            <Field label="Price 1 (RM)">
              <Input value={form.price1} onChange={(v) => set("price1", v)} type="number" />
            </Field>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cost Price (RM)">
            <Input value={form.costPrice} onChange={(v) => set("costPrice", v)} type="number" />
          </Field>
          <Field label="Unit (m³)">
            <Input value={form.unitM3} onChange={(v) => set("unitM3", v)} type="number" />
          </Field>
        </div>
      </div>
    </Panel>
  );
}

// ── Edit ────────────────────────────────────────────────────────────────
// PATCH /api/scm/mfg-products/:id. The route accepts a partial body keyed in
// camelCase; only changed fields are written and price changes are audited to
// master_price_history. We send code/name/branding/barcode/status + the cost
// prices (basePriceSen/price1Sen/costPriceSen). Category is NOT patchable on
// this route, so it is shown read-only here. Edit→Save only (no auto-save).
const EDIT_STATUSES = ["ACTIVE", "INACTIVE"];

function EditProductPanel({
  product,
  onClose,
  onSaved,
}: {
  product: MfgProductRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    code: product.code ?? "",
    name: product.name ?? "",
    branding: product.branding ?? "",
    barcode: product.barcode ?? "",
    status: product.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    basePrice: senToRm(product.base_price_sen),
    price1: senToRm(product.price1_sen),
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Mattress / service carry no Price 1 in the 2990's model.
  const hidePrice1 = product.category === "MATTRESS" || product.category === "SERVICE";

  async function submit() {
    if (!form.code.trim()) {
      toast.error("Code is required");
      return;
    }
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      // basePriceSen / price1Sen are sent only when the category exposes the
      // field — sending price1 for a mattress would write a tier it doesn't use.
      await api.patch(`${SCM}/mfg-products/${product.id}`, {
        code: form.code.trim(),
        name: form.name.trim(),
        branding: form.branding.trim() || null,
        barcode: form.barcode.trim() || null,
        status: form.status as "ACTIVE" | "INACTIVE",
        basePriceSen: rmToSen(form.basePrice),
        ...(hidePrice1 ? {} : { price1Sen: rmToSen(form.price1) }),
      });
      toast.success("Product updated");
      onSaved();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(msg.includes("duplicate_code") ? "Another SKU already uses that code" : "Failed to update product");
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
      title={`Edit ${product.code}`}
      subtitle="Update the SKU master record."
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required>
            <Input value={form.code} onChange={(v) => set("code", v)} />
          </Field>
          <Field label="Category">
            {/* Category is not patchable on this route — read-only. */}
            <div className="flex h-10 items-center rounded-md border border-border bg-surface-dim px-3 text-[13px] capitalize text-ink-secondary">
              {product.category.toLowerCase()}
            </div>
          </Field>
        </div>
        <Field label="Name" required>
          <Input value={form.name} onChange={(v) => set("name", v)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Branding">
            <Input value={form.branding} onChange={(v) => set("branding", v)} />
          </Field>
          <Field label="Barcode">
            <Input value={form.barcode} onChange={(v) => set("barcode", v)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={hidePrice1 ? "Price (RM)" : "Base / Price 2 (RM)"}>
            <Input value={form.basePrice} onChange={(v) => set("basePrice", v)} type="number" />
          </Field>
          {!hidePrice1 && (
            <Field label="Price 1 (RM)">
              <Input value={form.price1} onChange={(v) => set("price1", v)} type="number" />
            </Field>
          )}
        </div>
        <Field label="Status">
          <Select value={form.status} onChange={(v) => set("status", v)} options={EDIT_STATUSES} />
        </Field>
      </div>
    </Panel>
  );
}
