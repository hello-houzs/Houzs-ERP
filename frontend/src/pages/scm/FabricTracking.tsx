import { useState } from "react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/fabric-tracking — snake_case, verbatim from
// the Hono route (backend/src/scm/routes/fabric-tracking.ts `fabricTracking.get('/')`).
// The handler reads the static `fabric_trackings` table; metric columns (SOH /
// PO outstanding / usage windows / shortage) are whatever was snapshotted at
// seed time (the 2990's fork doesn't yet live-aggregate raw_materials). Money is
// integer *_centi → fmtCenti.
export interface FabricRow {
  id: string;
  fabric_code: string;
  fabric_description: string | null;
  fabric_category: string | null;
  price_tier: string | null;
  sofa_price_tier: string | null;
  bedframe_price_tier: string | null;
  price_centi: number | null;
  soh_centi: number | null;
  po_outstanding_centi: number | null;
  last_month_usage_centi: number | null;
  one_week_usage_centi: number | null;
  two_weeks_usage_centi: number | null;
  one_month_usage_centi: number | null;
  shortage_centi: number | null;
  reorder_point_centi: number | null;
  supplier: string | null;
  supplier_code: string | null;
  lead_time_days: number | null;
  series: string | null;
  is_active: boolean | null;
}

// Category filter — the validated set the backend accepts (VALID_CATEGORIES).
// `all` is the unfiltered view (the backend ignores an unknown category).
const CATEGORIES = [
  { value: "all", label: "All" },
  { value: "B.M-FABR", label: "B.M-FABR" },
  { value: "S-FABR", label: "S-FABR" },
  { value: "S.M-FABR", label: "S.M-FABR" },
  { value: "LINING", label: "Lining" },
  { value: "WEBBING", label: "Webbing" },
] as const;
type Category = (typeof CATEGORIES)[number]["value"];

// Tier labels mirror the 2990's "Price 1 / Price 2 / Price 3" presentation
// (the DB stores PRICE_1 / PRICE_2 / PRICE_3).
function TierPill({ tier }: { tier: string | null }) {
  if (!tier) return <span className="text-ink-muted">—</span>;
  const label = tier.replace("PRICE_", "Price ");
  return (
    <span className="inline-flex items-center rounded border border-border bg-surface-dim px-2 py-0.5 text-[11px] font-semibold text-ink-secondary">
      {label}
    </span>
  );
}

export function ScmFabricTracking() {
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ fabrics: FabricRow[] }>(
    () =>
      api.get(
        `${SCM}/fabric-tracking${buildQuery({
          category: category === "all" ? undefined : category,
          search: search || undefined,
        })}`,
      ),
    [category, search],
  );

  const rows = list.data?.fabrics ?? null;

  const columns: Column<FabricRow>[] = [
    {
      key: "fabric_code",
      label: "Fabric Code",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.fabric_code}</span>,
      getValue: (r) => r.fabric_code,
    },
    {
      key: "fabric_description",
      label: "Description",
      render: (r) => r.fabric_description || "—",
      getValue: (r) => r.fabric_description || "",
    },
    {
      key: "series",
      label: "Series",
      defaultHidden: true,
      render: (r) => r.series || "—",
      getValue: (r) => r.series || "",
    },
    {
      key: "fabric_category",
      label: "Category",
      render: (r) => <span className="text-[12px] text-ink-secondary">{r.fabric_category || "—"}</span>,
      getValue: (r) => r.fabric_category || "",
    },
    {
      key: "supplier_code",
      label: "Supplier Code",
      render: (r) => (r.supplier_code ? <span className="font-mono text-[12px]">{r.supplier_code}</span> : "—"),
      getValue: (r) => r.supplier_code || "",
    },
    {
      key: "sofa_price_tier",
      label: "Sofa Tier",
      align: "center",
      render: (r) => <TierPill tier={r.sofa_price_tier} />,
      getValue: (r) => r.sofa_price_tier || "",
    },
    {
      key: "bedframe_price_tier",
      label: "Bedframe Tier",
      align: "center",
      render: (r) => <TierPill tier={r.bedframe_price_tier} />,
      getValue: (r) => r.bedframe_price_tier || "",
    },
    {
      key: "price_centi",
      label: "Price",
      align: "right",
      defaultHidden: true,
      render: (r) => <span className="font-mono">{r.price_centi ? fmtCenti(r.price_centi) : "—"}</span>,
      getValue: (r) => r.price_centi ?? 0,
    },
    {
      key: "soh_centi",
      label: "SOH",
      align: "right",
      defaultHidden: true,
      render: (r) => <span className="font-mono">{r.soh_centi ? fmtCenti(r.soh_centi) : "—"}</span>,
      getValue: (r) => r.soh_centi ?? 0,
    },
    {
      key: "po_outstanding_centi",
      label: "PO Outstanding",
      align: "right",
      defaultHidden: true,
      render: (r) => <span className="font-mono">{r.po_outstanding_centi ? fmtCenti(r.po_outstanding_centi) : "—"}</span>,
      getValue: (r) => r.po_outstanding_centi ?? 0,
    },
    {
      key: "shortage_centi",
      label: "Shortage",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className={cn("font-mono", (r.shortage_centi ?? 0) > 0 ? "text-err" : "text-ink-muted")}>
          {r.shortage_centi ? fmtCenti(r.shortage_centi) : "—"}
        </span>
      ),
      getValue: (r) => r.shortage_centi ?? 0,
    },
    {
      key: "lead_time_days",
      label: "Lead (d)",
      align: "right",
      defaultHidden: true,
      render: (r) => r.lead_time_days ?? "—",
      getValue: (r) => r.lead_time_days ?? 0,
    },
    {
      key: "is_active",
      label: "Active",
      align: "center",
      render: (r) =>
        r.is_active === false ? (
          <span className="rounded bg-surface-dim px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-muted">Inactive</span>
        ) : (
          <span className="rounded bg-synced/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-synced">Active</span>
        ),
      getValue: (r) => (r.is_active === false ? 0 : 1),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Fabric Tracking"
        description="Fabric cost ledger — sofa / bedframe price tiers, supplier codes, and snapshotted stock metrics."
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
        tableId="scm_fabric_tracking"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, description…",
        }}
        emptyLabel="No fabrics match the filters"
        exportName="fabric-tracking"
      />
    </div>
  );
}
