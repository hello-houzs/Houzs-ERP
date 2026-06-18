import { useMemo, useState } from "react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

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

// Unit volume is stored as integer m³ × 1000 (unit_m3_milli) — show 3 dp.
function fmtUnitM3(milli: number): string {
  return (milli / 1000).toFixed(3);
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
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Products"
        description="Manufacturer SKU master — one row per sellable/purchasable product, with cost (Price 1/2) and selling prices."
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
