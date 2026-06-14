import { useNavigate } from "react-router-dom";
import { Shield } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { DataTable } from "../components/DataTable";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";

type FleetTab = "drivers" | "helpers" | "lorries" | "compliance";

const FLEET_TABS: readonly FleetTab[] = [
  "drivers",
  "helpers",
  "lorries",
  "compliance",
];

// `?sub=` (not `?tab=`): the Logistics outer wrapper owns `?tab=` to
// pick between Trips and Fleet. Reusing `tab` here used to crash this
// page (TAB_HEADER["fleet"] === undefined → blank screen).
const FLEET_TAB_KEYS = ["sub"] as const;

// ── Types ─────────────────────────────────────────────────────────

interface StaffMember {
  id: number;
  email: string;
  name: string | null;
  phone: string | null;
  status: string;
  user_type: string;
  ic_number: string | null;
  license_no: string | null;
  license_expiry: string | null;
  base_salary: number;
  trip_allowance_rate: number;
  ot_rate: number;
  role_name: string;
  created_at: string;
}

interface LorryRow {
  id: number;
  plate: string;
  size: string | null;
  model: string | null;
  warehouse: string;
  is_internal: number;
  status: string | null;
  capacity_m3: number | null;
  capacity_kg: number | null;
  road_tax_expiry: string | null;
  insurance_expiry: string | null;
  puspakom_expiry: string | null;
  default_driver_name: string | null;
  purchase_date: string | null;
}

interface LorryDetail {
  lorry: LorryRow;
  maintenance: any[];
  compliance: any[];
  incidents: any[];
  total_maintenance_cost: number;
  total_revenue: number;
}

// ── Main page ─────────────────────────────────────────────────────

export function Fleet() {
  const [params, setParams] = useStickyFilters("fleet", FLEET_TAB_KEYS);
  const rawSub = params.get("sub");
  const tab: FleetTab = (FLEET_TABS as readonly string[]).includes(rawSub ?? "")
    ? (rawSub as FleetTab)
    : "drivers";
  const setTab = (v: FleetTab) => {
    const next = new URLSearchParams(params);
    if (v === "drivers") next.delete("sub");
    else next.set("sub", v);
    setParams(next, { replace: true });
  };
  const navigate = useNavigate();

  const tabs: TabOption<FleetTab>[] = [
    { value: "drivers", label: "Drivers" },
    { value: "helpers", label: "Helpers" },
    { value: "lorries", label: "Lorries" },
    { value: "compliance", label: "Compliance" },
  ];

  const TAB_HEADER: Record<FleetTab, { title: string; description: string }> = {
    drivers: {
      title: "Drivers",
      description: "Roster, licences, salaries, and clock-in activity.",
    },
    helpers: {
      title: "Helpers",
      description: "Helper roster — contact info, salaries, assignments.",
    },
    lorries: {
      title: "Lorries",
      description: "Vehicles, capacity, road tax / insurance / Puspakom status.",
    },
    compliance: {
      title: "Compliance",
      description: "Upcoming expiries and inspections across drivers and lorries.",
    },
  };

  return (
    <div>
      <TabStrip<FleetTab> value={tab} onChange={setTab} options={tabs} />

      <PageHeader
        eyebrow="Operations · Fleet"
        title={TAB_HEADER[tab].title}
        description={TAB_HEADER[tab].description}
      />


      {(tab === "drivers" || tab === "helpers") && (
        <StaffTab
          type={tab === "drivers" ? "driver" : "helper"}
          onSelect={(s) => navigate(`/staff/${s.id}`)}
        />
      )}

      {tab === "lorries" && (
        <LorriesTab onSelect={(id) => navigate(`/lorries/${id}`)} />
      )}

      {tab === "compliance" && <ComplianceTab />}
    </div>
  );
}

// ── Staff tab (drivers / helpers) ─────────────────────────────────

function StaffTab({
  type,
  onSelect,
}: {
  type: "driver" | "helper";
  onSelect: (s: StaffMember) => void;
}) {
  const list = useQuery<{ data: StaffMember[] }>(() => api.get("/api/fleet/staff"));
  const roleName = type === "driver" ? "Driver" : "Helper";
  const filtered = (list.data?.data ?? []).filter((s) => s.role_name === roleName);

  return (
    <DataTable
      tableId={`fleet-${type}`}
      columns={[
        {
          key: "name",
          label: "Name",
          render: (r: StaffMember) => (
            <span className="font-semibold">{r.name || r.email}</span>
          ),
        },
        { key: "phone", label: "Phone", render: (r: StaffMember) => r.phone || "—" },
        {
          key: "license_no",
          label: type === "driver" ? "License" : "IC",
          render: (r: StaffMember) => (
            <span className="font-mono text-[11px]">
              {(type === "driver" ? r.license_no : r.ic_number) || "—"}
            </span>
          ),
        },
        ...(type === "driver"
          ? [
              {
                key: "license_expiry",
                label: "License Expiry",
                render: (r: StaffMember) => {
                  if (!r.license_expiry) return "—";
                  const isExpiring =
                    r.license_expiry <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
                  return (
                    <span className={isExpiring ? "font-semibold text-err" : ""}>
                      {formatDate(r.license_expiry)}
                    </span>
                  );
                },
              },
            ]
          : []),
        {
          key: "base_salary",
          label: "Base Salary",
          render: (r: StaffMember) => (
            <span className="font-mono">{formatCurrency(r.base_salary)}</span>
          ),
        },
        {
          key: "trip_allowance_rate",
          label: "Trip Allow.",
          render: (r: StaffMember) => (
            <span className="font-mono">{formatCurrency(r.trip_allowance_rate)}</span>
          ),
        },
        {
          key: "status",
          label: "Status",
          render: (r: StaffMember) => (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                r.status === "active" && "bg-ok/10 text-ok",
                r.status !== "active" && "bg-ink/10 text-ink-secondary"
              )}
            >
              {r.status}
            </span>
          ),
        },
      ]}
      rows={filtered}
      loading={list.loading}
      error={list.error}
      emptyLabel={`No ${type}s found`}
      getRowKey={(r: StaffMember) => r.id}
      onRowClick={onSelect}
    />
  );
}


