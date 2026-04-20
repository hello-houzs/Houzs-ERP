import { useState } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { PageHeader } from "../components/Layout";
import { PanelSection, FieldRow } from "../components/Panel";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatCurrency, formatDate } from "../lib/utils";
import { EditField } from "./Fleet";

/**
 * Dedicated detail page for a driver / helper. Mounted at /staff/:id.
 * Linked from Fleet.tsx → Drivers / Helpers tabs.
 */
export function StaffDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;
  const navigate = useNavigate();
  const toast = useToast();

  const detail = useQuery<any>(() => api.get(`/api/fleet/staff/${id}`), [id]);
  const salary = useQuery<any>(() => api.get(`/api/fleet/salary/${id}`), [id]);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);

  if (isNaN(id)) return <Navigate to="/logistics?tab=fleet" replace />;

  function startEdit() {
    if (!detail.data) return;
    setForm({ ...detail.data });
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/fleet/staff/${id}`, form);
      setEditing(false);
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const d = detail.data;
  const s = salary.data;
  const tabKind = d?.user_type === "driver" ? "drivers" : "helpers";

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "Logistics", to: "/logistics" },
          { label: "Fleet", to: `/logistics?tab=fleet` },
          { label: d?.user_type === "driver" ? "Drivers" : "Helpers", to: `/logistics?tab=fleet` },
          { label: d?.name || d?.email || `#${id}` },
        ]}
      />
      <PageHeader
        eyebrow={d?.user_type === "driver" ? "Driver" : "Helper"}
        title={d?.name || d?.email || "Loading…"}
        description={d?.email}
        actions={
          <>
            <button
              onClick={() => navigate(`/logistics?tab=fleet&sub=${tabKind}`)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
            >
              <ArrowLeft size={13} /> Back
            </button>
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
                  className="rounded-md bg-accent px-5 py-2.5 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </>
        }
      />

      {detail.loading && <div className="text-[12px] text-ink-muted">Loading…</div>}

      {d && !editing && (
        <div className="space-y-6">
          <PanelSection title="Personal">
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
        </div>
      )}

      {d && editing && (
        <div className="max-w-2xl space-y-3">
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
    </div>
  );
}
