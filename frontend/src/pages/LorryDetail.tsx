import { useState } from "react";
import { useNavigate, useParams, Navigate } from "react-router-dom";
import { ArrowLeft, Plus } from "lucide-react";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { PageHeader } from "../components/Layout";
import { PanelSection, FieldRow } from "../components/Panel";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import { EditField } from "./Fleet";

interface LorryDetailData {
  lorry: {
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
  };
  maintenance: any[];
  compliance: any[];
  incidents: any[];
  total_maintenance_cost: number;
  total_revenue: number;
}

/**
 * Dedicated detail page for a lorry. Mounted at /lorries/:id.
 * Linked from Fleet.tsx → Lorries tab.
 */
export function LorryDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;
  const navigate = useNavigate();
  const toast = useToast();

  const detail = useQuery<LorryDetailData>(
    () => api.get(`/api/fleet/lorries/${id}`),
    [id]
  );

  const [showMaintForm, setShowMaintForm] = useState(false);
  const [maintBusy, setMaintBusy] = useState(false);
  const [maintForm, setMaintForm] = useState({
    type: "service",
    description: "",
    cost: "",
    maintenance_date: new Date().toISOString().slice(0, 10),
    unavailable_from: "",
    unavailable_to: "",
  });

  if (isNaN(id)) return <Navigate to="/logistics?tab=fleet" replace />;

  async function submitMaint() {
    setMaintBusy(true);
    try {
      await api.post(`/api/fleet/lorries/${id}/maintenance`, {
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
      toast.error(e?.message || "Failed");
    } finally {
      setMaintBusy(false);
    }
  }

  const d = detail.data;

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "Logistics", to: "/logistics" },
          { label: "Fleet", to: `/logistics?tab=fleet` },
          { label: "Lorries", to: `/logistics?tab=fleet&sub=lorries` },
          { label: d?.lorry.plate || `#${id}` },
        ]}
      />
      <PageHeader
        eyebrow={`Lorry · ${d?.lorry.plate || `#${id}`}`}
        title={d ? `${d.lorry.size || "Lorry"} · ${d.lorry.warehouse}` : "Loading…"}
        description={d?.lorry.model || undefined}
        actions={
          <button
            onClick={() => navigate(`/logistics?tab=fleet&sub=lorries`)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
          >
            <ArrowLeft size={13} /> Back
          </button>
        }
      />

      {detail.loading && <div className="text-[12px] text-ink-muted">Loading…</div>}

      {d && (
        <div className="space-y-6">
          <PanelSection title="Details">
            <FieldRow label="Model">{d.lorry.model || "—"}</FieldRow>
            <FieldRow label="Type">{d.lorry.is_internal ? "Internal" : "Outsource"}</FieldRow>
            <FieldRow label="Status">{d.lorry.status || "active"}</FieldRow>
            <FieldRow label="Default Driver">{d.lorry.default_driver_name || "—"}</FieldRow>
            <FieldRow label="Purchase Date">{formatDate(d.lorry.purchase_date)}</FieldRow>
            {d.lorry.capacity_m3 && (
              <FieldRow label="Capacity" mono>
                {d.lorry.capacity_m3} m3
              </FieldRow>
            )}
          </PanelSection>

          <PanelSection title="Cost vs Revenue">
            <FieldRow label="Total Maintenance Cost" mono>
              <span className="text-err">{formatCurrency(d.total_maintenance_cost)}</span>
            </FieldRow>
            <FieldRow label="Total Revenue" mono>
              <span className="text-ok">{formatCurrency(d.total_revenue)}</span>
            </FieldRow>
            <FieldRow label="Net" mono>
              <span
                className={cn(
                  "font-bold",
                  d.total_revenue - d.total_maintenance_cost >= 0
                    ? "text-ok"
                    : "text-err"
                )}
              >
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
                  <EditField
                    label="Type"
                    value={maintForm.type}
                    onChange={(v) => setMaintForm({ ...maintForm, type: v })}
                    select={["service", "repair", "inspection", "other"]}
                  />
                  <EditField
                    label="Date"
                    value={maintForm.maintenance_date}
                    onChange={(v) =>
                      setMaintForm({ ...maintForm, maintenance_date: v })
                    }
                    type="date"
                  />
                  <EditField
                    label="Cost (RM)"
                    value={maintForm.cost}
                    onChange={(v) => setMaintForm({ ...maintForm, cost: v })}
                    type="number"
                  />
                  <EditField
                    label="Unavailable From"
                    value={maintForm.unavailable_from}
                    onChange={(v) =>
                      setMaintForm({ ...maintForm, unavailable_from: v })
                    }
                    type="date"
                  />
                  <EditField
                    label="Unavailable To"
                    value={maintForm.unavailable_to}
                    onChange={(v) =>
                      setMaintForm({ ...maintForm, unavailable_to: v })
                    }
                    type="date"
                  />
                </div>
                <EditField
                  label="Description"
                  value={maintForm.description}
                  onChange={(v) => setMaintForm({ ...maintForm, description: v })}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowMaintForm(false)}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={maintBusy}
                    onClick={submitMaint}
                    className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                  >
                    {maintBusy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-1">
              {d.maintenance.map((m: any) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-md border border-border bg-paper px-2.5 py-1.5"
                >
                  <div>
                    <div className="text-[11px] font-semibold text-ink">
                      {m.type} — {m.description || "No description"}
                    </div>
                    <div className="text-[10px] text-ink-secondary">
                      {formatDate(m.maintenance_date)}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-err">
                    {formatCurrency(m.cost)}
                  </span>
                </div>
              ))}
              {!d.maintenance.length && (
                <div className="text-center text-[11px] text-ink-secondary py-3">
                  No records
                </div>
              )}
            </div>
          </PanelSection>

          {d.incidents.length > 0 && (
            <PanelSection title={`Incidents (${d.incidents.length})`}>
              <div className="space-y-1">
                {d.incidents.map((inc: any) => (
                  <div
                    key={inc.id}
                    className="rounded-md border border-border bg-paper px-2.5 py-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-ink">
                        {inc.type}
                      </span>
                      <span className="text-[10px] text-ink-secondary">
                        {formatDate(inc.incident_date)}
                      </span>
                    </div>
                    {inc.description && (
                      <div className="mt-0.5 text-[11px] text-ink-secondary">
                        {inc.description}
                      </div>
                    )}
                    <div className="mt-0.5 flex gap-3 text-[10px]">
                      <span className="font-mono text-err">
                        {formatCurrency(inc.cost_estimate)}
                      </span>
                      <span className="text-ink-secondary">
                        Liability: {inc.liability}
                      </span>
                      <span className="text-ink-secondary">
                        Claim: {inc.claim_status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </PanelSection>
          )}
        </div>
      )}
    </div>
  );
}
