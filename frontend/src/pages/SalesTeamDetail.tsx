import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { DetailLayout } from "../components/DetailLayout";
import { TabStrip } from "../components/TabStrip";
import { EmptyState } from "../components/EmptyState";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { cn, formatDate, formatDateTime } from "../lib/utils";
import type {
  SalesRep,
  SalesPosition,
  SalesCommissionTier,
  SalesTeamActivity,
} from "../types";

interface RepDetailResponse {
  rep: SalesRep;
  direct_count: number;
  subtree_count: number;
}

type Tab = "overview" | "downline" | "performance" | "audit";
const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "downline", label: "Downline" },
  { value: "performance", label: "Performance" },
  { value: "audit", label: "Audit log" },
];

export function SalesTeamDetail() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = parseInt(idParam || "", 10);
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can("sales_team.manage");
  const [tab, setTab] = useState<Tab>("overview");

  const detail = useQuery<RepDetailResponse>(
    () => api.get(`/api/sales-team/reps/${id}`),
    [id],
  );
  const positionsQ = useQuery<{ data: SalesPosition[] }>(() =>
    api.get("/api/sales-team/lookups/positions"),
  );
  const tiersQ = useQuery<{ data: SalesCommissionTier[] }>(() =>
    api.get("/api/sales-team/lookups/commission-tiers"),
  );
  const activityQ = useQuery<{ data: SalesTeamActivity[] }>(
    () => api.get(`/api/sales-team/reps/${id}/activity`),
    [id],
  );

  const rep = detail.data?.rep;

  async function patch(body: Record<string, any>) {
    try {
      await api.patch(`/api/sales-team/reps/${id}`, body);
      detail.reload();
      activityQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Sales Team", to: "/sales-team" },
        { label: rep?.name ?? "Loading…" },
      ]}
      eyebrow={rep?.code ? `Sales Rep · ${rep.code}` : "Sales Rep"}
      title={rep?.name ?? "Loading…"}
      description={
        rep
          ? `${rep.position_name ?? "—"}${rep.upline_name ? ` · reports to ${rep.upline_name}` : ""}`
          : undefined
      }
      backTo="/sales-team"
      loading={detail.loading && !rep}
      error={detail.error}
    >
      {/* Tab strip */}
      <TabStrip value={tab} onChange={setTab} options={TABS} />

      {!rep && !detail.loading && (
        <div className="rounded-md border border-border bg-surface p-6 text-[12px] text-ink-muted">
          Rep not found.
        </div>
      )}

      {rep && tab === "overview" && (
        <OverviewTab
          rep={rep}
          positions={positionsQ.data?.data ?? []}
          tiers={tiersQ.data?.data ?? []}
          canManage={canManage}
          onPatch={patch}
        />
      )}

      {rep && tab === "downline" && (
        <div className="rounded-md border border-border bg-surface p-6 text-[12px] text-ink-secondary">
          Direct reports: <span className="font-bold text-ink">{detail.data?.direct_count ?? 0}</span>
          {" · "}
          Total downline (incl. indirect): <span className="font-bold text-ink">{detail.data?.subtree_count ?? 0}</span>
          <p className="mt-2 text-ink-muted">A visual org tree is coming soon.</p>
        </div>
      )}

      {rep && tab === "performance" && (
        // TODO: performance metrics — Orders YTD / Revenue YTD / Avg Order
        // Value / Outstanding + 12-month line chart. Wire up when the
        // sales_entries roll-up endpoint exists.
        <EmptyState
          message="Performance metrics coming soon"
          description="Orders, revenue and outstanding roll-ups will appear here once the reporting endpoint is live."
        />
      )}

      {rep && tab === "audit" && (
        <div className="rounded-md border border-border bg-surface">
          {(activityQ.data?.data ?? []).length === 0 ? (
            <div className="p-6 text-[12px] text-ink-muted">No audit entries.</div>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {(activityQ.data?.data ?? []).map((a) => (
                <li key={a.id} className="px-4 py-2 text-[12px]">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                      {a.action}
                    </span>
                    {a.from_value && (
                      <span className="text-ink-muted">{a.from_value}</span>
                    )}
                    {a.from_value && a.to_value && (
                      <span className="text-ink-muted">→</span>
                    )}
                    {a.to_value && (
                      <span className="font-semibold text-ink">{a.to_value}</span>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-ink-muted">
                      {formatDateTime(a.created_at)}
                    </span>
                  </div>
                  {a.note && (
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                      {a.note}
                    </div>
                  )}
                  {a.user_name && (
                    <div className="text-[10px] text-ink-muted">
                      by {a.user_name}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Danger zone */}
      {rep && canManage && tab === "overview" && (
        <div className="mt-6 rounded-md border border-err/40 bg-err/5 p-4">
          <h3 className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-err">
            <ShieldCheck size={12} /> Danger Zone
          </h3>
          <p className="mb-3 text-[11.5px] text-ink-secondary">
            Soft delete preserves orders that reference this rep — they keep their
            link even after delete.
          </p>
          <button
            onClick={async () => {
              if (
                !window.confirm(
                  `Soft-delete ${rep.name}? Their orders keep the reference. You can restore by clearing archived_at directly in the DB.`,
                )
              )
                return;
              try {
                await api.del(`/api/sales-team/reps/${id}`);
                toast.success("Rep archived");
                navigate("/sales-team");
              } catch (e: any) {
                toast.error(e?.message || "Failed");
              }
            }}
            className="rounded-md border border-err bg-surface px-3 py-1.5 text-[11px] font-semibold text-err hover:bg-err hover:text-white"
          >
            Soft delete
          </button>
        </div>
      )}
    </DetailLayout>
  );
}

// ── Overview tab ──────────────────────────────────────────────

function OverviewTab({
  rep,
  positions,
  tiers,
  canManage,
  onPatch,
}: {
  rep: SalesRep;
  positions: SalesPosition[];
  tiers: SalesCommissionTier[];
  canManage: boolean;
  onPatch: (body: Record<string, any>) => Promise<void>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section className="rounded-md border border-border bg-surface p-5 shadow-stone">
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-accent">
          Profile
        </h3>
        <div className="space-y-3 text-[12.5px]">
          <Field label="Code" value={rep.code} />
          <Field
            label="Name"
            value={rep.name}
            editable={canManage}
            onSave={(v) => onPatch({ name: v })}
          />
          <Field
            label="Phone"
            value={rep.phone}
            editable={canManage}
            onSave={(v) => onPatch({ phone: v || null })}
          />
          <Field
            label="Email"
            value={rep.email}
            editable={canManage}
            onSave={(v) => onPatch({ email: v || null })}
          />
          <Field
            label="Joined"
            value={rep.joined_on ? formatDate(rep.joined_on) : "—"}
          />
        </div>
      </section>

      <section className="rounded-md border border-border bg-surface p-5 shadow-stone">
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-accent">
          Position & hierarchy
        </h3>
        <div className="space-y-3 text-[12.5px]">
          <SelectField
            label="Position"
            value={rep.position_id}
            options={positions.map((p) => ({ value: p.id, label: p.name }))}
            disabled={!canManage}
            onChange={(v) => onPatch({ position_id: v })}
          />
          <Field
            label="Report to"
            value={rep.upline_name ?? "(none)"}
            help="Change via the org chart drag handle"
          />
          <SelectField
            label="Commission tier"
            value={rep.commission_tier_id}
            options={tiers.map((t) => ({
              value: t.id,
              label: `${t.name} (${t.rate}%)`,
            }))}
            disabled={!canManage}
            onChange={(v) => onPatch({ commission_tier_id: v })}
          />
          <Field
            label="Override rate"
            value={rep.commission_rate != null ? `${rep.commission_rate}%` : "—"}
            editable={canManage}
            onSave={(v) => {
              const trimmed = v.trim();
              if (!trimmed) {
                onPatch({ commission_rate: null });
                return;
              }
              const n = parseFloat(trimmed);
              if (Number.isFinite(n)) onPatch({ commission_rate: n });
            }}
          />
          <SelectField
            label="Status"
            value={rep.status}
            options={[
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ]}
            disabled={!canManage}
            onChange={(v) => onPatch({ status: v })}
          />
        </div>
      </section>

      <section className="rounded-md border border-border bg-surface p-5 shadow-stone xl:col-span-2">
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-accent">
          Brands
        </h3>
        <div className="flex flex-wrap gap-2">
          {rep.brands.length === 0 && (
            <span className="text-[11.5px] text-ink-muted">
              No brands assigned.
            </span>
          )}
          {rep.brands.map((b) => (
            <span
              key={b}
              className="rounded-full border border-border bg-bg/60 px-2 py-0.5 text-[11px] font-semibold text-ink"
            >
              {b}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[10.5px] text-ink-muted">
          Edit the assigned brands on the main Sales Team list (admins only).
        </p>
      </section>

      {rep.user_id != null && (
        <section className="rounded-md border border-accent/30 bg-accent-soft/30 p-5 xl:col-span-2">
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-accent">
            Workspace user link
          </h3>
          <p className="text-[12px] text-ink-secondary">
            Linked to workspace user{" "}
            <span className="font-semibold text-ink">
              {rep.user_name ?? rep.user_email ?? `#${rep.user_id}`}
            </span>
            .
          </p>
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  editable,
  onSave,
  help,
}: {
  label: string;
  value: string | null | undefined;
  editable?: boolean;
  onSave?: (v: string) => void;
  help?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing && editable && onSave) {
    return (
      <div>
        <Label>{label}</Label>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== value) onSave(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setEditing(false);
              if (draft !== value) onSave(draft);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          className="w-full rounded-md border border-accent bg-surface px-2 py-1 text-[12.5px] outline-none"
        />
      </div>
    );
  }
  return (
    <div
      onClick={() => {
        if (editable && onSave) {
          setDraft(value ?? "");
          setEditing(true);
        }
      }}
      className={cn(editable && "cursor-pointer hover:bg-bg/40 rounded -mx-2 px-2 py-1")}
    >
      <Label>{label}</Label>
      <div className="text-ink">{value || "—"}</div>
      {help && <div className="mt-0.5 text-[10px] text-ink-muted">{help}</div>}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: any;
  options: { value: any; label: string }[];
  disabled?: boolean;
  onChange?: (v: any) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => {
          if (!onChange) return;
          const v = e.target.value;
          // Coerce empty → null, numeric strings → number, else passthrough.
          if (v === "") onChange(null);
          else if (/^\d+$/.test(v)) onChange(parseInt(v, 10));
          else onChange(v);
        }}
        className="h-9 w-full rounded-md border border-border bg-surface px-2 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg disabled:text-ink-muted"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={String(o.value)} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
      {children}
    </div>
  );
}
