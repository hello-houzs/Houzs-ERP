import { useState } from "react";
import { Wrench } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { LookupManager } from "../components/LookupManager";
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
 * Service Maintenance — admin home for the QMS module. Mirrors the
 * Project Maintenance pattern: pickers, defaults, and rate cards
 * consolidated under one page so config doesn't scatter.
 *
 * Mounted as a sub-view of /assr (Quality Management → Service
 * Maintenance sidebar entry). Surfaces:
 *   - Default case assignee
 *   - Issue Categories (mig 065 lookup)
 *   - Resolution Methods (mig 065 lookup)
 *   - Priorities (mig 065 lookup, with optional SLA hours)
 *   - NCR Categories (mig 065 lookup)
 */
export function ServiceSettingsView() {
  return (
    <div>
      <PageHeader
        eyebrow="Operations · Service"
        title="Service Maintenance"
        description="Module defaults plus all the picker lists that drive the case form — issue categories, resolution methods, priorities, NCR categories. Edit here once, every dropdown updates."
      />

      <DefaultAssigneeSection />

      {/* Two-up grid on wide screens, single column on narrow. Same
          packing pattern as Project Maintenance keeps the page tight. */}
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <LookupManager
          apiPath="/api/assr/lookups/issue-categories"
          title="Issue Categories"
          description="Free-form list of complaint types (e.g. fabric tear, frame defect). Used in the case form's Issue Category dropdown."
        />
        <LookupManager
          apiPath="/api/assr/lookups/resolution-methods"
          title="Resolution Methods"
          description="How the case was resolved — replace, repair, on-site service, etc. Stored on each case as the slug; renaming is safe."
        />
        <LookupManager
          apiPath="/api/assr/lookups/priorities"
          title="Priorities"
          description="Drives the priority dot + auto-computed SLA deadline on each case. The SLA Hours column overrides the default per-priority SLA window."
          extra={{ key: "sla_hours", addLabel: "SLA hrs", rowTitle: "SLA window in hours; blank = use module default", placeholder: "—" }}
        />
        <LookupManager
          apiPath="/api/assr/lookups/ncr-categories"
          title="NCR Categories"
          description="Quality root-cause classifications used on closed cases for the NCR / Pareto report."
        />
      </div>
    </div>
  );
}

// ── Default assignee ────────────────────────────────────────────

function DefaultAssigneeSection() {
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
  );
}
