import { useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { Plus } from "lucide-react";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
  StatStrip,
  DefinitionList,
  HeaderButton,
} from "../components/DetailLayout";
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
  const net = d ? d.total_revenue - d.total_maintenance_cost : 0;

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Logistics", to: "/logistics" },
        { label: "Fleet", to: "/logistics?tab=fleet" },
        { label: "Lorries", to: "/logistics?tab=fleet&sub=lorries" },
        { label: d?.lorry.plate || `#${id}` },
      ]}
      eyebrow={`Lorry · ${d?.lorry.plate || `#${id}`}`}
      title={d ? `${d.lorry.size || "Lorry"} · ${d.lorry.warehouse}` : "Loading…"}
      description={
        d ? `${d.lorry.is_internal ? "Internal" : "Outsource"}${d.lorry.model ? ` · ${d.lorry.model}` : ""}${d.lorry.default_driver_name ? ` · ${d.lorry.default_driver_name}` : ""}` : undefined
      }
      backTo="/logistics?tab=fleet"
      loading={detail.loading && !d}
    >
      {d && (
        <>
          <StatStrip
            items={[
              {
                label: "Total Revenue",
                value: formatCurrency(d.total_revenue, { compact: true }),
                tone: "ok",
              },
              {
                label: "Maintenance",
                value: formatCurrency(d.total_maintenance_cost, { compact: true }),
                tone: "err",
              },
              {
                label: "Net",
                value: formatCurrency(net, { compact: true }),
                tone: net >= 0 ? "ok" : "err",
              },
              {
                label: "Status",
                value: d.lorry.status || "active",
              },
            ]}
          />

          <div className="mt-5">
            <DetailGrid>
              <DetailMain>
                <Section
                  title={`Maintenance · ${d.maintenance.length}`}
                  actions={
                    <HeaderButton
                      variant={showMaintForm ? "ghost" : "primary"}
                      onClick={() => setShowMaintForm(!showMaintForm)}
                    >
                      <Plus size={11} /> {showMaintForm ? "Cancel" : "Add"}
                    </HeaderButton>
                  }
                >
                  {showMaintForm && (
                    <div className="mb-3 rounded-md border border-accent/30 bg-accent-soft/40 p-3">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <EditField
                          label="Type"
                          value={maintForm.type}
                          onChange={(v) =>
                            setMaintForm({ ...maintForm, type: v })
                          }
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
                          onChange={(v) =>
                            setMaintForm({ ...maintForm, cost: v })
                          }
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
                      <div className="mt-2">
                        <EditField
                          label="Description"
                          value={maintForm.description}
                          onChange={(v) =>
                            setMaintForm({ ...maintForm, description: v })
                          }
                        />
                      </div>
                      <div className="mt-3 flex justify-end gap-2">
                        <HeaderButton
                          variant="ghost"
                          onClick={() => setShowMaintForm(false)}
                        >
                          Cancel
                        </HeaderButton>
                        <HeaderButton
                          variant="primary"
                          onClick={submitMaint}
                          disabled={maintBusy}
                        >
                          {maintBusy ? "Saving…" : "Save"}
                        </HeaderButton>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    {d.maintenance.map((m: any) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between rounded-md border border-border bg-bg/40 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-[12px] font-semibold text-ink">
                            <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
                              {m.type}
                            </span>
                            <span className="ml-2 text-ink-secondary">
                              {m.description || "No description"}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[10.5px] text-ink-muted">
                            {formatDate(m.maintenance_date)}
                          </div>
                        </div>
                        <span className="font-mono text-[12px] font-semibold text-err">
                          {formatCurrency(m.cost)}
                        </span>
                      </div>
                    ))}
                    {!d.maintenance.length && (
                      <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-6 text-center text-[11.5px] text-ink-muted">
                        No maintenance records yet.
                      </div>
                    )}
                  </div>
                </Section>

                {d.incidents.length > 0 && (
                  <Section title={`Incidents · ${d.incidents.length}`}>
                    <div className="space-y-1.5">
                      {d.incidents.map((inc: any) => (
                        <div
                          key={inc.id}
                          className="rounded-md border border-border bg-bg/40 px-3 py-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-accent">
                              {inc.type}
                            </span>
                            <span className="text-[10.5px] text-ink-muted">
                              {formatDate(inc.incident_date)}
                            </span>
                          </div>
                          {inc.description && (
                            <div className="mt-1 text-[12px] text-ink-secondary">
                              {inc.description}
                            </div>
                          )}
                          <div className="mt-1.5 flex flex-wrap gap-3 text-[10.5px]">
                            <span className="font-mono text-err">
                              {formatCurrency(inc.cost_estimate)}
                            </span>
                            <span className="text-ink-muted">
                              Liability: {inc.liability}
                            </span>
                            <span className="text-ink-muted">
                              Claim: {inc.claim_status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}
              </DetailMain>

              <DetailAside>
                <Section title="Details">
                  <DefinitionList
                    items={[
                      { label: "Plate", value: d.lorry.plate, mono: true },
                      { label: "Model", value: d.lorry.model || "—" },
                      {
                        label: "Type",
                        value: d.lorry.is_internal ? "Internal" : "Outsource",
                      },
                      { label: "Status", value: d.lorry.status || "active" },
                      {
                        label: "Default Driver",
                        value: d.lorry.default_driver_name || "—",
                      },
                      {
                        label: "Purchase Date",
                        value: formatDate(d.lorry.purchase_date),
                      },
                      {
                        label: "Capacity",
                        value: d.lorry.capacity_m3
                          ? `${d.lorry.capacity_m3} m³`
                          : null,
                        mono: true,
                      },
                    ]}
                  />
                </Section>

                <Section title="Compliance">
                  <ComplianceRow label="Road Tax" date={d.lorry.road_tax_expiry} />
                  <ComplianceRow label="Insurance" date={d.lorry.insurance_expiry} />
                  <ComplianceRow label="PUSPAKOM" date={d.lorry.puspakom_expiry} />
                </Section>
              </DetailAside>
            </DetailGrid>
          </div>
        </>
      )}
    </DetailLayout>
  );
}

function ComplianceRow({
  label,
  date,
}: {
  label: string;
  date: string | null;
}) {
  if (!date) {
    return (
      <div className="flex items-baseline justify-between border-b border-border-subtle/60 py-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          {label}
        </span>
        <span className="text-[12px] text-ink-muted">—</span>
      </div>
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const inThirty = new Date(Date.now() + 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  const expired = date < today;
  const warn = !expired && date <= inThirty;
  return (
    <div className="flex items-baseline justify-between border-b border-border-subtle/60 py-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[12px]",
          expired
            ? "font-bold text-err"
            : warn
            ? "text-warning-text"
            : "text-ink"
        )}
      >
        {formatDate(date)}
        {expired && <span className="ml-1 text-[10px] uppercase">expired</span>}
      </span>
    </div>
  );
}
