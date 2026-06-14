import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  UserPlus,
  Users,
  Mail,
  Building2,
  Briefcase,
  ListTree,
  ChevronRight,
  Clock,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { DashboardBreakdown, DashboardPanels } from "../components/Dashboard";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";
import { InvitePanel } from "./Team";
import type {
  TeamMember,
  Department,
  Position,
  Invitation,
  Role,
} from "../types";

/**
 * System Dashboard — the People area's at-a-glance home and the central
 * invite hub. Reads the same endpoints as User Management (no new backend
 * surface) and reuses Team's <InvitePanel> so inviting from here is
 * identical to inviting from the Members tab. Gated by the existing
 * `team` page-access; the Invite action needs `users.manage`.
 */

type StatTone = "neutral" | "accent" | "warning";

// Mirrors Overview's HeroKpiCard so the two dashboards read as one family,
// without coupling SystemDashboard to the Overview module.
function StatCard({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  tone?: StatTone;
}) {
  const accentBar = {
    neutral: "bg-border",
    accent: "bg-accent",
    warning: "bg-amber-500",
  }[tone];
  const valueClass = {
    neutral: "text-ink",
    accent: "text-accent",
    warning: "text-amber-700",
  }[tone];
  const iconClass = {
    neutral: "text-ink-muted",
    accent: "text-accent",
    warning: "text-amber-600",
  }[tone];
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-3 shadow-stone">
      <span
        className={cn("absolute left-0 top-0 h-full w-[3px]", accentBar)}
        aria-hidden
      />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        <span className={iconClass}>{icon}</span>
        <span>{label}</span>
      </div>
      <div
        className={cn(
          "mt-1.5 font-display text-[22px] font-extrabold leading-none tracking-tight",
          valueClass
        )}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {sub && <div className="mt-1 text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

function QuickLink({
  to,
  icon,
  label,
  sub,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-stone transition-colors hover:border-accent/40 hover:bg-accent-soft/15"
    >
      <span className="text-accent/80 transition-colors group-hover:text-accent">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-ink">{label}</div>
        <div className="text-[10.5px] text-ink-muted">{sub}</div>
      </div>
      <ChevronRight
        size={14}
        className="shrink-0 text-accent opacity-0 transition-opacity group-hover:opacity-100"
      />
    </Link>
  );
}

export function SystemDashboard() {
  const { can } = useAuth();
  const canManage = can("users.manage");

  const members = useQuery<{ users: TeamMember[] }>(() => api.get("/api/users"));
  const invites = useQuery<{ invitations: Invitation[] }>(() =>
    api.get("/api/users/invitations")
  );
  const depts = useQuery<{ departments: Department[] }>(() =>
    api.get("/api/departments")
  );
  const positions = useQuery<{ positions: Position[] }>(() =>
    api.get("/api/positions")
  );
  // Only needed to seed InvitePanel's hidden default role (role UI is gone).
  const roles = useQuery<{ roles: Role[] }>(() => api.get("/api/roles"));

  const [inviteOpen, setInviteOpen] = useState(false);

  const users = members.data?.users ?? [];
  const active = useMemo(
    () => users.filter((u) => u.status === "active"),
    [users]
  );
  const disabledCount = users.filter((u) => u.status === "disabled").length;
  const pending = (invites.data?.invitations ?? []).filter(
    (i) => !i.accepted_at
  );

  // Headcount distributions are computed from the live user list (not the
  // backend member_count fields) so they always match the KPI above and
  // surface an "Unassigned" bucket the count columns can't.
  const byDept = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of active) {
      m.set(
        u.department_name || "Unassigned",
        (m.get(u.department_name || "Unassigned") ?? 0) + 1
      );
    }
    return [...m.entries()]
      .map(([label, count]) => ({
        label,
        count,
        tone: label === "Unassigned" ? ("warn" as const) : ("default" as const),
      }))
      .sort((a, b) => b.count - a.count);
  }, [active]);

  const byPosition = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of active) {
      m.set(
        u.position_name || "No position",
        (m.get(u.position_name || "No position") ?? 0) + 1
      );
    }
    return [...m.entries()]
      .map(([label, count]) => ({
        label,
        count,
        tone:
          label === "No position" ? ("warn" as const) : ("default" as const),
      }))
      .sort((a, b) => b.count - a.count);
  }, [active]);

  const recentSignins = useMemo(
    () =>
      active
        .filter((u) => u.last_login_at)
        .sort((a, b) => (b.last_login_at! > a.last_login_at! ? 1 : -1))
        .slice(0, 6),
    [active]
  );

  const deptCount = depts.data?.departments.length ?? null;
  const positionCount =
    positions.data?.positions.filter((p) => p.active).length ?? null;

  const loading = members.loading && users.length === 0;

  return (
    <div>
      <PageHeader
        eyebrow="People · System"
        title="System Dashboard"
        description="Headcount, structure, and pending invitations at a glance — and the place to invite new people."
        actions={
          canManage ? (
            <Button
              variant="brass"
              icon={<UserPlus size={14} />}
              onClick={() => setInviteOpen(true)}
            >
              Invite Member
            </Button>
          ) : null
        }
      />

      {members.error ? (
        <div className="text-[12px] text-err">{members.error}</div>
      ) : loading ? (
        <ListSkeleton rows={4} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              icon={<Users size={14} />}
              label="Active members"
              value={active.length}
              sub={disabledCount ? `${disabledCount} disabled` : "Workspace logins"}
              tone="accent"
            />
            <StatCard
              icon={<Mail size={14} />}
              label="Pending invites"
              value={pending.length}
              sub={pending.length ? "Awaiting acceptance" : "All accepted"}
              tone={pending.length ? "warning" : "neutral"}
            />
            <StatCard
              icon={<Building2 size={14} />}
              label="Departments"
              value={deptCount ?? "—"}
              sub="Defined"
            />
            <StatCard
              icon={<Briefcase size={14} />}
              label="Positions"
              value={positionCount ?? "—"}
              sub="Active roles"
            />
          </div>

          <DashboardPanels cols={2}>
            <DashboardBreakdown
              title="Headcount by department"
              items={byDept}
              emptyLabel="No active members"
            />
            <DashboardBreakdown
              title="Headcount by position"
              items={byPosition}
              emptyLabel="No active members"
            />
          </DashboardPanels>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
              <div className="mb-4 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Manage
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <QuickLink
                  to="/team?tab=members"
                  icon={<Users size={15} />}
                  label="Members"
                  sub={`${active.length} active`}
                />
                <QuickLink
                  to="/team?tab=orgchart"
                  icon={<ListTree size={15} />}
                  label="Org Chart"
                  sub="Reporting tree"
                />
                <QuickLink
                  to="/team?tab=positions"
                  icon={<Briefcase size={15} />}
                  label="Positions"
                  sub="Page access matrix"
                />
                <QuickLink
                  to="/team?tab=departments"
                  icon={<Building2 size={15} />}
                  label="Departments"
                  sub={`${deptCount ?? 0} defined`}
                />
              </div>
            </div>

            {pending.length > 0 ? (
              <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
                <div className="mb-4 flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    Pending invitations
                  </div>
                  <Link
                    to="/team?tab=members"
                    className="text-[10.5px] font-semibold text-accent hover:underline"
                  >
                    Manage
                  </Link>
                </div>
                <ul className="space-y-2.5">
                  {pending.slice(0, 6).map((inv) => (
                    <li
                      key={inv.id}
                      className="flex items-center justify-between gap-3 text-[12px]"
                    >
                      <span className="truncate text-ink-secondary">
                        {inv.email}
                      </span>
                      <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">
                        {inv.email_status === "sent"
                          ? "Emailed"
                          : inv.email_status === "error"
                          ? "Email failed"
                          : "Link only"}
                      </span>
                    </li>
                  ))}
                </ul>
                {pending.length > 6 && (
                  <div className="mt-3 text-[10.5px] text-ink-muted">
                    +{pending.length - 6} more
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
                <div className="mb-4 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Recent sign-ins
                </div>
                {recentSignins.length === 0 ? (
                  <div className="text-[12px] text-ink-muted">
                    No sign-ins recorded yet.
                  </div>
                ) : (
                  <ul className="space-y-2.5">
                    {recentSignins.map((u) => (
                      <li
                        key={u.id}
                        className="flex items-center justify-between gap-3 text-[12px]"
                      >
                        <span className="truncate font-medium text-ink-secondary">
                          {u.name || u.email}
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-ink-muted">
                          <Clock size={11} />
                          {relativeTime(u.last_login_at!)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {canManage && (
        <InvitePanel
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          roles={roles.data?.roles ?? []}
          departments={depts.data?.departments ?? []}
          positions={positions.data?.positions ?? []}
          members={users}
          onInvited={() => {
            setInviteOpen(false);
            members.reload();
            invites.reload();
          }}
        />
      )}
    </div>
  );
}
