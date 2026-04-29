import { useState } from "react";
import { useParams, Navigate } from "react-router-dom";
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
import { formatCurrency, formatDate } from "../lib/utils";
import { EditField } from "./Fleet";

/**
 * Dedicated detail page for a driver / helper. Mounted at /staff/:id.
 * Linked from Fleet.tsx → Drivers / Helpers tabs.
 */
export function StaffDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;
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
  const tabKind = d?.user_type === "driver" ? "Drivers" : "Helpers";
  const subKey = d?.user_type === "driver" ? "drivers" : "helpers";

  const actions = !d ? null : !editing ? (
    <HeaderButton variant="ghost" onClick={startEdit}>
      Edit Profile
    </HeaderButton>
  ) : (
    <>
      <HeaderButton variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </HeaderButton>
      <HeaderButton variant="primary" onClick={save} disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </HeaderButton>
    </>
  );

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Logistics", to: "/logistics" },
        { label: "Fleet", to: "/logistics?tab=fleet" },
        { label: tabKind, to: `/logistics?tab=fleet&sub=${subKey}` },
        { label: d?.name || d?.email || `#${id}` },
      ]}
      eyebrow={d?.user_type === "driver" ? "Driver" : "Helper"}
      title={d?.name || d?.email || "Loading…"}
      description={d?.email}
      backTo="/logistics?tab=fleet"
      loading={detail.loading && !d}
      actions={actions}
    >
      {d && (
        <>
          {s && (
            <StatStrip
              items={[
                {
                  label: `Period · ${s.period}`,
                  value: formatCurrency(s.gross),
                  hint: "Gross",
                  tone: "ok",
                },
                { label: "Trips", value: s.trip_count.toLocaleString() },
                {
                  label: "OT Hours",
                  value: `${s.ot_hours.toFixed(1)}h`,
                },
                {
                  label: "OT Amount",
                  value: formatCurrency(s.ot_amount),
                },
              ]}
            />
          )}

          <div className="mt-5">
            <DetailGrid>
              <DetailMain>
                {!editing ? (
                  <>
                    <Section title="Personal">
                      <DefinitionList
                        items={[
                          { label: "Email", value: d.email },
                          { label: "Phone", value: d.phone, mono: true },
                          { label: "IC", value: d.ic_number, mono: true },
                          ...(d.user_type === "driver"
                            ? [
                                {
                                  label: "License",
                                  value: d.license_no,
                                  mono: true,
                                },
                                {
                                  label: "License Expiry",
                                  value: formatDate(d.license_expiry),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </Section>

                    <Section title="Emergency Contact">
                      <DefinitionList
                        items={[
                          {
                            label: "Name",
                            value: d.emergency_contact_name,
                          },
                          {
                            label: "Phone",
                            value: d.emergency_contact_phone,
                            mono: true,
                          },
                        ]}
                      />
                    </Section>

                    {s && (
                      <Section title={`Salary breakdown · ${s.period}`}>
                        <DefinitionList
                          items={[
                            {
                              label: "Base Pay",
                              value: formatCurrency(s.base_pay),
                              mono: true,
                            },
                            {
                              label: "Trips",
                              value: s.trip_count,
                            },
                            {
                              label: "Trip Allowance",
                              value: formatCurrency(s.trip_allowance_total),
                              mono: true,
                            },
                            {
                              label: "OT Hours",
                              value: `${s.ot_hours.toFixed(1)}h`,
                              mono: true,
                            },
                            {
                              label: "OT Amount",
                              value: formatCurrency(s.ot_amount),
                              mono: true,
                            },
                            {
                              label: "Gross",
                              value: (
                                <span className="font-bold text-ink">
                                  {formatCurrency(s.gross)}
                                </span>
                              ),
                              mono: true,
                            },
                          ]}
                        />
                      </Section>
                    )}
                  </>
                ) : (
                  <Section title="Edit Profile">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <EditField
                        label="Name"
                        value={form.name}
                        onChange={(v) => setForm({ ...form, name: v })}
                      />
                      <EditField
                        label="Phone"
                        value={form.phone}
                        onChange={(v) => setForm({ ...form, phone: v })}
                      />
                      <EditField
                        label="IC Number"
                        value={form.ic_number}
                        onChange={(v) => setForm({ ...form, ic_number: v })}
                      />
                      {form.user_type === "driver" && (
                        <>
                          <EditField
                            label="License No"
                            value={form.license_no}
                            onChange={(v) =>
                              setForm({ ...form, license_no: v })
                            }
                          />
                          <EditField
                            label="License Expiry"
                            value={form.license_expiry}
                            onChange={(v) =>
                              setForm({ ...form, license_expiry: v })
                            }
                            type="date"
                          />
                        </>
                      )}
                      <EditField
                        label="Emergency Contact"
                        value={form.emergency_contact_name}
                        onChange={(v) =>
                          setForm({ ...form, emergency_contact_name: v })
                        }
                      />
                      <EditField
                        label="Emergency Phone"
                        value={form.emergency_contact_phone}
                        onChange={(v) =>
                          setForm({ ...form, emergency_contact_phone: v })
                        }
                      />
                      <EditField
                        label="Base Salary"
                        value={form.base_salary}
                        onChange={(v) =>
                          setForm({
                            ...form,
                            base_salary: parseFloat(v) || 0,
                          })
                        }
                        type="number"
                      />
                      <EditField
                        label="Trip Allowance"
                        value={form.trip_allowance_rate}
                        onChange={(v) =>
                          setForm({
                            ...form,
                            trip_allowance_rate: parseFloat(v) || 0,
                          })
                        }
                        type="number"
                      />
                      <EditField
                        label="OT Rate (per hr)"
                        value={form.ot_rate}
                        onChange={(v) =>
                          setForm({ ...form, ot_rate: parseFloat(v) || 0 })
                        }
                        type="number"
                      />
                    </div>
                  </Section>
                )}
              </DetailMain>

              <DetailAside>
                <Section title="Salary structure">
                  <DefinitionList
                    items={[
                      {
                        label: "Base",
                        value: formatCurrency(d.base_salary),
                        mono: true,
                      },
                      {
                        label: "Trip Allow.",
                        value: formatCurrency(d.trip_allowance_rate),
                        mono: true,
                      },
                      {
                        label: "OT / hr",
                        value: formatCurrency(d.ot_rate),
                        mono: true,
                      },
                    ]}
                  />
                </Section>

                <Section title="Status">
                  <DefinitionList
                    items={[
                      { label: "Role", value: d.role_name },
                      {
                        label: "Account",
                        value: d.status,
                      },
                      {
                        label: "Joined",
                        value: formatDate(d.created_at),
                      },
                    ]}
                  />
                </Section>
              </DetailAside>
            </DetailGrid>
          </div>
        </>
      )}
    </DetailLayout>
  );
}