// ── Lorries tab ───────────────────────────────────────────────────

function LorriesTab({
  onSelect,
}: {
  onSelect: (id: number) => void;
}) {
  const list = useQuery<{ data: LorryRow[] }>(() => api.get("/api/lorries"));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <DataTable
      tableId="fleet-lorries"
      columns={[
        {
          key: "plate",
          label: "Plate",
          render: (r: LorryRow) => <span className="font-mono font-bold">{r.plate}</span>,
        },
        { key: "size", label: "Size", render: (r: LorryRow) => r.size || "—" },
        { key: "model", label: "Model", render: (r: LorryRow) => r.model || "—" },
        { key: "warehouse", label: "Warehouse", render: (r: LorryRow) => r.warehouse },
        {
          key: "is_internal",
          label: "Type",
          render: (r: LorryRow) => (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                r.is_internal ? "bg-accent/10 text-accent" : "bg-warning-bg text-warning-text"
              )}
            >
              {r.is_internal ? "Internal" : "Outsource"}
            </span>
          ),
        },
        {
          key: "default_driver_name",
          label: "Default Driver",
          render: (r: LorryRow) => r.default_driver_name || "—",
        },
        {
          key: "status",
          label: "Status",
          render: (r: LorryRow) => (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                r.status === "active" && "bg-ok/10 text-ok",
                r.status === "maintenance" && "bg-warning-bg text-warning-text",
                r.status === "retired" && "bg-ink/10 text-ink-secondary"
              )}
            >
              {r.status || "active"}
            </span>
          ),
        },
        {
          key: "expiry",
          label: "Nearest Expiry",
          render: (r: LorryRow) => {
            const dates = [r.road_tax_expiry, r.insurance_expiry, r.puspakom_expiry].filter(Boolean) as string[];
            if (!dates.length) return "—";
            const nearest = dates.sort()[0];
            const isExpired = nearest < today;
            const isWarning = nearest <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
            return (
              <span className={cn(isExpired ? "font-bold text-err" : isWarning ? "text-warning-text" : "")}>
                {formatDate(nearest)}
              </span>
            );
          },
        },
      ]}
      rows={list.data?.data ?? null}
      loading={list.loading}
      error={list.error}
      emptyLabel="No lorries"
      getRowKey={(r: LorryRow) => r.id}
      onRowClick={(r: LorryRow) => onSelect(r.id)}
    />
  );
}


// ── Compliance tab ────────────────────────────────────────────────

function ComplianceTab() {
  const data = useQuery<{ compliance_docs: any[]; lorry_expiries: any[] }>(
    () => api.get("/api/fleet/compliance/expiring?days=60")
  );

  const expiries = data.data?.lorry_expiries ?? [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="mb-3 text-[11px] text-ink-secondary">
        Lorries with compliance documents expiring within 60 days.
      </div>
      {data.loading && <div className="text-[12px] text-ink-secondary">Loading…</div>}
      {!data.loading && !expiries.length && (
        <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center">
          <Shield size={28} className="mx-auto mb-3 text-ok" />
          <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">All clear</div>
          <div className="mt-1 text-[12px] text-ink-secondary">No compliance items expiring soon.</div>
        </div>
      )}
      <div className="space-y-2">
        {expiries.map((l: any) => {
          const items: { label: string; date: string }[] = [];
          if (l.road_tax_expiry && l.road_tax_expiry <= new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10))
            items.push({ label: "Road Tax", date: l.road_tax_expiry });
          if (l.insurance_expiry && l.insurance_expiry <= new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10))
            items.push({ label: "Insurance", date: l.insurance_expiry });
          if (l.puspakom_expiry && l.puspakom_expiry <= new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10))
            items.push({ label: "PUSPAKOM", date: l.puspakom_expiry });

          return (
            <div key={l.id} className="rounded-xl border border-border bg-surface p-3">
              <div className="font-mono text-[13px] font-bold text-ink">{l.plate}</div>
              <div className="mt-1 space-y-1">
                {items.map((item) => (
                  <div key={item.label} className="flex items-center justify-between text-[11px]">
                    <span className="text-ink-secondary">{item.label}</span>
                    <span className={cn("font-mono font-semibold", item.date < today ? "text-err" : "text-warning-text")}>
                      {formatDate(item.date)}
                      {item.date < today && " (EXPIRED)"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared edit field ─────────────────────────────────────────────

export function EditField({
  label,
  value,
  onChange,
  type = "text",
  select,
}: {
  label: string;
  value: any;
  onChange: (v: string) => void;
  type?: string;
  select?: string[];
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
        {label}
      </span>
      {select ? (
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
        >
          {select.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
        />
      )}
    </label>
  );
}
