import { useMemo, useState } from "react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/inventory/products — snake_case, verbatim
// from the Hono route (backend/src/scm/routes/inventory.ts `inventory.get('/products')`).
// The handler reads the `v_inventory_product_totals` view (one row per SKU, qty
// summed across all warehouses + main supplier) then enriches each row with the
// live stock picture (reserve / available / incoming / oldest-lot age). Money is
// integer *_sen → fmtCenti. Columns mirror 2990's Inventory "Balances" grid.
export interface InventoryProductRow {
  product_code: string;
  product_name: string;
  category: string | null;
  size_label: string | null;
  branding: string | null;
  total_qty: number;
  total_value_sen: number;
  last_movement_at: string | null;
  main_supplier_code: string | null;
  main_supplier_name: string | null;
  // Server-enriched live stock picture.
  reserve_7d: number;
  reserve_14d: number;
  reserved_total: number;
  available_qty: number;
  incoming_qty: number;
  oldest_lot_at: string | null;
}

// 2990's category set (item_group). `all` is the unfiltered view.
const CATEGORIES = [
  { value: "all", label: "All" },
  { value: "ACCESSORY", label: "Accessory" },
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "SOFA", label: "Sofa" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "SERVICE", label: "Service" },
] as const;
type Category = (typeof CATEGORIES)[number]["value"];

// Age of stock — days since the oldest open FIFO lot was received.
function fmtAgeDays(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const d = Math.floor(ms / 86_400_000);
  return d === 0 ? "today" : `${d}d`;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-1 font-display text-[22px] font-bold tracking-tight text-ink">{value}</div>
    </div>
  );
}

export function ScmInventory() {
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ products: InventoryProductRow[] }>(
    () =>
      api.get(
        `${SCM}/inventory/products${buildQuery({
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
      totalQty: r.reduce((s, x) => s + (x.total_qty ?? 0), 0),
      totalValueSen: r.reduce((s, x) => s + (x.total_value_sen ?? 0), 0),
    };
  }, [rows]);

  const columns: Column<InventoryProductRow>[] = [
    {
      key: "product_code",
      label: "Product Code",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.product_code}</span>,
      getValue: (r) => r.product_code,
    },
    {
      key: "product_name",
      label: "Description",
      render: (r) => (
        <span className="text-ink">
          {r.product_name}
          {r.branding && <span className="text-ink-muted"> · {r.branding}</span>}
        </span>
      ),
      getValue: (r) => r.product_name,
    },
    {
      key: "category",
      label: "Category",
      render: (r) => <span className="text-[12px] capitalize text-ink-secondary">{(r.category ?? "—").toLowerCase()}</span>,
      getValue: (r) => r.category ?? "",
    },
    {
      key: "main_supplier",
      label: "Main Supplier",
      defaultHidden: true,
      render: (r) => r.main_supplier_name || r.main_supplier_code || "—",
      getValue: (r) => r.main_supplier_name || r.main_supplier_code || "",
    },
    {
      key: "total_qty",
      label: "Stock",
      align: "right",
      render: (r) => (
        <span
          className={cn(
            "font-mono",
            r.total_qty > 0 ? "text-ink" : r.total_qty < 0 ? "text-err" : "text-ink-muted",
          )}
        >
          {r.total_qty.toLocaleString("en-MY")}
        </span>
      ),
      getValue: (r) => r.total_qty,
    },
    {
      key: "incoming_qty",
      label: "Incoming",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono", r.incoming_qty > 0 ? "text-synced" : "text-ink-muted")}>
          {r.incoming_qty > 0 ? `+${r.incoming_qty.toLocaleString("en-MY")}` : "—"}
        </span>
      ),
      getValue: (r) => r.incoming_qty,
    },
    {
      key: "reserve_7d",
      label: "Reserve 7d",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className={cn("font-mono", r.reserve_7d > 0 ? "text-ink" : "text-ink-muted")}>
          {r.reserve_7d > 0 ? r.reserve_7d.toLocaleString("en-MY") : "—"}
        </span>
      ),
      getValue: (r) => r.reserve_7d,
    },
    {
      key: "reserve_14d",
      label: "Reserve 14d",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className={cn("font-mono", r.reserve_14d > 0 ? "text-ink" : "text-ink-muted")}>
          {r.reserve_14d > 0 ? r.reserve_14d.toLocaleString("en-MY") : "—"}
        </span>
      ),
      getValue: (r) => r.reserve_14d,
    },
    {
      key: "available_qty",
      label: "Available",
      align: "right",
      render: (r) => (
        <span
          className={cn(
            "font-mono",
            r.available_qty < 0 ? "text-err" : r.available_qty > 0 ? "text-synced" : "text-ink-muted",
          )}
          title="Stock minus reserved (open SO demand)"
        >
          {r.available_qty.toLocaleString("en-MY")}
        </span>
      ),
      getValue: (r) => r.available_qty,
    },
    {
      key: "total_value_sen",
      label: "Value",
      align: "right",
      render: (r) => (
        <span className="font-mono">{r.total_value_sen > 0 ? fmtCenti(r.total_value_sen) : "—"}</span>
      ),
      getValue: (r) => r.total_value_sen,
    },
    {
      key: "unit_cost",
      label: "Unit Cost",
      align: "right",
      defaultHidden: true,
      render: (r) => {
        const has = r.total_qty > 0 && r.total_value_sen > 0;
        return <span className="font-mono">{has ? fmtCenti(Math.round(r.total_value_sen / r.total_qty)) : "—"}</span>;
      },
      getValue: (r) => (r.total_qty > 0 && r.total_value_sen > 0 ? r.total_value_sen / r.total_qty : 0),
    },
    {
      key: "age",
      label: "Age",
      align: "right",
      render: (r) => <span className="text-ink-secondary" title={r.oldest_lot_at ?? undefined}>{fmtAgeDays(r.oldest_lot_at)}</span>,
      // Oldest lot first when ascending — no lots sorts last.
      getValue: (r) => r.oldest_lot_at ?? "9999-12-31",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Inventory"
        description="Stock balances — one row per SKU, qty summed across all warehouses with FIFO valuation."
      />

      {/* KPI summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi label="Distinct SKUs" value={stats.distinctSku.toLocaleString("en-MY")} />
        <Kpi label="Total Qty" value={stats.totalQty.toLocaleString("en-MY")} />
        <Kpi label="Inventory Value" value={fmtCenti(stats.totalValueSen)} />
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
        tableId="scm_inventory"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.product_code}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, description…",
        }}
        emptyLabel="No SKUs match the filters"
        exportName="inventory"
      />
    </div>
  );
}
