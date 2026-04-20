import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Database, Mail, Send, Wrench } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { relativeTime } from "../lib/utils";
import type { SyncStatusResponse, Paginated, ExecutionLog } from "../types";

type SettingsTab =
  | "connection"
  | "sync"
  | "email"
  | "service"
  | "projects"
  | "logs";

/**
 * Settings page — split into four tabs so each section owns its own
 * surface instead of stacking as a long scroll. Connection and Sync
 * share the `/api/sync/status` fetch, hoisted to the wrapper so both
 * tabs see the same state. Email and Activity Log are self-contained.
 */
export function Settings() {
  const [params, setParams] = useSearchParams();

  const raw = params.get("tab") as SettingsTab | null;
  const active: SettingsTab =
    raw && ["connection", "sync", "email", "service", "projects", "logs"].includes(raw)
      ? raw
      : "connection";

  function setTab(next: SettingsTab) {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p, { replace: true });
  }

  const status = useQuery<SyncStatusResponse>(() => api.get("/api/sync/status"));

  const tabs: TabOption<SettingsTab>[] = [
    { value: "connection", label: "Connection" },
    { value: "sync", label: "Sync" },
    { value: "email", label: "Email" },
    { value: "service", label: "Service" },
    { value: "projects", label: "Projects" },
    { value: "logs", label: "Activity Log" },
  ];

  const TAB_HEADER: Record<
    SettingsTab,
    { title: string; description: string }
  > = {
    connection: {
      title: "Connection",
      description: "Verify the Worker can reach the AutoCount middleware.",
    },
    sync: {
      title: "Sync",
      description: "Cron status, error retry, and manual full refresh.",
    },
    email: {
      title: "Email Notifications",
      description: "Resend integration and per-channel toggles.",
    },
    service: {
      title: "Service Cases",
      description: "Defaults applied to new ASSR cases — auto-assignment, etc.",
    },
    projects: {
      title: "Projects",
      description:
        "Picker lists (organizers, venues) and the default checklist cloned into every new project.",
    },
    logs: {
      title: "Activity Log",
      description: "Execution history across every sync and scheduled job.",
    },
  };

  return (
    <div className="max-w-4xl">
      <TabStrip<SettingsTab>
        value={active}
        onChange={setTab}
        options={tabs}
      />

      <PageHeader
        eyebrow="System · Configuration"
        title={TAB_HEADER[active].title}
        description={TAB_HEADER[active].description}
      />

      {active === "connection" && <ConnectionTab />}
      {active === "sync" && (
        <SyncTab status={status.data} onReload={() => status.reload()} />
      )}
      {active === "email" && <EmailTab />}
      {active === "service" && <ServiceTab />}
      {active === "projects" && <ProjectsTab />}
      {active === "logs" && <ActivityLog />}
    </div>
  );
}

// ── Connection tab ───────────────────────────────────────────

