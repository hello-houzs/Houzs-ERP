import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, CheckSquare, Send, Settings as SettingsIcon, X } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useUdf, type UdfField, type UdfFieldType } from "../hooks/useUdf";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import { ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";

const SALES_FILTER_KEYS = ["status", "search", "date_from", "date_to"] as const;

// ── Types ─────────────────────────────────────────────────────

export type EntryStatus = "draft" | "submitted" | "pushed" | "void";

export type PaymentType = "cash" | "card_cc" | "card_db" | "epp";

export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  cash: "Cash",
  card_cc: "Credit Card",
  card_db: "Debit Card",
  epp: "EPP",
};

export interface SalesEntry {
  id: number;
  project_id: number | null;
  project_code: string | null;
  project_name: string | null;
  ref_no: string | null;
  customer_name: string;
  customer_code: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  amount: number;
  deposit_amount: number | null;
  deposit_payment_type: PaymentType | null;
  currency: string;
  occurred_at: string;
  notes: string | null;
  status: EntryStatus;
  autocount_doc_no: string | null;
  autocount_doc_type: string | null;
  pushed_at: string | null;
  push_error: string | null;
  sales_person_id: number | null;
  sales_person_name: string | null;
  sales_person_email: string | null;
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

export const STATUS_BADGE: Record<EntryStatus, { label: string; cls: string }> = {
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

  // Filter state lives in the URL — `?status=draft&search=abc` —
  // mirrored to localStorage via useStickyFilters so navbar away-and-back
  // restores the last view. Bookmark / share / refresh / back-button all
  // work because the URL itself is the source of truth.
  const [params, setParams] = useStickyFilters("sales", SALES_FILTER_KEYS);
  const status = params.get("status") || "";
  const search = params.get("search") || "";
  const dateFrom = params.get("date_from") || "";
  const dateTo = params.get("date_to") || "";

  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

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
          onChange={(e) => patchParams({ status: e.target.value })}
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
          onChange={(e) => patchParams({ date_from: e.target.value })}
          title="From"
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px]"
        />
        <span className="text-[10px] text-ink-muted">→</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => patchParams({ date_to: e.target.value })}
          title="To"
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px]"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => patchParams({ search: e.target.value })}
          placeholder="Search customer / phone / ref no…"
          className="h-8 flex-1 min-w-[200px] max-w-[320px] rounded-md border border-border bg-surface px-3 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        {(status || search || dateFrom || dateTo) && (
          <button
            onClick={() =>
              patchParams({ status: "", search: "", date_from: "", date_to: "" })
            }
            className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
          >
            Clear
          </button>
        )}
      </div>

      {/* List */}
      {list.loading && !list.data && <ListSkeleton rows={6} />}
      {list.error && (
        <div className="rounded-md border border-err/40 bg-err/5 px-4 py-3 text-[12px] text-err">
          {list.error}
        </div>
      )}
      {list.data && list.data.data.length === 0 && !list.loading && (
        <EmptyState
          message="No sales logged yet."
          cta={
            canWrite
              ? { label: "Add your first entry", onClick: () => setCreating(true) }
              : undefined
          }
        />
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
                      {e.customer_phone && (
                        <div className="font-mono text-[10px] text-ink-muted">
                          {e.customer_phone}
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

export function EntryPanel({
  mode,
  entry,
  udfFields,
  onClose,
  onSaved,
  lockedProjectId,
  lockedProjectLabel,
}: {
  mode: "create" | "edit";
  entry?: SalesEntry;
  udfFields: UdfField[];
  onClose: () => void;
  onSaved: () => void;
  /** When set, the project picker is replaced by a read-only label and
   *  every saved entry is force-linked to this project. Used by the
   *  in-project Sales section so reps can't accidentally re-target an
   *  entry to a different exhibition. */
  lockedProjectId?: number;
  lockedProjectLabel?: string;
}) {
  const toast = useToast();
  const auth = useAuth();
  const [customerName, setCustomerName] = useState(entry?.customer_name || "");
  const [customerPhone, setCustomerPhone] = useState(entry?.customer_phone || "");
  const [customerAddress, setCustomerAddress] = useState(entry?.customer_address || "");
  const [refNo, setRefNo] = useState(entry?.ref_no || "");
  const [amount, setAmount] = useState(entry ? String(entry.amount) : "");
  // When deposit_amount is null on a fresh row, default it to mirror
  // amount — the rep collected the full sale up front. They can drop
  // it lower if a balance is being chased.
  const [depositAmount, setDepositAmount] = useState(
    entry?.deposit_amount != null
      ? String(entry.deposit_amount)
      : entry?.amount != null
      ? String(entry.amount)
      : ""
  );
  const [depositPaymentType, setDepositPaymentType] = useState<PaymentType | "">(
    (entry?.deposit_payment_type as PaymentType) || ""
  );
  const [salesPersonId, setSalesPersonId] = useState<string>(
    entry?.sales_person_id != null
      ? String(entry.sales_person_id)
      : auth.user?.id
      ? String(auth.user.id)
      : ""
  );
  const [currency, setCurrency] = useState(entry?.currency || "MYR");
  const [occurredAt, setOccurredAt] = useState(
    entry?.occurred_at?.slice(0, 10) || new Date().toISOString().slice(0, 10)
  );
  const [projectId, setProjectId] = useState<string>(
    lockedProjectId
      ? String(lockedProjectId)
      : entry?.project_id ? String(entry.project_id) : ""
  );
  const [notes, setNotes] = useState(entry?.notes || "");
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Sales-person picker. Defaults to the logged-in user (admins keying
  // an entry on behalf of a rep change this). Falls back gracefully if
  // /api/users is forbidden for the role — the picker simply hides.
  const usersQ = useQuery<{ users: Array<{ id: number; name: string | null; email: string }> }>(
    () => api.get<{ users: Array<{ id: number; name: string | null; email: string }> }>("/api/users").catch(() => ({ users: [] }))
  );

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
  // only their PIC's projects here. Fires even when locked — harmless
  // and avoids a conditional hook call.
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
    let dep: number | null = null;
    if (depositAmount.trim() !== "") {
      const d = parseFloat(depositAmount);
      if (!isFinite(d) || d < 0) {
        toast.error("Deposit must be a non-negative number");
        return;
      }
      if (d > amt) {
        toast.error("Deposit cannot exceed amount");
        return;
      }
      dep = d;
    }
    if (dep !== null && dep > 0 && !depositPaymentType) {
      toast.error("Pick a payment type for the deposit");
      return;
    }
    setBusy(true);
    try {
      const body: any = {
        project_id: projectId ? parseInt(projectId, 10) : null,
        ref_no: refNo.trim() || null,
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim() || null,
        customer_address: customerAddress.trim() || null,
        amount: amt,
        deposit_amount: dep,
        deposit_payment_type: depositPaymentType || null,
        sales_person_id: salesPersonId ? parseInt(salesPersonId, 10) : null,
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
            placeholder="e.g. Tan Wei Ming"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            autoFocus
          />
        </div>
        <div>
          <Label>Phone</Label>
          <input
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
            placeholder="e.g. 012-345 6789"
            inputMode="tel"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
        <div>
          <Label>Address</Label>
          <textarea
            value={customerAddress}
            onChange={(e) => setCustomerAddress(e.target.value)}
            placeholder="Delivery / billing address"
            rows={2}
            className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
      </PanelSection>

      <PanelSection title="Sale">
        <div>
          <Label>Reference no.</Label>
          <input
            value={refNo}
            onChange={(e) => setRefNo(e.target.value)}
            placeholder="e.g. ZNT00001"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <div>
            <Label>Amount</Label>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                // Auto-mirror deposit when the rep hasn't manually
                // dialled it back yet (deposit==prev amount). Avoids
                // surprising them when they type the gross first.
                if (depositAmount === "" || depositAmount === amount) {
                  setDepositAmount(e.target.value);
                }
              }}
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
        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <div>
            <Label>Deposit collected</Label>
            <input
              type="number"
              step="0.01"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="0.00"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <div>
            <Label>Deposit payment type</Label>
            <select
              value={depositPaymentType}
              onChange={(e) => setDepositPaymentType(e.target.value as PaymentType | "")}
              className="h-10 w-full appearance-none rounded-md border border-border bg-surface px-3 text-[13px]"
            >
              <option value="">— select —</option>
              <option value="cash">Cash</option>
              <option value="card_cc">Credit Card</option>
              <option value="card_db">Debit Card</option>
              <option value="epp">EPP</option>
            </select>
          </div>
        </div>
        {(() => {
          const a = parseFloat(amount) || 0;
          const d = parseFloat(depositAmount) || 0;
          const balance = Math.max(0, a - d);
          if (a <= 0) return null;
          return (
            <div className="rounded-md border border-border-subtle bg-bg/40 px-3 py-2 text-[11px] text-ink-secondary">
              Balance to chase post-event:{" "}
              <span className="font-mono font-bold text-ink">
                {currency || "MYR"} {balance.toFixed(2)}
              </span>
            </div>
          );
        })()}
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
          <Label>Sales person</Label>
          <select
            value={salesPersonId}
            onChange={(e) => setSalesPersonId(e.target.value)}
            className="h-10 w-full appearance-none rounded-md border border-border bg-surface px-3 text-[13px]"
          >
            <option value="">— me —</option>
            {(usersQ.data?.users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Project</Label>
          {lockedProjectId ? (
            <div
              className="flex h-10 items-center rounded-md border border-border bg-bg/40 px-3 text-[13px] text-ink-secondary"
              title="Locked — drafted from this exhibition's page"
            >
              {lockedProjectLabel || `Project #${lockedProjectId}`}
            </div>
          ) : (
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
          )}
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
