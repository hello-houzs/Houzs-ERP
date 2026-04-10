import { useState } from "react";
import {
  Users,
  Truck,
  HardHat,
  AlertTriangle,
  Wrench,
  Plus,
  X,
  Shield,
  Clock,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { DataTable } from "../components/DataTable";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";

type FleetTab = "drivers" | "helpers" | "lorries" | "compliance";

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
  const [tab, setTab] = useLocalStorage<FleetTab>("fleet:tab", "drivers");
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);
  const [selectedLorry, setSelectedLorry] = useState<number | null>(null);

  const tabs: { id: FleetTab; label: string; icon: any }[] = [
    { id: "drivers", label: "Drivers", icon: Users },
    { id: "helpers", label: "Helpers", icon: HardHat },
    { id: "lorries", label: "Lorries", icon: Truck },
    { id: "compliance", label: "Compliance", icon: Shield },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Fleet"
        description="Manage drivers, helpers, and lorries."
      />

      <div className="mb-4 flex items-center gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "relative -mb-px border-b-2 px-4 py-2.5 text-[12px] font-semibold transition-colors",
              tab === t.id
                ? "border-accent text-accent"
                : "border-transparent text-ink-secondary hover:text-ink"
            )}
          >
            <t.icon size={13} className="mr-1.5 inline" />
            {t.label}
          </button>
        ))}
      </div>

      {(tab === "drivers" || tab === "helpers") && (
        <StaffTab
          type={tab === "drivers" ? "driver" : "helper"}
          onSelect={setSelectedStaff}
        />
      )}

      {tab === "lorries" && (
        <LorriesTab onSelect={setSelectedLorry} />
      )}

      {tab === "compliance" && <ComplianceTab />}

      <StaffPanel
        staff={selectedStaff}
        onClose={() => setSelectedStaff(null)}
      />

      <LorryPanel
        lorryId={selectedLorry}
        onClose={() => setSelectedLorry(null)}
      />
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

// ── Staff detail panel ────────────────────────────────────────────