function ConnectionTab() {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [connectionOk, setConnectionOk] = useState<boolean | null>(null);

  async function testConnection() {
    setTesting(true);
    try {
      await fetch(`${api.baseUrl}/health`);
      setConnectionOk(true);
      toast.success("Connection OK");
    } catch (e: any) {
      setConnectionOk(false);
      toast.error(`Connection failed: ${e?.message || e}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-ink-muted">API URL</span>
          <span className="font-mono text-xs">{api.baseUrl || "(not set)"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-ink-muted">Status</span>
          {connectionOk === null ? (
            <span className="text-xs text-ink-muted">Not tested</span>
          ) : connectionOk ? (
            <StatusDot variant="synced" label="Connected" />
          ) : (
            <StatusDot variant="error" label="Disconnected" />
          )}
        </div>
        <div className="pt-2">
          <Button variant="secondary" onClick={testConnection} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ── Sync tab (filtered cron + full refresh) ───────────────────

function SyncTab({
  status,
  onReload,
}: {
  status: SyncStatusResponse | null;
  onReload: () => void;
}) {
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  async function retryAll() {
    setRetrying(true);
    try {
      const res: any = await api.post("/api/sync/retry-errors");
      toast.success(`Retried ${res?.attempted ?? 0}, synced ${res?.synced ?? 0}`);
      onReload();
    } catch (e: any) {
      toast.error(`Retry failed: ${e?.message || e}`);
    } finally {
      setRetrying(false);
    }
  }

  async function syncAll() {
    setSyncingAll(true);
    try {
      await api.post("/api/sync/pull?mode=all");
      toast.success("Full sync complete");
      onReload();
    } catch (e: any) {
      toast.error(`Sync failed: ${e?.message || e}`);
    } finally {
      setSyncingAll(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
        <h2 className="mb-5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
          Filtered (cron)
        </h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Last pull</span>
            <span className="font-mono text-xs">
              {status?.last_pull
                ? `${relativeTime(status.last_pull.started_at)} (${status.last_pull.status})`
                : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Checkpoint</span>
            <span className="font-mono text-xs">{status?.checkpoint || "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Sync errors</span>
            <span className="font-mono text-xs">{status?.error_count ?? 0}</span>
          </div>
          {(status?.error_count ?? 0) > 0 && (
            <div className="pt-2">
              <Button variant="danger" onClick={retryAll} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry All Errors"}
              </Button>
            </div>
          )}
        </div>
      </section>

      <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
        <h2 className="mb-1 text-sm font-semibold">Full Refresh</h2>
        <p className="mb-4 text-xs text-ink-muted">
          Calls <span className="font-mono">/SalesOrder/getAll</span> and upserts
          everything — ignores server-side Remark2/Attention/Remark4/
          SalesExemptionExpiryDate filters. No checkpoint; the entire list is
          re-fetched each run. Manual only — not on the cron.
        </p>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Last full refresh</span>
            <span className="font-mono text-xs">
              {status?.last_pull_all
                ? `${relativeTime(status.last_pull_all.started_at)} (${status.last_pull_all.status})`
                : "Never"}
            </span>
          </div>
          <div className="pt-2">
            <Button
              variant="secondary"
              icon={<Database size={14} />}
              onClick={syncAll}
              disabled={syncingAll}
            >
              {syncingAll ? "Syncing…" : "Sync All (unfiltered)"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Email tab ────────────────────────────────────────────────

interface EmailSettingsResponse {
  settings: Record<string, { value: boolean }>;
  has_api_key: boolean;
  from: string | null;
  public_url: string | null;
}

const EMAIL_TOGGLES: { key: string; label: string; description: string }[] = [
  { key: "email.enabled", label: "Master switch", description: "When off, every channel is muted regardless of individual toggles." },
  { key: "email.assr_survey", label: "ASSR satisfaction survey", description: "Auto-send the tokenized survey link to the customer when a case closes (requires customer_email)." },
  { key: "email.assr_sla_escalation", label: "ASSR SLA breach alerts", description: "Email the assignee + managers when a case is escalated for missing its deadline >24h." },
  { key: "email.supplier_invite", label: "Supplier portal invites", description: "Email the invite / password-reset link to a supplier account." },
  { key: "email.project_due_reminder", label: "Project due reminders", description: "Daily cron emails checklist items due within 3 days or overdue." },
  { key: "email.password_reset", label: "Password reset emails", description: "Send a reset link when an admin clicks 'Send reset' on a team member." },
];

function EmailTab() {
  const toast = useToast();
  const q = useQuery<EmailSettingsResponse>(() => api.get("/api/settings/email"));
  const [saving, setSaving] = useState<string | null>(null);
  const [testAddr, setTestAddr] = useState("");
  const [testing, setTesting] = useState(false);

  async function toggle(key: string, value: boolean) {
    setSaving(key);
    try {
      await api.patch<EmailSettingsResponse>("/api/settings/email", { [key]: value });
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSaving(null);
    }
  }

  async function sendTest() {
    if (!testAddr.trim()) return;
    setTesting(true);
    try {
      const res = await api.post<{ status: string; reason?: string }>(
        "/api/settings/email/test",
        { to: testAddr.trim() }
      );
      if (res.status === "sent") toast.success("Test email sent");
      else if (res.status === "skipped") toast.error(`Skipped: ${res.reason}`);
      else toast.error(`Error: ${res.reason}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setTesting(false);
    }
  }

  const s = q.data;
  return (
    <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        <Mail size={12} /> Email Notifications
      </h2>

      {q.loading && <div className="text-xs text-ink-muted">Loading…</div>}

      {s && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg/60 p-3 text-[12px]">
            <StatusDot
              variant={s.has_api_key ? "synced" : "error"}
              label={s.has_api_key ? "Resend key configured" : "RESEND_API_KEY not set"}
            />
            {!s.has_api_key && (
              <span className="text-[11px] text-ink-muted">
                Set via: <span className="font-mono">wrangler secret put RESEND_API_KEY</span>
              </span>
            )}
            {s.from && (
              <span className="ml-auto text-[11px] text-ink-muted">
                From: <span className="font-mono">{s.from}</span>
              </span>
            )}
          </div>

          <div className="space-y-2">
            {EMAIL_TOGGLES.map((t) => {
              const enabled = s.settings[t.key]?.value ?? true;
              const isMaster = t.key === "email.enabled";
              const masterOff = !(s.settings["email.enabled"]?.value ?? true);
              return (
                <div
                  key={t.key}
                  className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="flex-1">
                    <div
                      className={`text-[12px] font-semibold ${isMaster ? "text-ink" : masterOff ? "text-ink-muted" : "text-ink"}`}
                    >
                      {t.label}
                    </div>
                    <div className="text-[11px] text-ink-muted">{t.description}</div>
                  </div>
                  <label className="mt-0.5 inline-flex cursor-pointer items-center gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={saving === t.key || (!isMaster && masterOff)}
                      onChange={(e) => toggle(t.key, e.target.checked)}
                      className="accent-accent"
                    />
                    <span className={enabled ? "text-synced" : "text-ink-muted"}>
                      {enabled ? "On" : "Off"}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>

          <div className="mt-5 flex items-center gap-2 border-t border-border pt-4">
            <input
              type="email"
              value={testAddr}
              onChange={(e) => setTestAddr(e.target.value)}
              placeholder="you@example.com"
              className="h-8 flex-1 rounded-md border border-border bg-surface px-3 text-[12px]"
            />
            <Button
              variant="secondary"
              icon={<Send size={12} />}
              disabled={testing || !testAddr.trim() || !s.has_api_key}
              onClick={sendTest}
            >
              {testing ? "Sending…" : "Send Test"}
            </Button>
          </div>
          <div className="mt-1 text-[10px] text-ink-muted">
            Test email ignores channel toggles but still requires RESEND_API_KEY.
          </div>
        </>
      )}
    </section>
  );
}

// ── Activity Log ──────────────────────────────────────────────

function ActivityLog() {
  const [type, setType] = useState("");
  const [logStatus, setLogStatus] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:logs", 50);

  const list = useQuery<Paginated<ExecutionLog>>(
    () =>
      api.get(`/api/logs${buildQuery({ type, status: logStatus, page, per_page: perPage })}`),
    [type, logStatus, page, perPage]
  );

  const columns: Column<ExecutionLog>[] = [
    {
      key: "started_at",
      label: "Time",
      alwaysVisible: true,
      render: (r) => (
        <span title={r.started_at} className="font-mono text-xs text-ink-secondary">
          {relativeTime(r.started_at)}
        </span>
      ),
      getValue: (r) => r.started_at,
    },
    {
      key: "type",
      label: "Type",
      render: (r) => (
        <span className="rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-secondary">
          {r.type}
        </span>
      ),
      getValue: (r) => r.type,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <StatusDot
          variant={
            r.status === "SYNCED" ? "synced" : r.status === "FAILED" ? "error" : "neutral"
          }
          label={r.status}
        />
      ),
      getValue: (r) => r.status,
    },
    {
      key: "message",
      label: "Message",
      render: (r) => <span className="text-ink-secondary">{r.message || "—"}</span>,
      getValue: (r) => r.message,
    },
    {
      key: "request_id",
      label: "ID",
      render: (r) => (
        <span className="font-mono text-[10px] text-ink-muted" title={r.request_id}>
          {r.request_id.slice(0, 8)}
        </span>
      ),
      getValue: (r) => r.request_id,
    },
  ];

  const selectClass =
    "h-8 rounded-lg border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15";

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <select
          className={selectClass}
          value={type}
          onChange={(e) => {
            setPage(1);
            setType(e.target.value);
          }}
        >
          <option value="">All Types</option>
          <option value="PULL">Pull</option>
          <option value="PUSH">Push</option>
          <option value="OVERDUE">Overdue</option>
          <option value="PO">PO</option>
          <option value="ASSR">ASSR</option>
        </select>
        <select
          className={selectClass}
          value={logStatus}
          onChange={(e) => {
            setPage(1);
            setLogStatus(e.target.value);
          }}
        >
          <option value="">All Status</option>
          <option value="SYNCED">Synced</option>
          <option value="FAILED">Failed</option>
          <option value="SKIPPED">Skipped</option>
        </select>
      </div>

      <DataTable
        tableId="logs"
        udfTable="logs"
        udfTableLabel="Activity Log"
        exportName="activity-log"
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No log entries"
        getRowKey={(r) => r.id}
      />

      {list.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}
    </div>
  );
}

// ── Service Cases tab ────────────────────────────────────────

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

function ServiceTab() {
  const toast = useToast();
  const settings = useQuery<ServiceSettingsResponse>(
    () => api.get("/api/assr/settings")
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

// ── Projects tab ─────────────────────────────────────────────
// Lookup management for the project module: organizers, venues, and
// the default checklist that's cloned into every new project (per
// event type).

interface OrganizerRow {
  id: number;
  name: string;
  notes: string | null;
  active: number;
}
interface VenueRow {
  id: number;
  name: string;
  state: string | null;
  notes: string | null;
  active: number;
}
interface EventTypeRow {
  id: number;
  slug: string;
  name: string;
  default_template_id: number | null;
  sort_order: number;
}
interface ChecklistTemplate {
  id: number;
  name: string;
  description: string | null;
  item_count: number;
  used_by: string | null;
}
interface ChecklistTemplateItem {
  id: number;
  seq: number;
  title: string;
  description: string | null;
  required_perm: string | null;
  due_offset_days: number | null;
}

function ProjectsTab() {
  return (
    <div className="space-y-6">
      <OrganizerManager />
      <VenueManager />
      <ChecklistManager />
    </div>
  );
}

function OrganizerManager() {
  const toast = useToast();
  const q = useQuery<{ data: OrganizerRow[] }>(
    () => api.get("/api/projects/organizers")
  );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/organizers", { name: trimmed });
      setName("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function remove(o: OrganizerRow) {
    if (!confirm(`Remove organizer "${o.name}"? Existing projects keep the value.`)) return;
    try {
      await api.del(`/api/projects/organizers/${o.id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        Organizers
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">
        Picker values for the project Organizer field. Soft delete — existing
        project rows still display whatever name they were saved with.
      </p>

      <div className="mb-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add organizer name…"
          className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">Loading…</li>
        )}
        {q.data?.data.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">No organizers yet.</li>
        )}
        {q.data?.data.map((o) => (
          <li
            key={o.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <span className="text-[12.5px] text-ink">{o.name}</span>
            <button
              onClick={() => remove(o)}
              className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VenueManager() {
  const toast = useToast();
  const q = useQuery<{ data: VenueRow[] }>(() => api.get("/api/projects/venues"));
  const [name, setName] = useState("");
  const [stateField, setStateField] = useState("");
  const [adding, setAdding] = useState(false);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/venues", {
        name: trimmed,
        state: stateField.trim() || null,
      });
      setName("");
      setStateField("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function patch(id: number, body: Record<string, any>) {
    try {
      await api.patch(`/api/projects/venues/${id}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function remove(v: VenueRow) {
    if (!confirm(`Remove venue "${v.name}"? Existing projects keep the value.`)) return;
    try {
      await api.del(`/api/projects/venues/${v.id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        Venues
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">
        Picker values for the project Venue field. Optionally tag each venue
        with a state — picking it on a new project will pre-fill the state.
      </p>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px_auto]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Venue name…"
          className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <input
          value={stateField}
          onChange={(e) => setStateField(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="State (optional)"
          className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">Loading…</li>
        )}
        {q.data?.data.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">No venues yet.</li>
        )}
        {q.data?.data.map((v) => (
          <li
            key={v.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] text-ink">{v.name}</div>
              {v.state && (
                <div className="text-[10.5px] text-ink-muted">{v.state}</div>
              )}
            </div>
            <input
              defaultValue={v.state || ""}
              onBlur={(e) => {
                if (e.target.value !== (v.state || "")) {
                  patch(v.id, { state: e.target.value || null });
                }
              }}
              placeholder="state"
              className="h-7 w-32 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            <button
              onClick={() => remove(v)}
              className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChecklistManager() {
  const toast = useToast();
  const eventTypesQ = useQuery<{ data: EventTypeRow[] }>(
    () => api.get("/api/projects/event-types")
  );
  const templatesQ = useQuery<{ data: ChecklistTemplate[] }>(
    () => api.get("/api/projects/checklist-templates")
  );
  const [activeTemplate, setActiveTemplate] = useState<number | null>(null);

  const templates = templatesQ.data?.data ?? [];
  const eventTypes = eventTypesQ.data?.data ?? [];
  const currentTemplateId = activeTemplate ?? templates[0]?.id ?? null;

  async function setDefaultTemplate(eventTypeId: number, templateId: number | null) {
    try {
      await api.put(
        `/api/projects/event-types/${eventTypeId}/default-template`,
        { template_id: templateId }
      );
      toast.success("Default template updated");
      eventTypesQ.reload();
      templatesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        Default Checklist
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">
        Items in the chosen template are cloned into every new project of that
        event type. Editing here does not affect projects already created.
      </p>

      <div className="mb-4 rounded-md border border-border bg-bg/40 p-3">
        <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Default template per event type
        </div>
        {eventTypesQ.loading ? (
          <div className="text-[11.5px] text-ink-muted">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {eventTypes.map((et) => (
              <label
                key={et.id}
                className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-3 py-2"
              >
                <span className="text-[12px] font-semibold text-ink">{et.name}</span>
                <select
                  value={et.default_template_id ?? ""}
                  onChange={(e) =>
                    setDefaultTemplate(
                      et.id,
                      e.target.value ? parseInt(e.target.value, 10) : null
                    )
                  }
                  className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent"
                >
                  <option value="">— None —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Editing
        </span>
        <select
          value={currentTemplateId ?? ""}
          onChange={(e) => setActiveTemplate(parseInt(e.target.value, 10) || null)}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent"
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.item_count} items
            </option>
          ))}
        </select>
        {currentTemplateId &&
          templates.find((t) => t.id === currentTemplateId)?.used_by && (
            <span className="text-[10.5px] text-ink-muted">
              Used by:{" "}
              {templates.find((t) => t.id === currentTemplateId)?.used_by}
            </span>
          )}
      </div>

      {currentTemplateId && (
        <ChecklistItemsEditor templateId={currentTemplateId} />
      )}
    </section>
  );
}

function ChecklistItemsEditor({ templateId }: { templateId: number }) {
  const toast = useToast();
  const q = useQuery<{ data: ChecklistTemplateItem[] }>(
    () => api.get(`/api/projects/checklist-templates/${templateId}/items`),
    [templateId]
  );
  const [newTitle, setNewTitle] = useState("");
  const [newOffset, setNewOffset] = useState("");
  const [adding, setAdding] = useState(false);

  async function addItem() {
    const t = newTitle.trim();
    if (!t) return;
    setAdding(true);
    try {
      await api.post(`/api/projects/checklist-templates/${templateId}/items`, {
        title: t,
        due_offset_days: newOffset ? parseInt(newOffset, 10) : null,
      });
      setNewTitle("");
      setNewOffset("");
      q.reload();
      toast.success("Item added");
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function patchItem(itemId: number, body: Record<string, any>) {
    try {
      await api.patch(`/api/projects/checklist-templates/items/${itemId}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function removeItem(item: ChecklistTemplateItem) {
    if (!confirm(`Delete checklist item "${item.title}"?`)) return;
    try {
      await api.del(`/api/projects/checklist-templates/items/${item.id}`);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  const items = q.data?.data ?? [];

  return (
    <div>
      <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_auto]">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addItem()}
          placeholder="New item title…"
          className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <input
          value={newOffset}
          onChange={(e) => setNewOffset(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addItem()}
          placeholder="Due offset days"
          type="number"
          className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <Button
          variant="primary"
          onClick={addItem}
          disabled={adding || !newTitle.trim()}
        >
          Add item
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">Loading…</li>
        )}
        {!q.loading && items.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">
            No items yet — add one above.
          </li>
        )}
        {items.map((item) => (
          <li
            key={item.id}
            className="grid grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[60px_1fr_120px_auto] sm:items-center"
          >
            <input
              defaultValue={item.seq}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!isNaN(n) && n !== item.seq) patchItem(item.id, { seq: n });
              }}
              type="number"
              className="h-7 rounded-md border border-border bg-surface px-2 font-mono text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            <input
              defaultValue={item.title}
              onBlur={(e) => {
                if (e.target.value !== item.title)
                  patchItem(item.id, { title: e.target.value });
              }}
              className="h-7 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            <input
              defaultValue={item.due_offset_days ?? ""}
              onBlur={(e) => {
                const n = e.target.value ? parseInt(e.target.value, 10) : null;
                if (n !== item.due_offset_days)
                  patchItem(item.id, { due_offset_days: n });
              }}
              type="number"
              placeholder="Due offset"
              className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            <button
              onClick={() => removeItem(item)}
              className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10.5px] text-ink-muted">
        Seq controls display order (lower first). Due offset days = how many
        days from the project start date the item is due (negative = before
        start).
      </p>
    </div>
  );
}
