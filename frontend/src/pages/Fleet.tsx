import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Panel } from "../components/Panel";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../auth/AuthContext";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";

type FleetTab = "drivers" | "helpers" | "storekeepers" | "lorries" | "compliance";

const FLEET_TABS: readonly FleetTab[] = [
  "drivers",
  "helpers",
  "storekeepers",
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
    { value: "storekeepers", label: "Storekeepers" },
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
    storekeepers: {
      title: "Storekeepers",
      description: "Storekeeper roster — contact info, salaries, assignments.",
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


      {(tab === "drivers" || tab === "helpers" || tab === "storekeepers") && (
        <StaffTab
          type={tab === "drivers" ? "driver" : tab === "helpers" ? "helper" : "storekeeper"}
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
  type: "driver" | "helper" | "storekeeper";
  onSelect: (s: StaffMember) => void;
}) {
  const list = useQuery<{ data: StaffMember[] }>(() => api.get("/api/fleet/staff"));
  const roleName =
    type === "driver" ? "Driver" : type === "helper" ? "Helper" : "Storekeeper";
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
          label: type === "driver" ? "License" : "IC / Passport",
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
  const { can } = useAuth();
  const toast = useToast();
  const list = useQuery<{ data: LorryRow[] }>(() => api.get("/api/lorries"));
  const today = new Date().toISOString().slice(0, 10);
  const [showAdd, setShowAdd] = useState(false);
  const canManage = can("fleet.manage");

  async function handleDelete(r: LorryRow, e: React.MouseEvent) {
    e.stopPropagation();
    if (
      !window.confirm(
        `Delete lorry "${r.plate}"? It will be removed from the fleet list and the project crew dropdown.`
      )
    )
      return;
    try {
      await api.del(`/api/lorries/${r.id}`);
      toast.success(`Deleted ${r.plate}`);
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Delete failed");
    }
  }

  return (
    <div>
      {canManage && (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[11px] font-semibold uppercase tracking-wider text-white transition-colors hover:bg-accent-hover"
          >
            <Plus size={14} /> Add lorry
          </button>
        </div>
      )}
      {showAdd && (
        <AddLorryPanel
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            list.reload();
          }}
        />
      )}
      <DataTable
      tableId="fleet-lorries"
      columns={[
        {
          key: "plate",
          label: "Plate",
          render: (r: LorryRow) => <span className="font-mono font-bold">{r.plate}</span>,
        },
        { key: "size", label: "Size", render: (r: LorryRow) => r.size || "—" },
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
        ...(canManage
          ? [
              {
                key: "actions",
                label: "",
                render: (r: LorryRow) => (
                  <button
                    type="button"
                    onClick={(e) => handleDelete(r, e)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                    title={`Delete ${r.plate}`}
                  >
                    <Trash2 size={14} />
                  </button>
                ),
              },
            ]
          : []),
      ]}
      rows={list.data?.data ?? null}
      loading={list.loading}
      error={list.error}
      emptyLabel="No lorries"
      getRowKey={(r: LorryRow) => r.id}
      onRowClick={(r: LorryRow) => onSelect(r.id)}
    />
    </div>
  );
}

// ── Add lorry panel ───────────────────────────────────────────────

function AddLorryPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const warehousesQ = useQuery<{ data: { code: string; name: string }[] }>(
    () => api.get("/api/warehouses")
  );
  const [plate, setPlate] = useState("");
  const [size, setSize] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [isInternal, setIsInternal] = useState(true);
  const [busy, setBusy] = useState(false);

  const warehouses = warehousesQ.data?.data ?? [];

  async function save() {
    if (!plate.trim()) {
      toast.error("Plate is required");
      return;
    }
    if (!warehouse) {
      toast.error("Pick a warehouse");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/lorries", {
        plate: plate.trim(),
        size: size.trim() || undefined,
        warehouse,
        is_internal: isInternal,
      });
      toast.success("Lorry added");
      onCreated();
    } catch (e: any) {
      toast.error(e?.message || "Could not add lorry");
    } finally {
      setBusy(false);
    }
  }

  const fieldClass =
    "w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15";
  const labelClass =
    "mb-1 block font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted";

  return (
    <Panel
      open
      onClose={onClose}
      title="Add lorry"
      subtitle="New fleet vehicle"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink-secondary hover:bg-bg/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-[12px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? "Saving…" : "Add lorry"}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelClass}>Plate *</label>
          <input
            className={fieldClass}
            value={plate}
            onChange={(e) => setPlate(e.target.value)}
            placeholder="e.g. KL-17C"
            autoFocus
          />
        </div>
        <div>
          <label className={labelClass}>Size</label>
          <input
            className={fieldClass}
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="e.g. 17ft"
          />
        </div>
        <div>
          <label className={labelClass}>Warehouse *</label>
          <select
            className={fieldClass}
            value={warehouse}
            onChange={(e) => setWarehouse(e.target.value)}
          >
            <option value="">Select warehouse…</option>
            {warehouses.map((w) => (
              <option key={w.code} value={w.code}>
                {w.name} ({w.code})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <div className="flex gap-2">
            {[
              { v: true, label: "Internal" },
              { v: false, label: "Outsource" },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setIsInternal(opt.v)}
                className={cn(
                  "flex-1 rounded-md border px-3 py-2 text-[12px] font-semibold transition-colors",
                  isInternal === opt.v
                    ? "border-accent bg-accent-soft/50 text-accent"
                    : "border-border bg-surface text-ink-secondary hover:bg-bg/50"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Panel>
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
        <EmptyState
          icon={<Shield size={28} className="text-ok" />}
          message="All clear"
          description="No compliance items expiring soon."
        />
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
