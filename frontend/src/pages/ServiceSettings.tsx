import { useState } from "react";
import { Wrench } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";

interface ServiceSettingsResponse {
  default_assignee_id: number | null;
  default_assignee_name: string | null;
  default_assignee_email: string | null;
}

interface UserOption {
  id: number;
  name: string | null;
  email: string;
}

/**
 * Service-module configuration. Currently exposes the default case
 * assignee; kept extensible so we can add more service-side toggles
 * later without scattering them across the global Settings page.
 *
 * Mounted as a sub-view of /assr (Quality Management → Service
 * Settings sidebar entry).
 */
export function ServiceSettingsView() {
  const toast = useToast();
  const settings = useQuery<ServiceSettingsResponse>(() =>
    api.get("/api/assr/settings")
  );
  const users = useQuery<{ users: UserOption[] }>(() => api.get("/api/users"));
  const [saving, setSaving] = useState(false);

  async function setDefault(idStr: string) {
    setSaving(true);
    try {
      const id = idStr ? parseInt(idStr, 10) : null;
      await api.put("/api/assr/settings", {
        default_assignee_id: idStr ? id : null,
      });
      settings.reload();
      toast.success(idStr ? "Default assignee updated" : "Default assignee cleared");
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  const currentId = settings.data?.default_assignee_id ?? "";

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Service"
        title="Service Settings"
        description="Defaults applied to new service cases — auto-assignment, etc."
      />

      <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
        <h2 className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
          <Wrench size={12} /> Default Case Assignee
        </h2>

        <p className="mb-4 max-w-xl text-[12.5px] leading-relaxed text-ink-secondary">
          New service cases will be automatically assigned to this person on
          creation. Change at any time — existing cases keep whoever they were
          assigned to.
        </p>

        {settings.loading && (
          <div className="text-[12px] text-ink-muted">Loading…</div>
        )}

        {settings.data && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="block flex-1 min-w-[260px]">
              <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                Assigned to
              </span>
              <select
                value={currentId}
                onChange={(e) => setDefault(e.target.value)}
                disabled={saving || users.loading}
                className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-bg disabled:text-ink-muted"
              >
                <option value="">— No default (cases stay unassigned) —</option>
                {(users.data?.users ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email}
                  </option>
                ))}
              </select>
            </label>
            {settings.data.default_assignee_name && (
              <div className="rounded-md border border-accent/30 bg-accent-soft/40 px-3 py-2 text-[11.5px]">
                <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-accent">
                  Currently
                </div>
                <div className="font-semibold text-ink">
                  {settings.data.default_assignee_name}
                </div>
                {settings.data.default_assignee_email && (
                  <div className="text-[10.5px] text-ink-muted">
                    {settings.data.default_assignee_email}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
