import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/mrp — snake_case-free here: the backend
// (backend/src/scm/routes/mrp.ts `computeMrp`) returns a CAMELCASE JSON body
// (the route serialises its in-memory MrpResult straight to c.json, so the
// field names are exactly the TS property names — NOT the DB snake_case). This
// is a pure calculator: per (warehouse + SKU + variant) it reconciles open
// Sales-Order demand (qtyNeeded) against supply (stock + outstanding PO), with
// the leftover = shortage. No persistence — recomputed on every GET.
interface MrpSupplier {
  supplierId: string;
  code: string;
  name: string;
  isMain: boolean;
}

interface MrpSku {
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  variantKey: string;
  variantLabel: string | null;
  description: string | null;
  category: string | null;
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  suppliers: MrpSupplier[];
  lines: Array<{
    soItemId: string;
    soDocNo: string;
    deliveryDate: string | null;
    orderByDate: string | null;
    qty: number;
    source: "stock" | "po" | "shortage";
    shortageQty: number;
  }>;
}

// Sofa is computed as colour-matched SETS (one per SO line), not pooled into the
// SKU rollup, so it arrives in its own array. We fold each set into the same
// row shape so the Sofa tab shows alongside the others.
interface SofaSet {
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  soItemId: string;
  soDocNo: string;
  itemCode: string;
  description: string | null;
  variantLabel: string | null;
  colour: string | null;
  qty: number;
  orderedQty: number;
  shortageQty: number;
  orderByDate: string | null;
  deliveryDate: string | null;
  mainSupplierName?: string | null;
  suppliers: MrpSupplier[];
}

interface Warehouse {
  id: string;
  code: string;
  name: string;
}

interface MrpResult {
  asOf: string;
  categories: string[];
  warehouses: Warehouse[];
  skus: MrpSku[];
  sofaSets: SofaSet[];
  totals: {
    skuCount: number;
    shortageSkuCount: number;
    shortageUnits: number;
    sofaSetCount: number;
    sofaSetShortageCount: number;
  };
}

// One flat row per planning line — a SKU+variant+warehouse bucket, or a single
// sofa set. Unified so both feed the same DataTable.
interface PlanRow {
  key: string;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  description: string | null;
  variantLabel: string | null;
  category: string | null;
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  supplierName: string | null;
  earliestOrderBy: string | null;
}