function StaffPanel({
  staff,
  onClose,
}: {
  staff: StaffMember | null;
  onClose: () => void;
}) {
  const detail = useQuery<any>(
    () => (staff ? api.get(`/api/fleet/staff/${staff.id}`) : Promise.resolve(null)),
    [staff?.id]
  );
  const salary = useQuery<any>(
    () => (staff ? api.get(`/api/fleet/salary/${staff.id}`) : Promise.resolve(null)),
    [staff?.id]
  );

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);

  function startEdit() {
    if (!detail.data) return;
    setForm({ ...detail.data });
    setEditing(true);
  }

  async function save() {
    if (!staff) return;
    setBusy(true);
    try {
      await api.patch(`/api/fleet/staff/${staff.id}`, form);
      setEditing(false);
      detail.reload();
    } catch (e: any) {
      alert(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const d = detail.data;
  const s = salary.data;

  return (
    <Panel
      open={!!staff}
      onClose={() => {
        setEditing(false);
        onClose();
      }}
      title={staff?.name || staff?.email || ""}
      subtitle={staff?.user_type === "driver" ? "Driver" : "Helper"}
      width={480}
      footer={
        staff ? (
          <div className="flex items-center gap-2">
            {!editing ? (
              <button
                onClick={startEdit}
                className="rounded-md border border-border bg-surface px-4 py-2 text-[12px] font-semibold text-ink"
              >
                Edit Profile
              </button>
            ) : (
              <>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-md border border-border bg-surface px-4 py-2 text-[12px] font-semibold text-ink"
                >
                  Cancel
                </button>
                <button
                  disabled={busy}
                  onClick={save}
                  className="ml-auto rounded-md bg-accent px-5 py-2.5 text-[12px] font-bold uppercase tracking-wide text-accent-ink disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
        ) : undefined
      }
    >
      {d && !editing && (
        <>
          <PanelSection title="Personal" muted>
            <FieldRow label="Email">{d.email}</FieldRow>
            <FieldRow label="Phone">{d.phone || "—"}</FieldRow>
            <FieldRow label="IC" mono>{d.ic_number || "—"}</FieldRow>
            {d.user_type === "driver" && (
              <>
                <FieldRow label="License" mono>{d.license_no || "—"}</FieldRow>
                <FieldRow label="License Expiry">{formatDate(d.license_expiry)}</FieldRow>
              </>
            )}
          </PanelSection>

          <PanelSection title="Emergency Contact">
            <FieldRow label="Name">{d.emergency_contact_name || "—"}</FieldRow>
            <FieldRow label="Phone">{d.emergency_contact_phone || "—"}</FieldRow>
          </PanelSection>

          <PanelSection title="Salary Structure">
            <FieldRow label="Base Salary" mono>{formatCurrency(d.base_salary)}</FieldRow>
            <FieldRow label="Trip Allowance" mono>{formatCurrency(d.trip_allowance_rate)}</FieldRow>
            <FieldRow label="OT Rate" mono>{formatCurrency(d.ot_rate)}/hr</FieldRow>
          </PanelSection>

          {s && (
            <PanelSection title={`Salary — ${s.period}`}>
              <FieldRow label="Base Pay" mono>{formatCurrency(s.base_pay)}</FieldRow>
              <FieldRow label="Trips">{s.trip_count}</FieldRow>
              <FieldRow label="Trip Allowance" mono>{formatCurrency(s.trip_allowance_total)}</FieldRow>
              <FieldRow label="OT Hours">{s.ot_hours.toFixed(1)}h</FieldRow>
              <FieldRow label="OT Amount" mono>{formatCurrency(s.ot_amount)}</FieldRow>
              <FieldRow label="Gross" mono>
                <span className="font-bold">{formatCurrency(s.gross)}</span>
              </FieldRow>
            </PanelSection>
          )}
        </>
      )}

      {editing && (
        <div className="space-y-3">
          <EditField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <EditField label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
          <EditField label="IC Number" value={form.ic_number} onChange={(v) => setForm({ ...form, ic_number: v })} />
          {form.user_type === "driver" && (
            <>
              <EditField label="License No" value={form.license_no} onChange={(v) => setForm({ ...form, license_no: v })} />
              <EditField label="License Expiry" value={form.license_expiry} onChange={(v) => setForm({ ...form, license_expiry: v })} type="date" />
            </>
          )}
          <EditField label="Emergency Contact Name" value={form.emergency_contact_name} onChange={(v) => setForm({ ...form, emergency_contact_name: v })} />
          <EditField label="Emergency Contact Phone" value={form.emergency_contact_phone} onChange={(v) => setForm({ ...form, emergency_contact_phone: v })} />
          <EditField label="Base Salary" value={form.base_salary} onChange={(v) => setForm({ ...form, base_salary: parseFloat(v) || 0 })} type="number" />
          <EditField label="Trip Allowance" value={form.trip_allowance_rate} onChange={(v) => setForm({ ...form, trip_allowance_rate: parseFloat(v) || 0 })} type="number" />
          <EditField label="OT Rate (per hr)" value={form.ot_rate} onChange={(v) => setForm({ ...form, ot_rate: parseFloat(v) || 0 })} type="number" />
        </div>
      )}
    </Panel>
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

// ── Lorry detail panel ────────────────────────────────────────────

function LorryPanel({
  lorryId,
  onClose,
}: {
  lorryId: number | null;
  onClose: () => void;
}) {
  const [showMaintForm, setShowMaintForm] = useState(false);
  const detail = useQuery<LorryDetail>(
    () => (lorryId ? api.get(`/api/fleet/lorries/${lorryId}`) : Promise.resolve(null as any)),
    [lorryId]
  );

  const [maintBusy, setMaintBusy] = useState(false);
  const [maintForm, setMaintForm] = useState({
    type: "service",
    description: "",
    cost: "",
    maintenance_date: new Date().toISOString().slice(0, 10),
    unavailable_from: "",
    unavailable_to: "",
  });

  async function submitMaint() {
    if (!lorryId) return;
    setMaintBusy(true);
    try {
      await api.post(`/api/fleet/lorries/${lorryId}/maintenance`, {
        ...maintForm,
        cost: parseFloat(maintForm.cost) || 0,
        unavailable_from: maintForm.unavailable_from || null,
        unavailable_to: maintForm.unavailable_to || null,
      });
      setShowMaintForm(false);
      detail.reload();
      setMaintForm({
        type: "service",
        description: "",
        cost: "",
        maintenance_date: new Date().toISOString().slice(0, 10),
        unavailable_from: "",
        unavailable_to: "",
      });
    } catch (e: any) {
      alert(e?.message || "Failed");
    } finally {
      setMaintBusy(false);
    }
  }

  const d = detail.data;

  return (
    <Panel
      open={!!lorryId}
      onClose={onClose}
      title={d?.lorry.plate || ""}
      subtitle={`${d?.lorry.size || ""} · ${d?.lorry.warehouse || ""}`}
      width={520}
    >
      {d && (
        <>
          <PanelSection title="Details" muted>
            <FieldRow label="Model">{d.lorry.model || "—"}</FieldRow>
            <FieldRow label="Type">{d.lorry.is_internal ? "Internal" : "Outsource"}</FieldRow>
            <FieldRow label="Status">{d.lorry.status || "active"}</FieldRow>
            <FieldRow label="Default Driver">{d.lorry.default_driver_name || "—"}</FieldRow>
            <FieldRow label="Purchase Date">{formatDate(d.lorry.purchase_date)}</FieldRow>
            {d.lorry.capacity_m3 && <FieldRow label="Capacity" mono>{d.lorry.capacity_m3} m3</FieldRow>}
          </PanelSection>

          <PanelSection title="Cost vs Revenue">
            <FieldRow label="Total Maintenance Cost" mono>
              <span className="text-err">{formatCurrency(d.total_maintenance_cost)}</span>
            </FieldRow>
            <FieldRow label="Total Revenue" mono>
              <span className="text-ok">{formatCurrency(d.total_revenue)}</span>
            </FieldRow>
            <FieldRow label="Net" mono>
              <span className={cn("font-bold", d.total_revenue - d.total_maintenance_cost >= 0 ? "text-ok" : "text-err")}>
                {formatCurrency(d.total_revenue - d.total_maintenance_cost)}
              </span>
            </FieldRow>
          </PanelSection>

          <PanelSection title="Compliance">
            <FieldRow label="Road Tax">{formatDate(d.lorry.road_tax_expiry) || "—"}</FieldRow>
            <FieldRow label="Insurance">{formatDate(d.lorry.insurance_expiry) || "—"}</FieldRow>
            <FieldRow label="PUSPAKOM">{formatDate(d.lorry.puspakom_expiry) || "—"}</FieldRow>
          </PanelSection>

          <PanelSection title={`Maintenance (${d.maintenance.length})`}>
            <button
              onClick={() => setShowMaintForm(!showMaintForm)}
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-paper py-2 text-[11px] font-semibold text-ink-secondary hover:border-accent/50 hover:text-accent"
            >
              <Plus size={12} /> {showMaintForm ? "Cancel" : "Add Record"}
            </button>

            {showMaintForm && (
              <div className="mb-3 rounded-md border border-accent/30 bg-accent/5 p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <EditField label="Type" value={maintForm.type} onChange={(v) => setMaintForm({ ...maintForm, type: v })} select={["service", "repair", "inspection", "other"]} />
                  <EditField label="Date" value={maintForm.maintenance_date} onChange={(v) => setMaintForm({ ...maintForm, maintenance_date: v })} type="date" />
                  <EditField label="Cost (RM)" value={maintForm.cost} onChange={(v) => setMaintForm({ ...maintForm, cost: v })} type="number" />
                  <EditField label="Unavailable From" value={maintForm.unavailable_from} onChange={(v) => setMaintForm({ ...maintForm, unavailable_from: v })} type="date" />
                  <EditField label="Unavailable To" value={maintForm.unavailable_to} onChange={(v) => setMaintForm({ ...maintForm, unavailable_to: v })} type="date" />
                </div>
                <EditField label="Description" value={maintForm.description} onChange={(v) => setMaintForm({ ...maintForm, description: v })} />
                <div className="flex gap-2">
                  <button onClick={() => setShowMaintForm(false)} className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink">Cancel</button>
                  <button disabled={maintBusy} onClick={submitMaint} className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold text-accent-ink disabled:opacity-50">{maintBusy ? "Saving…" : "Save"}</button>
                </div>
              </div>
            )}

            <div className="space-y-1">
              {d.maintenance.map((m: any) => (
                <div key={m.id} className="flex items-center justify-between rounded-md border border-border bg-paper px-2.5 py-1.5">
                  <div>
                    <div className="text-[11px] font-semibold text-ink">{m.type} — {m.description || "No description"}</div>
                    <div className="text-[10px] text-ink-secondary">{formatDate(m.maintenance_date)}</div>
                  </div>
                  <span className="font-mono text-[11px] text-err">{formatCurrency(m.cost)}</span>
                </div>
              ))}
              {!d.maintenance.length && (
                <div className="text-center text-[11px] text-ink-secondary py-3">No records</div>
              )}
            </div>
          </PanelSection>

          {d.incidents.length > 0 && (
            <PanelSection title={`Incidents (${d.incidents.length})`}>
              <div className="space-y-1">
                {d.incidents.map((inc: any) => (
                  <div key={inc.id} className="rounded-md border border-border bg-paper px-2.5 py-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-ink">{inc.type}</span>
                      <span className="text-[10px] text-ink-secondary">{formatDate(inc.incident_date)}</span>
                    </div>
                    {inc.description && <div className="mt-0.5 text-[11px] text-ink-secondary">{inc.description}</div>}
                    <div className="mt-0.5 flex gap-3 text-[10px]">
                      <span className="font-mono text-err">{formatCurrency(inc.cost_estimate)}</span>
                      <span className="text-ink-secondary">Liability: {inc.liability}</span>
                      <span className="text-ink-secondary">Claim: {inc.claim_status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </PanelSection>
          )}
        </>
      )}
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
      {data.loading && <div className="text-sm text-ink-secondary">Loading…</div>}
      {!data.loading && !expiries.length && (
        <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center">
          <Shield size={28} className="mx-auto mb-3 text-ok" />
          <div className="text-[14px] font-bold text-ink">All clear</div>
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

function EditField({
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
