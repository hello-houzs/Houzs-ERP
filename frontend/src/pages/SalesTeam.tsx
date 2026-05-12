import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  Settings as SettingsIcon,
  ShieldCheck,
  Search,
  List as ListIcon,
  GitBranch,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { StatCard } from "../components/StatCard";
import { DashboardGrid } from "../components/Dashboard";
import { Avatar } from "../components/Avatar";
import { HierarchyTree, expandAllIds, collapseAllIds } from "../components/HierarchyTree";
import { OrgChartView } from "../components/OrgChartView";
import { SalesRepEditPanel } from "../components/SalesRepEditPanel";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useAuth } from "../auth/AuthContext";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import type { SalesRep, SalesPosition } from "../types";

interface BrandRow {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  active: number;
}

const SALES_TEAM_FILTER_KEYS = ["status", "position", "brand", "q", "view"] as const;

/**
 * Sales Team — retail-rep org chart, separate from /team. Renders as
 * an indented tree by default (matches the boss's mockup); toggle to
 * "Org Chart" for a top-down graphical view. Click any rep to open
 * the edit panel.
 */
export function SalesTeam() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  const { can } = useAuth();
  const canManage = can("sales_team.manage");
  const [params, setParams] = useStickyFilters("sales-team", SALES_TEAM_FILTER_KEYS);
  const status = params.get("status") || "";
  const position = params.get("position") || "";
  const brand = params.get("brand") || "";
  const q = params.get("q") || "";
  const view = params.get("view") === "tree" ? "tree" : "list";
  const [editingRep, setEditingRep] = useState<SalesRep | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expandTouched, setExpandTouched] = useState(false);

  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (position) p.set("position", position);
    if (brand) p.set("brand", brand);
    if (q) p.set("q", q);
    return p.toString();
  }, [status, position, brand, q]);

  const reps = useQuery<{ data: SalesRep[] }>(
    () => api.get(`/api/sales-team/reps${qs ? `?${qs}` : ""}`),
    [qs],
  );
  const positions = useQuery<{ data: SalesPosition[] }>(() =>
    api.get("/api/sales-team/lookups/positions"),
  );
  const brandsQ = useQuery<{ data: BrandRow[] }>(() =>
    api.get("/api/projects/brands?full=1"),
  );

  const brandHex = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of brandsQ.data?.data ?? []) m.set(b.name, `#${b.color}`);
    return m;
  }, [brandsQ.data]);

  const all = reps.data?.data ?? [];

  // Filtering may break the hierarchy (a parent could be filtered out
  // while its children stay). Show everyone whose subtree contains
  // ≥1 visible rep so the tree stays connected.
  const filtered = all;

  // Default expanded: all on first load, until the user touches the
  // expand controls. Then their preference takes over.
  const effectiveExpanded = useMemo(() => {
    if (expandTouched) return expanded;
    return expandAllIds(filtered);
  }, [expanded, expandTouched, filtered]);

  const totals = useMemo(() => {
    const directors = all.filter((r) => r.position_level === 10).length;
    const admins = all.filter((r) => r.is_admin === 1).length;
    const active = all.filter((r) => r.status === "active").length;
    const brandSet = new Set<string>();
    for (const r of all) for (const b of r.brands) brandSet.add(b);
    return {
      total: all.length,
      active,
      directors,
      admins,
      managers: all.filter((r) => r.position_level === 15).length,
      executives: all.filter((r) => r.position_level === 20).length,
      salesPersons: all.filter((r) => r.position_level === 25).length,
      subExecutives: all.filter((r) => r.position_level === 30).length,
      brandsAssigned: brandSet.size,
    };
  }, [all]);

  async function toggleAdmin(rep: SalesRep) {
    const wantAdmin = rep.is_admin !== 1;
    if (
      !(await dialog.confirm({
        title: wantAdmin ? "Make admin?" : "Remove admin?",
        message: wantAdmin
          ? `${rep.name} will be able to edit any rep in their hierarchy. Continue?`
          : `${rep.name} will lose admin permissions and only see their own subtree. Continue?`,
        danger: !wantAdmin,
      }))
    )
      return;
    try {
      await api.put(`/api/sales-team/reps/${rep.id}/admin`, { is_admin: wantAdmin });
      toast.success(wantAdmin ? "Admin granted" : "Admin removed");
      reps.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  function expandAll() {
    setExpandTouched(true);
    setExpanded(expandAllIds(filtered));
  }
  function collapseAll() {
    setExpandTouched(true);
    setExpanded(collapseAllIds());
  }

  // Sort siblings by position level (Director first), then by code.
  function sortChildren(a: SalesRep, b: SalesRep) {
    const al = a.position_level ?? 999;
    const bl = b.position_level ?? 999;
    if (al !== bl) return al - bl;
    return a.code.localeCompare(b.code);
  }

  // Row content (right of chevron) — used by both List and Org Chart.
  function renderRepRow(r: SalesRep, opts: { compact?: boolean } = {}) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative shrink-0">
          <Avatar userId={r.user_id} name={r.name} size={opts.compact ? 28 : 32} />
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-surface",
              r.status === "active" ? "bg-synced" : "bg-ink-muted",
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate font-display text-[13px] font-bold uppercase text-ink">
              {r.name}
            </span>
            {!opts.compact && (
              <span className="font-mono text-[10px] text-ink-muted">{r.code}</span>
            )}
          </div>
          {!opts.compact && (
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-ink-secondary">
              {r.phone && <span className="font-mono">{r.phone}</span>}
              {r.email && <span className="truncate">{r.email}</span>}
            </div>
          )}
        </div>
        {!opts.compact && (
          <div className="hidden shrink-0 flex-wrap items-center gap-1 sm:flex">
            {r.brands.map((b) => {
              const hex = brandHex.get(b);
              const short =
                b.replace(/[^A-Z]/g, "").slice(0, 3) ||
                b.slice(0, 3).toUpperCase();
              return (
                <span
                  key={b}
                  title={b}
                  aria-label={`Brand ${b}`}
                  style={hex ? { backgroundColor: hex, color: "white" } : undefined}
                  className="rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                >
                  {short}
                </span>
              );
            })}
          </div>
        )}
        {r.is_admin === 1 && (
          <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-800">
            Admin
          </span>
        )}
        <span
          className={cn(
            "shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            r.position_level === 10 && "bg-amber-100 text-amber-800 border border-amber-300",
            r.position_level === 15 && "bg-rose-50 text-rose-800 border border-rose-200",
            r.position_level === 20 && "bg-blue-50 text-blue-800 border border-blue-200",
            r.position_level === 25 && "bg-emerald-50 text-emerald-800 border border-emerald-200",
            r.position_level === 30 && "bg-purple-50 text-purple-800 border border-purple-200",
            r.position_level == null && "bg-bg text-ink-muted",
          )}
        >
          {r.position_name ?? "—"}
        </span>
        {(r.team_size ?? 0) > 0 && !opts.compact && (
          <span
            className="shrink-0 font-mono text-[10px] text-ink-muted"
            title={`${r.team_size} downline`}
          >
            {r.team_size}
          </span>
        )}
        {canManage && !opts.compact && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleAdmin(r);
            }}
            className={cn(
              "shrink-0 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
              r.is_admin
                ? "border-err/40 text-err hover:bg-err/10"
                : "border-border text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            <ShieldCheck size={10} className="inline" />{" "}
            {r.is_admin ? "Remove" : "Make"} admin
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Workspace · Sales"
        title="Sales Team"
        description="Organisation chart, position, brand assignment & commission."
        primaryAction={
          canManage ? (
            <Button
              variant="brass"
              icon={<Plus size={14} />}
              onClick={() =>
                toast.info("Register Member modal lands in slice 4")
              }
            >
              Register Member
            </Button>
          ) : undefined
        }
        secondaryActions={
          canManage
            ? [
                {
                  icon: SettingsIcon,
                  label: "Settings",
                  onClick: () => navigate("/sales-team-maintenance"),
                },
              ]
            : undefined
        }
      />

      {/* Roles & Permissions panel */}
      <div className="mb-4 rounded-md border border-border bg-surface p-4 shadow-stone">
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <button
            onClick={() => patchParams({ position: "" })}
            className="rounded-md border border-border px-3 py-2 text-left transition-colors hover:border-accent/40"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Administrators
            </div>
            <div className="font-display text-[18px] font-extrabold text-ink">
              {totals.admins}
            </div>
            <div className="text-[10px] text-ink-muted">
              Full access to events, finance, settings
            </div>
          </button>
          <button
            onClick={() => patchParams({ position: "manager" })}
            className="rounded-md border border-border px-3 py-2 text-left transition-colors hover:border-accent/40"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Managers
            </div>
            <div className="font-display text-[18px] font-extrabold text-ink">
              {totals.managers}
            </div>
            <div className="text-[10px] text-ink-muted">
              Oversee a brand cluster
            </div>
          </button>
          <button
            onClick={() => patchParams({ position: "executive" })}
            className="rounded-md border border-border px-3 py-2 text-left transition-colors hover:border-accent/40"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Executives
            </div>
            <div className="font-display text-[18px] font-extrabold text-ink">
              {totals.executives}
            </div>
            <div className="text-[10px] text-ink-muted">
              One brand each
            </div>
          </button>
        </div>
        <p className="text-[10.5px] text-ink-muted">
          Change someone's role by clicking{" "}
          <span className="font-semibold">Edit</span> on their row and selecting a different Position. Toggle{" "}
          <span className="font-semibold">Admin</span> from the row's right edge — admins get full module access.
        </p>
      </div>

      {/* KPI tiles */}
      <DashboardGrid cols={4}>
        <StatCard label="Total Active" value={String(totals.active)} subtitle="Across all positions" />
        <StatCard label="Directors" value={String(totals.directors)} subtitle="Top of the tree" />
        <StatCard
          label="Brand Assigned"
          value={String(totals.brandsAssigned)}
          subtitle="Distinct brands with ≥1 rep"
        />
        <StatCard label="Total Members" value={String(totals.total)} subtitle="Active + inactive" />
      </DashboardGrid>

      {/* Filter row */}
      <div className="my-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-[320px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => patchParams({ q: e.target.value })}
            placeholder="Search name, code, phone, email…"
            className="h-8 w-full rounded-md border border-border bg-surface pl-7 pr-3 text-[11.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
          />
        </div>
        <select
          value={position}
          onChange={(e) => patchParams({ position: e.target.value })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent"
        >
          <option value="">All positions</option>
          {(positions.data?.data ?? []).map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={brand}
          onChange={(e) => patchParams({ brand: e.target.value })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent"
        >
          <option value="">All brands</option>
          {(brandsQ.data?.data ?? []).map((b) => (
            <option key={b.id} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => patchParams({ status: e.target.value })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        {(status || position || brand || q) && (
          <button
            onClick={() => patchParams({ status: "", position: "", brand: "", q: "" })}
            className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
          >
            Clear
          </button>
        )}
        <span className="ml-auto text-[10.5px] font-mono text-ink-muted">
          {totals.total} rep{totals.total === 1 ? "" : "s"}
        </span>
      </div>

      {/* Org chart card with header + view toggle */}
      <div className="rounded-md border border-border bg-surface shadow-stone">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[11px] font-bold uppercase tracking-brand text-ink">
              Organisation Chart
            </h2>
            <p className="mt-0.5 text-[10.5px] text-ink-muted">
              Click to edit · Director → Manager → Executive → Sales Person
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => patchParams({ view: "" })}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition-colors",
                view === "list"
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-surface text-ink-secondary hover:border-accent/40",
              )}
            >
              <ListIcon size={12} /> List
            </button>
            <button
              onClick={() => patchParams({ view: "tree" })}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition-colors",
                view === "tree"
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-surface text-ink-secondary hover:border-accent/40",
              )}
            >
              <GitBranch size={12} /> Org Chart
            </button>
            {view === "list" && (
              <>
                <button
                  onClick={expandAll}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
                  title="Expand all"
                >
                  <ChevronsUpDown size={12} /> Expand
                </button>
                <button
                  onClick={collapseAll}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
                  title="Collapse all"
                >
                  <ChevronsDownUp size={12} /> Collapse
                </button>
              </>
            )}
          </div>
        </div>

        {reps.loading && all.length === 0 && (
          <div className="p-6 text-[12px] text-ink-muted">Loading…</div>
        )}
        {reps.error && (
          <div className="m-4 rounded-md border border-err/40 bg-err/5 px-4 py-3 text-[12px] text-err">
            {reps.error}
          </div>
        )}
        {!reps.loading && all.length === 0 && (
          <div className="p-8 text-center text-[12px] text-ink-muted">
            No reps match these filters.
          </div>
        )}

        {filtered.length > 0 && view === "list" && (
          <HierarchyTree<SalesRep>
            items={filtered}
            getParentId={(r) => r.upline_id}
            sortChildren={sortChildren}
            renderNode={(r) => renderRepRow(r)}
            onRowClick={(r) => setEditingRep(r)}
            expanded={effectiveExpanded}
            setExpanded={(s) => {
              setExpandTouched(true);
              setExpanded(s);
            }}
          />
        )}

        {filtered.length > 0 && view === "tree" && (
          <OrgChartView<SalesRep>
            items={filtered}
            getParentId={(r) => r.upline_id}
            sortChildren={sortChildren}
            renderNode={(r) => (
              <div className="min-w-[200px]">{renderRepRow(r, { compact: true })}</div>
            )}
            onNodeClick={(r) => setEditingRep(r)}
          />
        )}
      </div>

      {editingRep && (
        <SalesRepEditPanel
          rep={editingRep}
          allReps={all}
          canManage={canManage}
          onClose={() => setEditingRep(null)}
          onSaved={() => {
            reps.reload();
          }}
        />
      )}
    </div>
  );
}