// Four orderable category tabs (Service is not a stock item — excluded, same as
// 2990's). "all" unions every category.
const CATEGORY_TABS = [
  { value: "all", label: "All" },
  { value: "SOFA", label: "Sofa" },
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "ACCESSORY", label: "Accessory" },
] as const;
type CategoryTab = (typeof CATEGORY_TABS)[number]["value"];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "err" }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div
        className={cn(
          "mt-1 font-display text-[22px] font-bold tracking-tight",
          tone === "err" ? "text-err" : "text-ink",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// Earliest order-by date across a SKU's shortage lines — "place the PO by this
// date" (delivery date − category lead days). Drives the at-a-glance urgency.
function earliestOrderByOf(lines: MrpSku["lines"]): string | null {
  return lines.reduce<string | null>(
    (min, l) => (l.orderByDate && (!min || l.orderByDate < min) ? l.orderByDate : min),
    null,
  );
}

export function ScmMrp() {
  const navigate = useNavigate();
  const [category, setCategory] = useState<CategoryTab>("all");
  const [warehouseId, setWarehouseId] = useState<string>("all");
  const [onlyShort, setOnlyShort] = useState(false);
  const [search, setSearch] = useState("");

  // The backend filters by category server-side, but we keep the tab on the
  // client too so "all" can union sofa sets + SKUs without a second request.
  const q = useQuery<MrpResult>(
    () =>
      api.get(
        `${SCM}/mrp${buildQuery({
          category: category === "all" ? undefined : category,
          warehouseId: warehouseId === "all" ? undefined : warehouseId,
        })}`,
      ),
    [category, warehouseId],
  );

  const data = q.data;
  const warehouses = data?.warehouses ?? [];

  // Flatten skus[] (non-sofa rollup) + sofaSets[] into one row list. Sofa sets
  // are per-SO-line; non-sofa rows are per (warehouse + SKU + variant) buckets.
  const rows: PlanRow[] | null = useMemo(() => {
    if (!data) return null;
    const out: PlanRow[] = [];
    for (const s of data.skus) {
      out.push({
        key: `sku|${s.warehouseId ?? "NOWH"}|${s.itemCode}|${s.variantKey}`,
        warehouseCode: s.warehouseCode,
        warehouseName: s.warehouseName,
        itemCode: s.itemCode,
        description: s.description,
        variantLabel: s.variantLabel,
        category: s.category,
        qtyNeeded: s.qtyNeeded,
        stock: s.stock,
        poOutstanding: s.poOutstanding,
        shortage: s.shortage,
        supplierName: s.mainSupplierName ?? s.suppliers.find((x) => x.isMain)?.name ?? null,
        earliestOrderBy: earliestOrderByOf(s.lines),
      });
    }
    for (const set of data.sofaSets) {
      out.push({
        key: `sofa|${set.warehouseId ?? "NOWH"}|${set.soItemId}`,
        warehouseCode: set.warehouseCode,
        warehouseName: set.warehouseName,
        itemCode: set.itemCode,
        // Surface which SO the set belongs to — a sofa is one PO per SO.
        description: set.description ? `${set.description} · ${set.soDocNo}` : set.soDocNo,
        variantLabel: set.variantLabel ?? set.colour,
        category: "SOFA",
        qtyNeeded: set.qty,
        // A sofa set has no SKU-level stock rollup; orderedQty is units already
        // covered by pooled stock+PO, so stock+PO outstanding collapse into it.
        stock: 0,
        poOutstanding: set.orderedQty,
        shortage: set.shortageQty,
        supplierName:
          set.mainSupplierName ?? set.suppliers.find((x) => x.isMain)?.name ?? null,
        earliestOrderBy: set.orderByDate,
      });
    }
    return out;
  }, [data]);

  // Client-side category union for the "all" tab (server already scoped the
  // others). When a specific tab is active the server only returns that
  // category's skus, but sofaSets always come back — drop them off non-sofa tabs.
  const filtered = useMemo(() => {
    if (!rows) return null;
    let r = rows;
    if (category !== "all") r = r.filter((x) => (x.category ?? "").toUpperCase() === category);
    if (onlyShort) r = r.filter((x) => x.shortage > 0);
    return r;
  }, [rows, category, onlyShort]);

  const stats = useMemo(() => {
    const r = filtered ?? [];
    return {
      skuCount: r.length,
      shortageCount: r.filter((x) => x.shortage > 0).length,
      shortageUnits: r.reduce((s, x) => s + (x.shortage > 0 ? x.shortage : 0), 0),
      demandUnits: r.reduce((s, x) => s + (x.qtyNeeded ?? 0), 0),
    };
  }, [filtered]);

  const columns: Column<PlanRow>[] = [
    {
      key: "warehouse",
      label: "WH",
      render: (r) =>
        r.warehouseCode ? (
          <span
            className="inline-flex items-center rounded border border-border bg-surface-dim px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary"
            title={r.warehouseName ?? undefined}
          >
            {r.warehouseCode}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
      getValue: (r) => r.warehouseCode ?? "",
    },
    {
      key: "itemCode",
      label: "Item Code",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.itemCode}</span>,
      getValue: (r) => r.itemCode,
    },
    {
      key: "description",
      label: "Description",
      render: (r) => (
        <span className="text-ink">
          {r.description || "—"}
          {r.variantLabel && <span className="text-ink-muted"> · {r.variantLabel}</span>}
        </span>
      ),
      getValue: (r) => r.description ?? "",
    },
    {
      key: "category",
      label: "Category",
      defaultHidden: true,
      render: (r) => (
        <span className="text-[12px] capitalize text-ink-secondary">{(r.category ?? "—").toLowerCase()}</span>
      ),
      getValue: (r) => r.category ?? "",
    },
    {
      key: "qtyNeeded",
      label: "Qty Needed",
      align: "right",
      render: (r) => <span className="font-mono text-ink">{r.qtyNeeded.toLocaleString("en-MY")}</span>,
      getValue: (r) => r.qtyNeeded,
    },
    {
      key: "stock",
      label: "Stock",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono", r.stock > 0 ? "text-ink" : "text-ink-muted")}>
          {r.stock.toLocaleString("en-MY")}
        </span>
      ),
      getValue: (r) => r.stock,
    },
    {
      key: "poOutstanding",
      label: "PO Outstanding",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono", r.poOutstanding > 0 ? "text-synced" : "text-ink-muted")}>
          {r.poOutstanding > 0 ? `+${r.poOutstanding.toLocaleString("en-MY")}` : "—"}
        </span>
      ),
      getValue: (r) => r.poOutstanding,
    },
    {
      key: "shortage",
      label: "Shortage",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono font-semibold", r.shortage > 0 ? "text-err" : "text-ink-muted")}>
          {r.shortage > 0 ? r.shortage.toLocaleString("en-MY") : "—"}
        </span>
      ),
      getValue: (r) => r.shortage,
    },
    {
      key: "orderBy",
      label: "Order By",
      align: "right",
      render: (r) => (
        <span className={cn("text-[12px]", r.shortage > 0 && r.earliestOrderBy ? "text-err" : "text-ink-secondary")}>
          {fmtDate(r.earliestOrderBy)}
        </span>
      ),
      // No order-by date sorts last (ascending = most-urgent first).
      getValue: (r) => r.earliestOrderBy ?? "9999-12-31",
    },
    {
      key: "supplier",
      label: "Main Supplier",
      render: (r) => r.supplierName || <span className="text-ink-muted">— none —</span>,
      getValue: (r) => r.supplierName ?? "",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="MRP · Stock Status"
        description="Open Sales-Order demand vs supply (stock + outstanding PO), per warehouse + SKU + variant. Shortfalls are what to order next. Read-only — recomputed live."
      />

      {/* KPI summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Planning Rows" value={stats.skuCount.toLocaleString("en-MY")} />
        <Kpi label="Demand Units" value={stats.demandUnits.toLocaleString("en-MY")} />
        <Kpi label="Short SKUs" value={stats.shortageCount.toLocaleString("en-MY")} tone={stats.shortageCount > 0 ? "err" : undefined} />
        <Kpi label="Shortage Units" value={stats.shortageUnits.toLocaleString("en-MY")} tone={stats.shortageUnits > 0 ? "err" : undefined} />
      </div>

      {/* Category tabs + warehouse + only-shortages filters */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {CATEGORY_TABS.map((c) => (
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="h-9 w-52 rounded-md border border-border bg-surface px-3 text-[12px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="all">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary">
            <input
              type="checkbox"
              checked={onlyShort}
              onChange={(e) => setOnlyShort(e.target.checked)}
              className="accent-accent"
            />
            Only shortages
          </label>
        </div>
      </div>

      <DataTable
        tableId="scm_mrp"
        columns={columns}
        rows={filtered}
        loading={q.loading}
        error={q.error}
        getRowKey={(r) => r.key}
        getRowClassName={(r) => (r.shortage > 0 ? "bg-err/5" : undefined)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, description…",
        }}
        emptyLabel={
          onlyShort
            ? "Nothing needs ordering — everything in view is covered."
            : "No open Sales-Order demand for this filter."
        }
        exportName="mrp-stock-status"
      />

      <div className="mt-4 flex items-center justify-between text-[11px] text-ink-muted">
        <span>
          {data?.asOf ? `Computed ${new Date(data.asOf).toLocaleString("en-MY")}` : ""}
        </span>
        <button
          type="button"
          onClick={() => navigate("/scm/mrp-lead-times")}
          className="font-semibold text-accent hover:underline"
        >
          Lead Times →
        </button>
      </div>
    </div>
  );
}
