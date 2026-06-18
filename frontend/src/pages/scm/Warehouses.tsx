import { useState } from "react";
import { Star } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/inventory/warehouses — snake_case, verbatim
// from the Hono route (backend/src/scm/routes/inventory.ts `inventory.get('/warehouses')`).
// This is the warehouse MASTER (physical stock locations), the same picker the
// Inventory/GRN/DO flows bind against. The /api/scm/warehouse route (singular) is
// a separate rack/bin layer, not this list.
export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  location: string | null;
  is_active: boolean;
  is_default: boolean;
}

function StatusPill({ active }: { active: boolean }) {
  const status = active ? "ACTIVE" : "INACTIVE";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

export function ScmWarehouses() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState("");

  const list = useQuery<{ warehouses: WarehouseRow[] }>(
    () =>
      api.get(
        `${SCM}/inventory/warehouses${buildQuery({
          includeInactive: includeInactive ? "true" : undefined,
        })}`,
      ),
    [includeInactive],
  );

  // The warehouses endpoint has no server-side text search — filter loaded rows.
  const all = list.data?.warehouses ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((w) =>
          [w.code, w.name, w.location].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<WarehouseRow>[] = [
    {
      key: "code",
      label: "Code",
      render: (w) => <span className="font-mono text-[12px] font-semibold text-ink">{w.code}</span>,
      getValue: (w) => w.code,
    },
    {
      key: "name",
      label: "Name",
      render: (w) => <span className="font-medium text-ink">{w.name}</span>,
      getValue: (w) => w.name,
    },
    {
      key: "location",
      label: "Location",
      render: (w) => w.location || "—",
      getValue: (w) => w.location || "",
    },
    {
      key: "is_default",
      label: "Default",
      align: "center",
      render: (w) =>
        w.is_default ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent">
            <Star size={12} className="fill-accent" />
            Default
          </span>
        ) : (
          "—"
        ),
      getValue: (w) => (w.is_default ? 1 : 0),
    },
    {
      key: "status",
      label: "Status",
      render: (w) => <StatusPill active={w.is_active} />,
      getValue: (w) => (w.is_active ? "Active" : "Inactive"),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Warehouses"
        description="Physical stock locations — the warehouse master that inventory, GRN, and DO bind against."
      />

      {/* Include-inactive filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {[
          { value: false, label: "Active only" },
          { value: true, label: "Include inactive" },
        ].map((opt) => (
          <button
            key={String(opt.value)}
            onClick={() => setIncludeInactive(opt.value)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold transition-colors",
              includeInactive === opt.value
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_warehouses"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(w) => w.id}
        getRowClassName={(w) => (w.is_active ? undefined : "opacity-60")}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, name, location…",
        }}
        emptyLabel="No warehouses found"
        exportName="warehouses"
      />
    </div>
  );
}
