import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, CheckSquare, Send, Settings as SettingsIcon, X } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useUdf, type UdfField, type UdfFieldType } from "../hooks/useUdf";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { formatCurrency, formatDate, cn } from "../lib/utils";

// ── Types ─────────────────────────────────────────────────────

type EntryStatus = "draft" | "submitted" | "pushed" | "void";

interface SalesEntry {
  id: number;
  project_id: number | null;
  project_code: string | null;
  project_name: string | null;
  customer_name: string;
  customer_code: string | null;
  amount: number;
  currency: string;
  occurred_at: string;
  notes: string | null;
  status: EntryStatus;
  autocount_doc_no: string | null;
  autocount_doc_type: string | null;
  pushed_at: string | null;
  push_error: string | null;
  created_by: number;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ListResponse {
  data: SalesEntry[];
  page: number;
  per_page: number;
  total: number;
  totals: {
    amount: number;
    count: number;
    by_status: { draft: number; submitted: number; pushed: number };
  };
}

const STATUS_BADGE: Record<EntryStatus, { label: string; cls: string }> = {
  draft:     { label: "Draft",     cls: "bg-bg text-ink-muted border border-border" },
  submitted: { label: "Submitted", cls: "bg-amber-100 text-amber-800" },
  pushed:    { label: "Pushed",    cls: "bg-synced/15 text-synced" },
  void:      { label: "Void",      cls: "bg-err/10 text-err" },
};

// ── Page ──────────────────────────────────────────────────────

export function Sales() {
  const { can, user: me } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const canManage = can("sales.manage");
  const canWrite = can("sales.write");

  const [status, setStatus] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [editing, setEditing] = useState<SalesEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (search) p.set("search", search);
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    return p.toString();
  }, [status, search, dateFrom, dateTo]);

  const list = useQuery<ListResponse>(
    () => api.get(`/api/sales/entries${qs ? `?${qs}` : ""}`),
    [qs]
  );
  const udf = useUdf("sales_entries");

  async function submitEntry(e: SalesEntry) {
    try {
      await api.post(`/api/sales/entries/${e.id}/submit`);
      toast.success(`Submitted — ${e.customer_name}`);
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed");
    }
  }
  async function voidEntry(e: SalesEntry) {
    if (!(await dialog.confirm(`Void sale for ${e.customer_name}?`))) return;
    try {
      await api.post(`/api/sales/entries/${e.id}/void`);
      toast.success("Voided");
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed");
    }
  }
  async function deleteEntry(e: SalesEntry) {
    if (!(await dialog.confirm(`Delete draft for ${e.customer_name}?`))) return;
    try {
      await api.del(`/api/sales/entries/${e.id}`);
      toast.success("Deleted");
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed");
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Income"
        title="Sales"
        description="Log customer sales here. Fields are customisable — admins can add extras via the settings gear. Drafts can be edited freely; submitted entries lock for review and will push to AutoCount once the integration is enabled."
        actions={
          <div className="flex items-center gap-1.5">
            {canManage && (
              <button
                onClick={() => setFieldsOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
                title="Configure fields"
              >
                <SettingsIcon size={13} /> Fields
              </button>
            )}
            {canWrite && (
              <Button
                variant="brass"
                icon={<Plus size={14} />}
                onClick={() => setCreating(true)}
              >
                New Sale
              </Button>
            )}
          </div>
        }
      />

      {/* Summary tiles */}
      <div className="mb-4 grid grid-cols-2 divide-x divide-border-subtle overflow-hidden rounded-md border border-border bg-surface shadow-stone sm:grid-cols-4">
        <Tile label="Total" value={formatCurrency(list.data?.totals.amount ?? 0)} />
        <Tile label="Entries" value={String(list.data?.totals.count ?? 0)} />
        <Tile
          label="Drafts"
          value={String(list.data?.totals.by_status.draft ?? 0)}
        />
        <Tile
          label="Pushed"
          value={String(list.data?.totals.by_status.pushed ?? 0)}
          tone="ok"
        />
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="pushed">Pushed</option>
          <option value="void">Void</option>
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          title="From"
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px]"
        />
        <span className="text-[10px] text-ink-muted">→</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          title="To"
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px]"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer / notes…"
          className="h-8 flex-1 min-w-[200px] max-w-[320px] rounded-md border border-border bg-surface px-3 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        {(status || search || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setStatus("");
              setSearch("");
              setDateFrom("");
              setDateTo("");
            }}
            className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
          >
            Clear
          </button>
        )}
      </div>

      {/* List */}
      {list.loading && !list.data && (
        <div className="px-4 py-6 text-[12px] text-ink-muted">Loading…</div>
      )}
      {list.error && (
        <div className="rounded-md border border-err/40 bg-err/5 px-4 py-3 text-[12px] text-err">
          {list.error}
        </div>
      )}
      {list.data && list.data.data.length === 0 && !list.loading && (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center text-[12px] text-ink-muted">
          No sales logged yet.{" "}
          {canWrite && (
            <button
              onClick={() => setCreating(true)}
              className="font-semibold text-accent hover:underline"
            >
              Add your first entry
            </button>
          )}
        </div>
      )}
      {list.data && list.data.data.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
          <table className="w-full">
            <thead className="bg-bg/60">
              <tr className="text-left font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Project</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">By</th>
                <th className="px-3 py-2 w-px"></th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((e) => {
                const badge = STATUS_BADGE[e.status];
                const isMine = e.created_by === me?.id;
                const canEdit = canManage || (isMine && e.status === "draft");
                const canSubmit = canEdit && e.status === "draft";
                return (
                  <tr
                    key={e.id}
                    className="border-t border-border-subtle text-[12px] hover:bg-bg/40"
                  >
                    <td className="px-3 py-2 font-mono text-ink-secondary">
                      {formatDate(e.occurred_at)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-ink">{e.customer_name}</div>
                      {e.customer_code && (
                        <div className="font-mono text-[10px] text-ink-muted">
                          {e.customer_code}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">
                      {formatCurrency(e.amount)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-secondary">
                      {e.project_code || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider",
                          badge.cls
                        )}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-ink-muted">
                      {e.created_by_name || e.created_by_email || "—"}
                    </td>
                    <td className="px-1 py-1">
                      <div className="flex items-center gap-0.5">
                        {canSubmit && (
                          <button
                            onClick={() => submitEntry(e)}
                            className="rounded p-1.5 text-ink-muted hover:bg-accent-soft hover:text-accent"
                            title="Submit"
                          >
                            <CheckSquare size={13} />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => setEditing(e)}
                            className="rounded p-1.5 text-ink-muted hover:bg-surface-dim hover:text-ink"
                            title="Edit"
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                        {canManage && e.status === "submitted" && (
                          <button
                            onClick={() => submitEntry(e)}
                            className="rounded p-1.5 text-ink-muted hover:bg-accent-soft hover:text-accent"
                            title="Push to AutoCount"
                            disabled
                          >
                            <Send size={13} />
                          </button>
                        )}
                        {canManage && e.status !== "void" && (
                          <button
                            onClick={() => voidEntry(e)}
                            className="rounded p-1.5 text-ink-muted hover:bg-err/10 hover:text-err"
                            title="Void"
                          >
                            <X size={13} />
                          </button>
                        )}
                        {canEdit && e.status === "draft" && (
                          <button
                            onClick={() => deleteEntry(e)}
                            className="rounded p-1.5 text-ink-muted hover:bg-err/10 hover:text-err"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <EntryPanel
          mode="create"
          udfFields={udf.fields}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            list.reload();
          }}
        />
      )}
      {editing && (
        <EntryPanel
          mode="edit"
          entry={editing}
          udfFields={udf.fields}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      {fieldsOpen && (
        <FieldConfigPanel
          udf={udf}
          onClose={() => setFieldsOpen(false)}
        />
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "err" | "default";
}) {
  return (
    <div className="px-3 py-2.5">
      <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[14px] font-bold leading-tight",
          tone === "ok" && "text-synced",
          tone === "err" && "text-err",
          (!tone || tone === "default") && "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ── Entry create/edit panel ──────────────────────────────────

function EntryPanel({
  mode,
  entry,
  udfFields,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  entry?: SalesEntry;
  udfFields: UdfField[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [customerName, setCustomerName] = useState(entry?.customer_name || "");
  const [customerCode, setCustomerCode] = useState(entry?.customer_code || "");
  const [amount, setAmount] = useState(entry ? String(entry.amount) : "");
  const [currency, setCurrency] = useState(entry?.currency || "MYR");
  const [occurredAt, setOccurredAt] = useState(
    entry?.occurred_at?.slice(0, 10) || new Date().toISOString().slice(0, 10)
  );
  const [projectId, setProjectId] = useState<string>(
    entry?.project_id ? String(entry.project_id) : ""
  );
  const [notes, setNotes] = useState(entry?.notes || "");
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Hydrate custom field values if editing.
  useEffect(() => {
    if (mode !== "edit" || !entry) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{ entry: SalesEntry; custom: Record<string, string | null> }>(
          `/api/sales/entries/${entry.id}`
        );
        if (cancelled) return;
        const initial: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.custom || {})) {
          if (v != null) initial[k] = v;
        }
        setCustom(initial);
      } catch {
        // silent — form already usable with the row we have
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, entry]);

  // Minimal project picker — fetches only recent projects. Free text
  // fallback not shown; pic_id wiring on projects means reps already see
  // only their PIC's projects here.
  const projectsQ = useQuery<{ data: Array<{ id: number; code: string; name: string }> }>(
    () => api.get("/api/projects?per_page=200")
  );

  async function submit(thenSubmit: boolean) {
    if (!customerName.trim()) {
      toast.error("Customer name is required");
      return;
    }
    const amt = parseFloat(amount);
    if (!isFinite(amt)) {
      toast.error("Amount must be a number");
      return;
    }
    setBusy(true);
    try {
      const body: any = {
        project_id: projectId ? parseInt(projectId, 10) : null,
        customer_name: customerName.trim(),
        customer_code: customerCode.trim() || null,
        amount: amt,
        currency: currency.trim() || "MYR",
        occurred_at: occurredAt,
        notes: notes.trim() || null,
        custom,
      };
      let id: number;
      if (mode === "create") {
        const r = await api.post<{ id: number }>("/api/sales/entries", body);
        id = r.id;
        toast.success(`Added ${customerName}`);
      } else if (entry) {
        await api.patch(`/api/sales/entries/${entry.id}`, body);
        id = entry.id;
        toast.success(`Updated ${customerName}`);
      } else {
        return;
      }
      if (thenSubmit) {
        try {
          await api.post(`/api/sales/entries/${id}/submit`);
        } catch (e: any) {
          toast.error(e?.message || "Saved but could not submit");
        }
      }
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={mode === "create" ? "New Sale" : `Edit · ${entry?.customer_name}`}
      subtitle={
        mode === "create"
          ? "Log a new customer sale"
          : `Draft created ${formatDate(entry?.created_at || "")}`
      }
      width={480}
      footer={
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => submit(false)}
              disabled={busy}
            >
              {busy ? "Saving…" : "Save draft"}
            </Button>
            <Button
              variant="primary"
              onClick={() => submit(true)}
              disabled={busy}
            >
              Save & submit
            </Button>
          </div>
        </div>
      }
    >
      <PanelSection title="Customer">
        <div>
          <Label>Customer name</Label>
          <input
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="e.g. ABC Sdn Bhd"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            autoFocus
          />
        </div>
        <div>
          <Label>AutoCount customer code (optional)</Label>
          <input
            value={customerCode}
            onChange={(e) => setCustomerCode(e.target.value)}
            placeholder="e.g. 300-A0001"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
      </PanelSection>

      <PanelSection title="Sale">
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <div>
            <Label>Amount</Label>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <div>
            <Label>Currency</Label>
            <input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
        </div>
        <div>
          <Label>Date</Label>
          <input
            type="date"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
          />
        </div>
        <div>
          <Label>Project (optional)</Label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="h-10 w-full appearance-none rounded-md border border-border bg-surface px-3 text-[13px]"
          >
            <option value="">— none —</option>
            {(projectsQ.data?.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Notes</Label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the accounts team should know"
            className="min-h-[70px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
      </PanelSection>

      {udfFields.length > 0 && (
        <PanelSection title="Extra fields">
          {udfFields
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((f) => (
              <DynamicField
                key={f.key}
                field={f}
                value={custom[f.key] ?? ""}
                onChange={(v) =>
                  setCustom((prev) => {
                    const next = { ...prev };
                    if (v === "" || v == null) delete next[f.key];
                    else next[f.key] = v;
                    return next;
                  })
                }
              />
            ))}
        </PanelSection>
      )}
    </Panel>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      {children}
    </label>
  );
}

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: UdfField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label>{field.label}</Label>
      {field.type === "text" && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
        />
      )}
      {field.type === "number" && (
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
        />
      )}
      {field.type === "date" && (
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
        />
      )}
      {field.type === "select" && (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full appearance-none rounded-md border border-border bg-surface px-3 text-[13px]"
        >
          <option value="">— select —</option>
          {(field.options || []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}
      {field.type === "checkbox" && (
        <label className="mt-1 inline-flex items-center gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={value === "1" || value === "true"}
            onChange={(e) => onChange(e.target.checked ? "1" : "")}
            className="h-4 w-4 accent-accent"
          />
          Yes
        </label>
      )}
    </div>
  );
}

// ── Field configuration panel (admin-only) ───────────────────

function FieldConfigPanel({
  udf,
  onClose,
}: {
  udf: ReturnType<typeof useUdf>;
  onClose: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<UdfFieldType>("text");
  const [newOptions, setNewOptions] = useState("");
  const [busy, setBusy] = useState(false);

  async function addField() {
    const key = newKey.trim().toLowerCase();
    const label = newLabel.trim();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) {
      toast.error("Key must be snake_case, start with a letter");
      return;
    }
    if (!label) {
      toast.error("Label is required");
      return;
    }
    const opts =
      newType === "select"
        ? newOptions
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    if (newType === "select" && (!opts || opts.length === 0)) {
      toast.error("Add at least one option");
      return;
    }
    setBusy(true);
    try {
      await udf.addField({ key, label, type: newType, options: opts });
      setNewKey("");
      setNewLabel("");
      setNewOptions("");
      setNewType("text");
      toast.success(`Added "${label}"`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeField(key: string, label: string) {
    if (
      !(await dialog.confirm(
        `Delete field "${label}"? Values on existing entries will also be removed.`
      ))
    )
      return;
    try {
      await udf.deleteField(key);
      toast.success(`Removed "${label}"`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="Sales Fields"
      subtitle="Control what extra information reps are asked for"
      width={440}
    >
      <PanelSection title={`Existing fields (${udf.fields.length})`}>
        {udf.fields.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-4 text-center text-[11px] text-ink-muted">
            No extra fields configured. The form will only ask for the
            built-in customer / amount / date / project / notes.
          </div>
        ) : (
          <div className="space-y-1.5">
            {udf.fields
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((f) => (
                <div
                  key={f.key}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-ink">
                      {f.label}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                      {f.key} · {f.type}
                      {f.type === "select" && f.options && (
                        <> · [{f.options.join(", ")}]</>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => removeField(f.key, f.label)}
                    className="rounded p-1.5 text-ink-muted hover:bg-err/10 hover:text-err"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title="Add field">
        <div>
          <Label>Key (snake_case)</Label>
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.toLowerCase())}
            placeholder="e.g. po_number"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[12px]"
          />
        </div>
        <div>
          <Label>Label</Label>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. Customer PO Number"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
          />
        </div>
        <div>
          <Label>Type</Label>
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as UdfFieldType)}
            className="h-10 w-full appearance-none rounded-md border border-border bg-surface px-3 text-[13px]"
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="select">Select (dropdown)</option>
            <option value="checkbox">Checkbox (yes/no)</option>
          </select>
        </div>
        {newType === "select" && (
          <div>
            <Label>Options (comma-separated)</Label>
            <input
              value={newOptions}
              onChange={(e) => setNewOptions(e.target.value)}
              placeholder="Cash, Card, Bank transfer"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px]"
            />
          </div>
        )}
        <div className="pt-1">
          <Button variant="brass" onClick={addField} disabled={busy} className="w-full">
            {busy ? "Adding…" : "Add field"}
          </Button>
        </div>
      </PanelSection>
    </Panel>
  );
}
