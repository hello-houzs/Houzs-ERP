import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Copy, Trash2, UserX, UserCheck, X, KeyRound, Pencil, Check, Tag, RefreshCw, Search, ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { Button } from "../components/Button";
import { ColorPicker } from "../components/ColorPicker";
import { Panel, PanelSection } from "../components/Panel";
import { StatusDot } from "../components/StatusDot";
import { Avatar } from "../components/Avatar";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { Skeleton, ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { relativeTime, cn } from "../lib/utils";
import type { TeamMember, Invitation, Role, Department, Position } from "../types";
import { RolesTab } from "./Roles";
import { PositionsTab } from "./Positions";

type TeamTabValue = "members" | "positions" | "roles" | "orgchart" | "departments";

const TEAM_KEYS = ["tab"] as const;

/**
 * Unified Team page — two tabs (Members, Roles) sharing a single header.
 * Members lists users + pending invitations and lets admins invite /
 * reset / disable / remove. Roles is a grid of role cards with an editor
 * panel for permissions.
 *
 * The wrapper owns the primary action button for each tab (Invite Member
 * / New Role) so they live consistently in the PageHeader's `actions`
 * slot — not duplicated inside each tab body.
 */
export function Team() {
  const { can } = useAuth();
  const [params, setParams] = useStickyFilters("team", TEAM_KEYS);

  const canUsers = can("users.read");
  const canRoles = can("roles.read");
  const canManageUsers = can("users.manage");
  const canManageRoles = can("roles.manage");

  const raw = params.get("tab") as TeamTabValue | null;
  const active: TeamTabValue =
    raw && ["members", "positions", "roles", "orgchart", "departments"].includes(raw)
      ? raw
      : canUsers
      ? "members"
      : "roles";

  function setTab(next: TeamTabValue) {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p, { replace: true });
  }

  const [inviteOpen, setInviteOpen] = useState(false);
  const [creatingRole, setCreatingRole] = useState(false);
  const [creatingDept, setCreatingDept] = useState(false);

  const tabs: TabOption<TeamTabValue>[] = [
    { value: "members", label: "Members", show: canUsers },
    { value: "positions", label: "Positions", show: canManageUsers },
    { value: "orgchart", label: "Org Chart", show: canUsers },
    { value: "departments", label: "Departments", show: canUsers },
    { value: "roles", label: "Roles", show: canRoles },
  ];

  const TAB_HEADER: Record<
    TeamTabValue,
    { eyebrow: string; title: string; description: string }
  > = {
    members: {
      eyebrow: "Workspace · Members",
      title: "Members",
      description: "Manage who can access this workspace and what they can do.",
    },
    positions: {
      eyebrow: "Workspace · Access by Position",
      title: "Positions",
      description:
        "Set which pages each position can see (none / view / edit / full). This drives the menu and blocks direct-URL access — a member only ever sees their position's pages.",
    },
    orgchart: {
      eyebrow: "Workspace · Hierarchy",
      title: "Org Chart",
      description:
        "Who reports to whom. Reporting lines drive project access — a user sees projects where they or their manager is the PIC (when their role is scoped).",
    },
    departments: {
      eyebrow: "Workspace · Teams",
      title: "Departments",
      description:
        "Groupings for visibility only — colour-codes the org chart and tags members. Access control still runs through roles + reporting lines.",
    },
    roles: {
      eyebrow: "Workspace · Access Control",
      title: "Roles",
      description:
        "Define what each role can access. System roles are locked; create custom roles for fine-grained control.",
    },
  };

  const actions =
    active === "members" ? (
      canManageUsers ? (
        <Button
          variant="brass"
          icon={<Plus size={14} />}
          onClick={() => setInviteOpen(true)}
        >
          Invite Member
        </Button>
      ) : null
    ) : active === "departments" ? (
      canManageUsers ? (
        <Button
          variant="brass"
          icon={<Plus size={14} />}
          onClick={() => setCreatingDept(true)}
        >
          New Department
        </Button>
      ) : null
    ) : active === "roles" ? (
      canManageRoles ? (
        <Button
          variant="brass"
          icon={<Plus size={14} />}
          onClick={() => setCreatingRole(true)}
        >
          New Role
        </Button>
      ) : null
    ) : null;

  return (
    <div>
      <TabStrip<TeamTabValue>
        value={active}
        onChange={setTab}
        options={tabs}
      />

      <PageHeader
        eyebrow={TAB_HEADER[active].eyebrow}
        title={TAB_HEADER[active].title}
        description={TAB_HEADER[active].description}
        actions={actions}
      />

      {active === "members" && canUsers && (
        <MembersTab
          inviteOpen={inviteOpen}
          onCloseInvite={() => setInviteOpen(false)}
        />
      )}
      {active === "positions" && canManageUsers && <PositionsTab />}
      {active === "orgchart" && canUsers && <OrgChartTab />}
      {active === "departments" && canUsers && (
        <DepartmentsTab
          creating={creatingDept}
          onCloseCreate={() => setCreatingDept(false)}
        />
      )}
      {active === "roles" && canRoles && (
        <RolesTab
          creating={creatingRole}
          onCloseCreate={() => setCreatingRole(false)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Members tab — active users + pending invitations
// ──────────────────────────────────────────────────────────
function MembersTab({
  inviteOpen,
  onCloseInvite,
}: {
  inviteOpen: boolean;
  onCloseInvite: () => void;
}) {
  const { user: me, can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();

  const members = useQuery<{ users: TeamMember[] }>(() => api.get("/api/users"));
  const invites = useQuery<{ invitations: Invitation[] }>(() =>
    api.get("/api/users/invitations")
  );
  const roles = useQuery<{ roles: Role[] }>(() => api.get("/api/roles"));
  const depts = useQuery<{ departments: Department[] }>(() =>
    api.get("/api/departments")
  );
  const positions = useQuery<{ positions: Position[] }>(() =>
    api.get("/api/positions")
  );

  // Members-list filters (owner ask: filter/sort by department and/or position).
  const [filterDept, setFilterDept] = useState<number | "">("");
  const [filterPos, setFilterPos] = useState<number | "">("");
  const [searchQ, setSearchQ] = useState("");
  const [sortKey, setSortKey] = useState<
    "name" | "department" | "position" | "last_seen"
  >("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Per-user brand picker — opens a small modal scoped to one member.
  const [brandsFor, setBrandsFor] = useState<TeamMember | null>(null);
  // Invitation row whose resend is in flight (spinner + disable).
  const [resendingId, setResendingId] = useState<number | null>(null);

  const canManage = can("users.manage");

  function reload() {
    members.reload();
    invites.reload();
  }

  async function changeRole(u: TeamMember, role_id: number) {
    try {
      await api.patch(`/api/users/${u.id}`, { role_id });
      toast.success(`Role updated for ${u.email}`);
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function changeManager(u: TeamMember, manager_id: number | null) {
    try {
      await api.patch(`/api/users/${u.id}`, { manager_id });
      toast.success(
        manager_id
          ? `${u.email} now reports to ${members.data?.users.find((x) => x.id === manager_id)?.name ?? "manager"}`
          : `${u.email} is no longer reporting to anyone`
      );
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function changeDepartment(u: TeamMember, department_id: number | null) {
    try {
      await api.patch(`/api/users/${u.id}`, { department_id });
      const name = department_id
        ? depts.data?.departments.find((d) => d.id === department_id)?.name
        : null;
      toast.success(
        name ? `${u.email} → ${name}` : `${u.email} removed from department`
      );
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function changePosition(u: TeamMember, position_id: number | null) {
    try {
      await api.patch(`/api/users/${u.id}`, { position_id });
      const name = position_id
        ? positions.data?.positions.find((p) => p.id === position_id)?.name
        : null;
      // Position can auto-set the department server-side — reload both.
      toast.success(name ? `${u.email} → ${name}` : `${u.email} position cleared`);
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function sendReset(u: TeamMember) {
    if (
      !(await dialog.confirm(
        `Send a password reset link to ${u.email}?\n\nTheir current password will keep working until they complete the reset. Active sessions will be logged out.`
      ))
    )
      return;
    try {
      const res = await api.post<{
        ok: boolean;
        token: string;
        reset_path: string;
        expires_at: string;
        email: string;
        email_sent?: boolean;
        email_status?: string;
      }>(`/api/users/${u.id}/reset-password`);
      const link = `${window.location.origin}${res.reset_path}`;
      const copied = await navigator.clipboard
        .writeText(link)
        .then(() => true)
        .catch(() => false);
      if (res.email_sent) {
        toast.success(
          copied
            ? `Reset link emailed to ${u.email} and copied to clipboard`
            : `Reset link emailed to ${u.email}`
        );
      } else if (copied) {
        toast.success(
          `Email not sent (${res.email_status || "check Settings, Email"}) — reset link copied to clipboard instead`
        );
      } else {
        toast.error(
          `Email not sent (${res.email_status || "check Settings, Email"}) and clipboard unavailable`
        );
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to send reset");
    }
  }

  async function toggleStatus(u: TeamMember) {
    const next = u.status === "active" ? "disabled" : "active";
    try {
      await api.patch(`/api/users/${u.id}`, { status: next });
      toast.success(`${u.email} ${next === "active" ? "enabled" : "disabled"}`);
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function removeUser(u: TeamMember) {
    // True hard-delete via ?hard=1. Backend errors out with a helpful
    // message if FK references block it; in that case the admin should
    // use the Disable button (soft-delete) instead.
    const confirmed = await dialog.confirm(
      `Permanently delete ${u.email}?\n\n` +
        "This wipes their account, sessions, audit log entries, and engagement history. " +
        "Trips, sales entries, and projects they created may block the delete — " +
        "use Disable instead for users with real activity.",
    );
    if (!confirmed) return;
    try {
      await api.del(`/api/users/${u.id}?hard=1`);
      toast.success(`${u.email} permanently deleted`);
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function revokeInvite(inv: Invitation) {
    if (!(await dialog.confirm(`Revoke invitation for ${inv.email}?`))) return;
    try {
      await api.del(`/api/users/invitations/${inv.id}`);
      toast.success("Invitation revoked");
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  function copyInviteLink(inv: Invitation) {
    // Prefer the server-built canonical link (PUBLIC_APP_URL) so copied
    // links always carry erp.houzscentury.com regardless of which origin
    // the admin's browser is on.
    const link = inv.invite_url || `${window.location.origin}/#invite=${inv.token}`;
    navigator.clipboard.writeText(link).then(
      () => toast.success("Invite link copied to clipboard"),
      () => toast.error("Could not access clipboard")
    );
  }

  async function resendInvite(inv: Invitation) {
    setResendingId(inv.id);
    try {
      const res = await api.post<{
        ok: boolean;
        email_sent: boolean;
        email_status?: string;
      }>(`/api/users/invitations/${inv.id}/resend`);
      if (res.email_sent) {
        toast.success(`Invitation emailed to ${inv.email}`);
      } else {
        toast.error(
          `Email not sent (${res.email_status || "check Settings, Email"}) — use Copy Link instead`
        );
      }
      invites.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to resend invitation");
    } finally {
      setResendingId(null);
    }
  }

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }
  const posNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of positions.data?.positions ?? []) m.set(p.id, p.name);
    return m;
  }, [positions.data]);
  const memberHeaders: { key: typeof sortKey; label: string }[] = [
    { key: "name", label: "Member" },
    { key: "department", label: "Department" },
    { key: "position", label: "Position" },
    { key: "last_seen", label: "Last Seen" },
  ];
  const filteredMembers = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    const rows = (members.data?.users ?? []).filter(
      (u) =>
        (filterDept === "" || u.department_id === filterDept) &&
        (filterPos === "" || u.position_id === filterPos) &&
        (q === "" ||
          (u.name || "").toLowerCase().includes(q) ||
          (u.email || "").toLowerCase().includes(q)),
    );
    const dir = sortDir === "asc" ? 1 : -1;
    const keyVal = (u: TeamMember): string => {
      switch (sortKey) {
        case "department":
          return (u.department_name || "").toLowerCase();
        case "position":
          return (u.position_id != null ? posNameById.get(u.position_id) || "" : "").toLowerCase();
        case "last_seen":
          return u.last_login_at || "";
        default:
          return (u.name || u.email || "").toLowerCase();
      }
    };
    return [...rows].sort((a, b) => {
      const av = keyVal(a);
      const bv = keyVal(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [members.data, filterDept, filterPos, searchQ, sortKey, sortDir, posNameById]);

  return (
    <div>
      {/* Active members */}
      <div className="mb-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Members ({filteredMembers.length}/{members.data?.users.length ?? 0})
          </h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
              />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search name or email…"
                className="h-7 w-44 rounded-md border border-border bg-surface pl-7 pr-2 text-[11px] text-ink outline-none placeholder:text-ink-muted hover:border-accent/50 focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>
            <select
              value={filterDept}
              onChange={(e) => {
                setFilterDept(e.target.value ? Number(e.target.value) : "");
                setFilterPos("");
              }}
              title="Filter by department"
              className="h-7 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none hover:border-accent/50 focus:border-accent"
            >
              <option value="">All departments</option>
              {depts.data?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              value={filterPos}
              onChange={(e) => setFilterPos(e.target.value ? Number(e.target.value) : "")}
              title="Filter by position"
              className="h-7 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none hover:border-accent/50 focus:border-accent"
            >
              <option value="">All positions</option>
              {(positions.data?.positions ?? [])
                .filter(
                  (p) => filterDept === "" || !p.department_id || p.department_id === filterDept
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="thin-scroll overflow-x-auto rounded-md border border-border bg-surface shadow-stone">
          <div className="min-w-[860px]">
            {/* Column headers — click to sort */}
            <div className="grid grid-cols-[minmax(170px,1fr)_148px_148px_96px_232px] items-center gap-3 border-b-2 border-border bg-surface-dim px-5 py-2">
              {memberHeaders.map((h) => {
                const active = sortKey === h.key;
                return (
                  <button
                    key={h.key}
                    onClick={() => toggleSort(h.key)}
                    className={cn(
                      "flex items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-brand transition-colors hover:text-accent",
                      active ? "text-accent" : "text-ink-secondary",
                    )}
                  >
                    {h.label}
                    <span className={active ? "opacity-100" : "opacity-30"}>
                      {active ? (
                        sortDir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />
                      ) : (
                        <ChevronsUpDown size={10} />
                      )}
                    </span>
                  </button>
                );
              })}
              <div className="text-right text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                Actions
              </div>
            </div>

            {members.loading && (
              <div className="space-y-2 px-5 py-4">
                <ListSkeleton rows={5} />
              </div>
            )}
            {members.error && (
              <div className="px-5 py-4 text-[13px] text-err">{members.error}</div>
            )}
            {!members.loading && !members.error && filteredMembers.length === 0 && (
              <div className="px-5 py-10 text-center text-[12px] text-ink-muted">
                No members match these filters.
              </div>
            )}

            {filteredMembers.map((u) => {
              const manageable = canManage && u.id !== me?.id;
              return (
                <div
                  key={u.id}
                  className="grid grid-cols-[minmax(170px,1fr)_148px_148px_96px_232px] items-center gap-3 border-b border-border-subtle px-5 py-2.5 transition-colors last:border-b-0 hover:bg-accent-soft/30"
                >
                  {/* Member */}
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar
                      userId={u.id}
                      hasImage={u.profile_pic_r2_key}
                      name={u.name}
                      email={u.email}
                      size={32}
                    />
                    <StatusDot
                      variant={
                        u.status === "active"
                          ? "synced"
                          : u.status === "disabled"
                          ? "error"
                          : "neutral"
                      }
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-ink">
                          {u.name || u.email}
                        </span>
                        {u.id === me?.id && (
                          <span className="shrink-0 rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                            You
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-ink-muted">
                        {u.email}
                        {u.phone ? ` · ${u.phone}` : ""}
                      </div>
                    </div>
                  </div>

                  {/* Department */}
                  {manageable ? (
                    <select
                      value={u.department_id ?? ""}
                      onChange={(e) =>
                        changeDepartment(u, e.target.value ? Number(e.target.value) : null)
                      }
                      title="Department"
                      style={
                        u.department_color
                          ? { borderLeft: `3px solid #${u.department_color}` }
                          : undefined
                      }
                      className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none transition-colors hover:border-accent/50 focus:border-accent focus:ring-2 focus:ring-accent/20"
                    >
                      <option value="">— None —</option>
                      {depts.data?.departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="truncate text-[12px] text-ink-secondary">
                      {u.department_name || "—"}
                    </span>
                  )}

                  {/* Position */}
                  {manageable ? (
                    <select
                      value={u.position_id ?? ""}
                      onChange={(e) =>
                        changePosition(u, e.target.value ? Number(e.target.value) : null)
                      }
                      title="Position"
                      className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none transition-colors hover:border-accent/50 focus:border-accent focus:ring-2 focus:ring-accent/20"
                    >
                      <option value="">— None —</option>
                      {(positions.data?.positions ?? [])
                        .filter(
                          (p) =>
                            !u.department_id ||
                            !p.department_id ||
                            p.department_id === u.department_id,
                        )
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <span className="truncate text-[12px] text-ink-secondary">
                      {u.position_id != null ? posNameById.get(u.position_id) || "—" : "—"}
                    </span>
                  )}

                  {/* Last seen */}
                  <div className="truncate text-[11px] text-ink-muted">
                    {u.last_login_at ? relativeTime(u.last_login_at) : "never"}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-1">
                    {manageable ? (
                      <>
                        <button
                          onClick={() => setBrandsFor(u)}
                          title="Edit brand allow-list"
                          className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-1 text-[10px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                        >
                          <Tag size={11} /> Brands
                        </button>
                        {u.status !== "invited" && (
                          <button
                            onClick={() => sendReset(u)}
                            title="Send password reset link"
                            className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-1 text-[10px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                          >
                            <KeyRound size={11} /> Reset
                          </button>
                        )}
                        <button
                          onClick={() => toggleStatus(u)}
                          title={u.status === "active" ? "Disable user" : "Enable user"}
                          className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-1 text-[10px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                        >
                          {u.status === "active" ? <UserX size={11} /> : <UserCheck size={11} />}
                          {u.status === "active" ? "Disable" : "Enable"}
                        </button>
                        <button
                          onClick={() => removeUser(u)}
                          aria-label="Delete permanently"
                          title="Delete permanently (irreversible)"
                          className="rounded p-1.5 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    ) : (
                      <span className="text-[11px] text-ink-muted">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Pending invitations */}
      <div className="mb-6">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Pending Invitations ({invites.data?.invitations.length ?? 0})
          </h2>
        </div>
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
          {invites.data?.invitations.length === 0 && (
            <div className="px-5 py-6 text-center text-sm text-ink-muted">
              No pending invitations
            </div>
          )}
          {invites.data?.invitations.map((inv) => (
            <div
              key={inv.id}
              className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-4 last:border-b-0 sm:flex-nowrap sm:gap-4 sm:px-5"
            >
              <StatusDot variant="neutral" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink">{inv.email}</span>
                  <span className="rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                    {inv.role_name}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-ink-muted">
                  Invited {relativeTime(inv.created_at)} · expires{" "}
                  {relativeTime(inv.expires_at)}
                  {inv.email_status === "sent" ? (
                    <>
                      {" "}· emailed
                      {inv.emailed_at ? ` ${relativeTime(inv.emailed_at)}` : ""}
                    </>
                  ) : inv.email_status ? (
                    <span style={{ color: "#b45309" }}> · email not sent</span>
                  ) : null}
                </div>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => resendInvite(inv)}
                    disabled={resendingId === inv.id}
                    className="rounded p-1.5 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-50"
                    aria-label="Resend invitation email"
                    title="Resend invitation email"
                  >
                    <RefreshCw
                      size={14}
                      className={resendingId === inv.id ? "animate-spin" : undefined}
                    />
                  </button>
                  <button
                    onClick={() => copyInviteLink(inv)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                  >
                    <Copy size={12} />
                    Copy Link
                  </button>
                  <button
                    onClick={() => revokeInvite(inv)}
                    className="rounded p-1.5 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                    aria-label="Revoke"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <InvitePanel
        open={inviteOpen}
        onClose={onCloseInvite}
        roles={roles.data?.roles ?? []}
        departments={depts.data?.departments ?? []}
        positions={positions.data?.positions ?? []}
        members={members.data?.users ?? []}
        onInvited={() => {
          onCloseInvite();
          reload();
        }}
      />

      {brandsFor && (
        <UserBrandsPanel
          user={brandsFor}
          onClose={() => setBrandsFor(null)}
          onSaved={() => {
            setBrandsFor(null);
            // No need to reload members — brand list lives in its own
            // endpoint and isn't in /api/users payload.
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-user brand allow-list editor (mig 049). Drives whether scoped
 * sales users see a project (intersected with their PIC scope).
 * Rendered as a side panel; reuses the chip-toggle UX from Roles.
 */
function UserBrandsPanel({
  user,
  onClose,
  onSaved,
}: {
  user: TeamMember;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [brands, setBrands] = useState<string[] | null>(null);

  // Canonical brand list from the project_brands lookup.
  const brandOpts = useQuery<{ data: string[] }>(() =>
    api.get("/api/projects/brands?names_only=1")
  );
  // Current allow-list for this user.
  const current = useQuery<{ brands: string[] }>(
    () => api.get(`/api/users/${user.id}/brands`),
    [user.id]
  );

  // Hydrate local state once the fetch lands.
  if (brands === null && current.data) {
    setBrands(current.data.brands);
  }

  const allBrands = brandOpts.data?.data ?? [];
  const selected = brands ?? [];

  function toggle(b: string) {
    setBrands((prev) => {
      const cur = prev ?? [];
      return cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b];
    });
  }

  async function save() {
    setBusy(true);
    try {
      await api.put(`/api/users/${user.id}/brands`, { brands: selected });
      toast.success(
        selected.length === 0
          ? `Cleared ${user.name || user.email}'s brand list`
          : `Updated ${user.name || user.email}'s brands`
      );
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={user.name || user.email}
      subtitle="Brand allow-list"
      width={420}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary"
          >
            Cancel
          </button>
          <Button
            variant="primary"
            onClick={save}
            disabled={busy || current.loading}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Brands">
        <div className="text-[11px] leading-snug text-ink-muted">
          When this user's role is sales-scoped, they only see projects
          whose brand is on this list (AND-ed with the PIC one-hop rule).
          Their direct reports inherit the same scope through{" "}
          <span className="font-mono">manager_id</span>.
        </div>
        <div className="flex flex-wrap gap-1.5">
          {current.loading && (
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-16" />
              ))}
            </div>
          )}
          {!current.loading && allBrands.length === 0 && (
            <div className="text-[11px] text-ink-muted">
              No brands defined yet. Add some under Project Maintenance →
              Brands.
            </div>
          )}
          {!current.loading &&
            allBrands.map((b) => {
              const on = selected.includes(b);
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => toggle(b)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors",
                    on
                      ? "border-accent bg-accent text-white"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent"
                  )}
                >
                  {b}
                </button>
              );
            })}
        </div>
        <div className="mt-1 text-[10px] text-ink-muted">
          {selected.length === 0
            ? "Empty list — this user sees no projects when sales-scoped."
            : `${selected.length} brand${selected.length === 1 ? "" : "s"} selected.`}
        </div>
      </PanelSection>
    </Panel>
  );
}

// ──────────────────────────────────────────────────────────
// Org hierarchy helpers
// ──────────────────────────────────────────────────────────

/**
 * Returns true if `candidateId` sits somewhere in `ancestorId`'s reporting
 * subtree — i.e. appointing them as ancestor's manager would create a loop.
 * Used only to hide bad options in the picker; the backend still validates.
 */
function isDescendantOf(
  candidateId: number,
  ancestorId: number,
  users: TeamMember[]
): boolean {
  const byId = new Map(users.map((u) => [u.id, u]));
  const seen = new Set<number>();
  let cursor: number | null = candidateId;
  while (cursor != null && !seen.has(cursor)) {
    seen.add(cursor);
    const node: TeamMember | undefined = byId.get(cursor);
    if (!node) return false;
    if (node.manager_id === ancestorId) return true;
    cursor = node.manager_id;
  }
  return false;
}

// ──────────────────────────────────────────────────────────
// Org Chart tab — top-down visual tree with drag-to-assign
// ──────────────────────────────────────────────────────────
//
// Renders each team as a proper top-down hierarchy (parent → children
// below, connected by hairlines). Interactions:
//   • Drag a node onto another node → assigns that user as report.
//   • Drag a node onto the "Top level" strip → removes their manager.
//   • Click the pencil on a card → inline manager dropdown (keyboard-
//     accessible fallback for drag-and-drop).
// Cycle prevention is enforced both client-side (drop target refuses)
// and server-side (PATCH /api/users/:id walks the chain).

function OrgChartTab() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can("users.manage");
  const members = useQuery<{ users: TeamMember[] }>(() => api.get("/api/users"));
  const depts = useQuery<{ departments: Department[] }>(() =>
    api.get("/api/departments")
  );

  // Department filter — null = "All". When a dept is selected the chart
  // narrows to that dept's members only; reps reporting up to a manager
  // outside the filtered set get re-rooted so the team's lineup is
  // visible end-to-end. Persists per-tab in the URL so a "Sales chart"
  // bookmark stays usable.
  const [params, setParams] = useSearchParams();
  const filterDeptId = params.get("dept")
    ? parseInt(params.get("dept") || "", 10)
    : null;
  function setFilterDeptId(id: number | null) {
    const next = new URLSearchParams(params);
    if (id == null) next.delete("dept");
    else next.set("dept", String(id));
    setParams(next, { replace: true });
  }

  const allActive = (members.data?.users ?? []).filter(
    (u) => u.status !== "disabled"
  );
  const users = useMemo(() => {
    if (filterDeptId == null) return allActive;
    return allActive.filter((u) => u.department_id === filterDeptId);
  }, [allActive, filterDeptId]);

  // Any user whose manager_id points at an inactive/missing/out-of-
  // filter user gets re-rooted so they stay visible.
  const { roots, childrenOf, byId } = useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u]));
    const childrenOf = new Map<number | null, TeamMember[]>();
    for (const u of users) {
      const parentId =
        u.manager_id != null && byId.has(u.manager_id) ? u.manager_id : null;
      const arr = childrenOf.get(parentId) ?? [];
      arr.push(u);
      childrenOf.set(parentId, arr);
    }
    for (const arr of childrenOf.values()) {
      arr.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    }
    return { roots: childrenOf.get(null) ?? [], childrenOf, byId };
  }, [users]);

  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  async function reassign(userId: number, managerId: number | null) {
    if (userId === managerId) return;
    const current = byId.get(userId);
    if (!current) return;
    if ((current.manager_id ?? null) === managerId) return; // no-op
    if (managerId != null && isDescendantOf(managerId, userId, users)) {
      toast.error("That user reports to this one — would create a loop");
      return;
    }
    try {
      await api.patch(`/api/users/${userId}`, { manager_id: managerId });
      const targetName = managerId ? byId.get(managerId)?.name || byId.get(managerId)?.email : null;
      toast.success(
        targetName
          ? `${current.name || current.email} now reports to ${targetName}`
          : `${current.name || current.email} is now top-level`
      );
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update");
    } finally {
      setEditingId(null);
    }
  }

  if (members.loading && users.length === 0) {
    return <ListSkeleton rows={4} />;
  }
  if (members.error) {
    return <div className="text-[12px] text-err">{members.error}</div>;
  }

  const deptList = depts.data?.departments ?? [];
  const filterDept = filterDeptId
    ? deptList.find((d) => d.id === filterDeptId)
    : null;

  return (
    <div className="space-y-4">
      {/* Department pill row — pick "All" or any dept to narrow the
          tree to that team. Bookmarkable via ?dept= so a Sales chart
          link is shareable. */}
      {deptList.length > 0 && (
        <div className="no-scrollbar -mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
          <span className="shrink-0 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Filter
          </span>
          <button
            type="button"
            onClick={() => setFilterDeptId(null)}
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors",
              filterDeptId == null
                ? "border-accent bg-accent text-white"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent"
            )}
          >
            All
            <span className="ml-1.5 font-normal opacity-70">
              {allActive.length}
            </span>
          </button>
          {deptList.map((d) => {
            const on = filterDeptId === d.id;
            const count = allActive.filter(
              (u) => u.department_id === d.id
            ).length;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setFilterDeptId(d.id)}
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors"
                )}
                style={
                  on
                    ? {
                        backgroundColor: `#${d.color}`,
                        color: "white",
                        borderColor: `#${d.color}`,
                      }
                    : {
                        backgroundColor: `#${d.color}1a`,
                        color: `#${d.color}`,
                        borderColor: `#${d.color}40`,
                      }
                }
              >
                {d.name}
                <span className="ml-1.5 font-normal opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Top-level drop zone — drop a user here to remove their manager */}
      {canManage && (
        <TopLevelDropZone
          dragging={draggingId != null}
          onDrop={(userId) => reassign(userId, null)}
        />
      )}

      {roots.length === 0 ? (
        <div className="rounded-md border border-border bg-surface px-5 py-8 text-center text-[12px] text-ink-muted">
          {filterDept
            ? `No active members in ${filterDept.name}.`
            : "No active members yet."}
        </div>
      ) : (
        <div className="thin-scroll overflow-x-auto pb-6">
          <div className="mx-auto flex min-w-fit items-start justify-center gap-10 px-4 pt-2">
            {roots.map((r) => (
              <OrgTreeNode
                key={r.id}
                user={r}
                childrenOf={childrenOf}
                canManage={canManage}
                users={users}
                draggingId={draggingId}
                setDraggingId={setDraggingId}
                onDrop={reassign}
                editingId={editingId}
                setEditingId={setEditingId}
                onPickManager={reassign}
              />
            ))}
          </div>
        </div>
      )}

      <div className="text-[10.5px] text-ink-muted">
        <span className="font-semibold">Tip:</span> drag any card onto another
        to reassign reporting. Drop on the strip at the top to make them
        top-level. Or click the pencil icon for a dropdown.
      </div>
    </div>
  );
}

function TopLevelDropZone({
  dragging,
  onDrop,
}: {
  dragging: boolean;
  onDrop: (userId: number) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const id = parseInt(e.dataTransfer.getData("user-id"), 10);
        if (!isNaN(id)) onDrop(id);
      }}
      className={cn(
        "rounded-md border-2 border-dashed px-4 py-2 text-center font-mono text-[10px] uppercase tracking-brand transition-colors",
        hover
          ? "border-accent bg-accent-soft/40 text-accent"
          : dragging
          ? "border-accent/40 text-accent/70"
          : "border-border text-ink-muted"
      )}
    >
      Top level — drop here to remove manager
    </div>
  );
}

function OrgTreeNode({
  user,
  childrenOf,
  canManage,
  users,
  draggingId,
  setDraggingId,
  onDrop,
  editingId,
  setEditingId,
  onPickManager,
}: {
  user: TeamMember;
  childrenOf: Map<number | null, TeamMember[]>;
  canManage: boolean;
  users: TeamMember[];
  draggingId: number | null;
  setDraggingId: (id: number | null) => void;
  onDrop: (userId: number, managerId: number | null) => void;
  editingId: number | null;
  setEditingId: (id: number | null) => void;
  onPickManager: (userId: number, managerId: number | null) => void;
}) {
  const kids = childrenOf.get(user.id) ?? [];
  const hasKids = kids.length > 0;

  return (
    <div className="flex flex-col items-center">
      <OrgCard
        user={user}
        reportsCount={kids.length}
        canManage={canManage}
        draggingId={draggingId}
        setDraggingId={setDraggingId}
        onDrop={onDrop}
        editing={editingId === user.id}
        setEditing={(on) => setEditingId(on ? user.id : null)}
        users={users}
        onPickManager={onPickManager}
      />

      {hasKids && (
        <div className="flex flex-col items-stretch">
          {/* Parent's vertical stub */}
          <div className="flex h-4 justify-center">
            <div className="w-px bg-border" />
          </div>

          {/* Children row: each wrapper owns its segment of the horizontal
              bar (via absolute top-0 div); segments visually merge into
              one continuous connector between the outermost centres. */}
          <div className="flex items-start">
            {kids.map((k, i) => {
              const only = kids.length === 1;
              const first = i === 0;
              const last = i === kids.length - 1;
              return (
                <div
                  key={k.id}
                  className="relative flex flex-1 flex-col items-center px-3"
                >
                  {!only && (
                    <div
                      className={cn(
                        "absolute top-0 h-px bg-border",
                        first && "left-1/2 right-0",
                        last && "left-0 right-1/2",
                        !first && !last && "left-0 right-0"
                      )}
                    />
                  )}
                  <div className="h-4 w-px bg-border" />
                  <OrgTreeNode
                    user={k}
                    childrenOf={childrenOf}
                    canManage={canManage}
                    users={users}
                    draggingId={draggingId}
                    setDraggingId={setDraggingId}
                    onDrop={onDrop}
                    editingId={editingId}
                    setEditingId={setEditingId}
                    onPickManager={onPickManager}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function OrgCard({
  user,
  reportsCount,
  canManage,
  draggingId,
  setDraggingId,
  onDrop,
  editing,
  setEditing,
  users,
  onPickManager,
}: {
  user: TeamMember;
  reportsCount: number;
  canManage: boolean;
  draggingId: number | null;
  setDraggingId: (id: number | null) => void;
  onDrop: (userId: number, managerId: number | null) => void;
  editing: boolean;
  setEditing: (on: boolean) => void;
  users: TeamMember[];
  onPickManager: (userId: number, managerId: number | null) => void;
}) {
  const [dropHover, setDropHover] = useState(false);
  const isDragSource = draggingId === user.id;
  const isValidDropTarget =
    draggingId != null &&
    draggingId !== user.id &&
    // Can't drop user onto their own descendant.
    !isDescendantOf(user.id, draggingId, users);

  return (
    <div
      draggable={canManage}
      onDragStart={(e) => {
        if (!canManage) return;
        e.dataTransfer.setData("user-id", String(user.id));
        e.dataTransfer.effectAllowed = "move";
        setDraggingId(user.id);
      }}
      onDragEnd={() => setDraggingId(null)}
      onDragOver={(e) => {
        if (!canManage || !isValidDropTarget) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => {
        if (!canManage) return;
        e.preventDefault();
        setDropHover(false);
        const id = parseInt(e.dataTransfer.getData("user-id"), 10);
        if (!isNaN(id) && id !== user.id) onDrop(id, user.id);
      }}
      className={cn(
        "relative w-[220px] shrink-0 overflow-hidden rounded-md border bg-surface shadow-stone transition-all",
        isDragSource && "opacity-50",
        dropHover && isValidDropTarget && "border-accent bg-accent-soft/40 ring-2 ring-accent/30",
        !dropHover && "border-border",
        canManage && "cursor-grab active:cursor-grabbing"
      )}
    >
      {/* Department colour stripe on the left edge. Transparent when no
          department assigned so the card still reads as bordered. */}
      {user.department_color && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ backgroundColor: `#${user.department_color}` }}
        />
      )}
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Avatar
          userId={user.id}
          hasImage={user.profile_pic_r2_key}
          name={user.name}
          email={user.email}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-ink">
              {user.name || user.email}
            </span>
            {user.status !== "active" && (
              <span className="rounded bg-bg px-1 py-px font-mono text-[9px] font-semibold uppercase text-ink-muted">
                {user.status}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-ink-muted">
            {user.email}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
              {user.role_name}
            </span>
            {user.department_name && (
              <span
                className="rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider"
                style={
                  user.department_color
                    ? {
                        backgroundColor: `#${user.department_color}22`,
                        color: `#${user.department_color}`,
                      }
                    : undefined
                }
              >
                {user.department_name}
              </span>
            )}
            {reportsCount > 0 && (
              <span
                className="font-mono text-[9.5px] text-ink-muted"
                title={`${reportsCount} direct report${reportsCount === 1 ? "" : "s"}`}
              >
                {reportsCount} report{reportsCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {user.brands && user.brands.length > 0 && (
            <div
              className="mt-1 flex flex-wrap items-center gap-0.5"
              title={`Brand allow-list: ${user.brands.join(", ")}`}
            >
              {user.brands.map((b) => (
                <span
                  key={b}
                  className="rounded bg-bg px-1 py-px font-mono text-[8.5px] font-semibold uppercase tracking-wider text-ink-secondary"
                >
                  {b}
                </span>
              ))}
            </div>
          )}
        </div>
        {canManage && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="rounded p-1 text-ink-muted transition-colors hover:bg-surface-dim hover:text-accent"
            aria-label="Change manager"
            title="Change manager"
          >
            <Pencil size={11} />
          </button>
        )}
      </div>

      {editing && (
        <div className="border-t border-border-subtle bg-bg/60 px-3 py-2">
          <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Reports to
          </label>
          <select
            autoFocus
            defaultValue={user.manager_id ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              onPickManager(user.id, v ? Number(v) : null);
            }}
            className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[11px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
          >
            <option value="">— No manager —</option>
            {users
              .filter(
                (m) =>
                  m.id !== user.id && !isDescendantOf(m.id, user.id, users)
              )
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.email}
                </option>
              ))}
          </select>
          <button
            onClick={() => setEditing(false)}
            className="mt-1.5 text-[10px] text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Departments tab — small CRUD list of org groupings
// ──────────────────────────────────────────────────────────

/** Fixed palette shown in the colour picker. Values are 6-char hex
 *  without '#', to match the backend contract. Room for 8 entries so
 *  the swatches fit on one row without crowding. */
const DEPT_PALETTE = [
  { hex: "64748b", label: "Slate" },
  { hex: "3b82f6", label: "Blue" },
  { hex: "06b6d4", label: "Cyan" },
  { hex: "10b981", label: "Emerald" },
  { hex: "f59e0b", label: "Amber" },
  { hex: "f97316", label: "Orange" },
  { hex: "ec4899", label: "Pink" },
  { hex: "8b5cf6", label: "Violet" },
];

function DepartmentsTab({
  creating,
  onCloseCreate,
}: {
  creating: boolean;
  onCloseCreate: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const canManage = can("users.manage");
  const depts = useQuery<{ departments: Department[] }>(() =>
    api.get("/api/departments")
  );
  const [editing, setEditing] = useState<Department | null>(null);

  async function save(
    d: Department | null,
    body: { name: string; description: string | null; color: string; sort_order: number }
  ) {
    try {
      if (d) {
        await api.patch(`/api/departments/${d.id}`, body);
        toast.success(`Updated ${body.name}`);
      } else {
        await api.post("/api/departments", body);
        toast.success(`Created ${body.name}`);
      }
      depts.reload();
      onCloseCreate();
      setEditing(null);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function remove(d: Department) {
    if (
      !(await dialog.confirm(
        `Delete "${d.name}"? Members in this department will be unassigned.`
      ))
    )
      return;
    try {
      await api.del(`/api/departments/${d.id}`);
      toast.success(`Deleted ${d.name}`);
      depts.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  const rows = depts.data?.departments ?? [];
  const editorOpen = creating || editing !== null;
  const editorRole = creating ? null : editing;

  return (
    <div className="space-y-4">
      {depts.loading && rows.length === 0 && <ListSkeleton rows={3} />}
      {depts.error && <div className="text-[12px] text-err">{depts.error}</div>}

      {rows.length === 0 && !depts.loading ? (
        <EmptyState
          message="No departments yet."
          description="Create one to start tagging members."
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
          {rows.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0"
            >
              <span
                className="h-8 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: `#${d.color}` }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">
                    {d.name}
                  </span>
                </div>
                {d.description && (
                  <div className="mt-0.5 truncate text-[11px] text-ink-muted">
                    {d.description}
                  </div>
                )}
              </div>
              <span
                className="rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  backgroundColor: `#${d.color}22`,
                  color: `#${d.color}`,
                }}
              >
                {d.member_count} member{d.member_count === 1 ? "" : "s"}
              </span>
              {canManage && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditing(d)}
                    className="rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-dim hover:text-accent"
                    aria-label="Edit"
                    title="Edit department"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => remove(d)}
                    className="rounded p-1.5 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                    aria-label="Delete"
                    title="Delete department"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editorOpen && (
        <DepartmentEditor
          department={editorRole}
          onClose={() => {
            onCloseCreate();
            setEditing(null);
          }}
          onSave={(body) => save(editorRole, body)}
        />
      )}
    </div>
  );
}

function DepartmentEditor({
  department,
  onClose,
  onSave,
}: {
  department: Department | null;
  onClose: () => void;
  onSave: (body: {
    name: string;
    description: string | null;
    color: string;
    sort_order: number;
  }) => void;
}) {
  const isCreate = !department;
  const [name, setName] = useState(department?.name || "");
  const [description, setDescription] = useState(department?.description || "");
  const [color, setColor] = useState(department?.color || DEPT_PALETTE[0].hex);
  const [sortOrder, setSortOrder] = useState<number>(department?.sort_order ?? 0);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        color,
        sort_order: sortOrder,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={isCreate ? "New Department" : department!.name}
      subtitle={isCreate ? "Create a team grouping" : "Edit department"}
      width={440}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary"
          >
            Cancel
          </button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : isCreate ? "Create" : "Save"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Details">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sales, Operations, Finance"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this team owns"
            className="min-h-[60px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Colour
          </label>
          <div className="flex items-center gap-3">
            <ColorPicker
              value={color}
              onChange={setColor}
              presets={DEPT_PALETTE.map((p) => p.hex)}
              size={36}
            />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Sort order
          </label>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            className="h-9 w-24 rounded-md border border-border bg-surface px-3 text-[13px]"
          />
          <div className="mt-1 text-[10px] text-ink-muted">
            Lower numbers render first in the list.
          </div>
        </div>
      </PanelSection>
    </Panel>
  );
}

// ──────────────────────────────────────────────────────────
// Invite panel
// ──────────────────────────────────────────────────────────
function InvitePanel({
  open,
  onClose,
  roles,
  departments,
  positions,
  members,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  roles: Role[];
  departments: Department[];
  positions: Position[];
  members: TeamMember[];
  onInvited: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [roleId, setRoleId] = useState<number | "">("");
  const [deptId, setDeptId] = useState<number | "">("");
  const [positionId, setPositionId] = useState<number | "">("");
  const [managerId, setManagerId] = useState<number | "">("");
  const [managerQuery, setManagerQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{
    token: string;
    email: string;
    invite_url?: string;
    email_sent?: boolean;
  } | null>(null);

  if (roleId === "" && roles.length > 0) {
    const defaultRole = roles.find((r) => !r.is_system) || roles[0];
    setRoleId(defaultRole.id);
  }

  async function submit() {
    if (!email) {
      toast.error("Email is required");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{
        token: string;
        email: string;
        invite_url?: string;
        email_sent?: boolean;
      }>("/api/users/invite", {
        email: email.toLowerCase().trim(),
        name: name.trim() || undefined,
        role_id: roleId,
        department_id: deptId || undefined,
        position_id: positionId || undefined,
        manager_id: managerId || undefined,
        phone: phone.trim() || undefined,
      });
      setIssued(res);
      toast.success(
        res.email_sent
          ? `Invitation emailed to ${res.email}`
          : `Invitation issued for ${res.email}`
      );
      onInvited();
    } catch (e: any) {
      toast.error(e?.message || "Failed to invite");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setEmail("");
    setName("");
    setPhone("");
    setDeptId("");
    setPositionId("");
    setManagerId("");
    setManagerQuery("");
    setIssued(null);
    onClose();
  }

  function copyLink() {
    if (!issued) return;
    const link =
      issued.invite_url || `${window.location.origin}/#invite=${issued.token}`;
    navigator.clipboard.writeText(link).then(
      () => toast.success("Invite link copied"),
      () => toast.error("Could not access clipboard")
    );
  }

  return (
    <Panel
      open={open}
      onClose={reset}
      title="Invite Member"
      subtitle="Send a one-time invitation link"
      width={440}
    >
      {!issued ? (
        <PanelSection title="Details">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="member@houzscentury.com"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Phone
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. 012-345 6789 (optional)"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Department
            </label>
            <select
              value={deptId}
              onChange={(e) => {
                setDeptId(e.target.value ? Number(e.target.value) : "");
                setPositionId(""); // positions are department-scoped — reset
              }}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— Select department —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Position
            </label>
            <select
              value={positionId}
              onChange={(e) => setPositionId(e.target.value ? Number(e.target.value) : "")}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— Select position —</option>
              {positions
                .filter((p) => deptId === "" || !p.department_id || p.department_id === deptId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <div className="mt-1 text-[10px] text-ink-muted">
              Controls which pages this member can see (least-privilege per position).
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Reports to
            </label>
            <div className="relative">
              <input
                type="text"
                value={managerQuery}
                onChange={(e) => {
                  setManagerQuery(e.target.value);
                  setManagerId("");
                }}
                placeholder="Search a member… (optional)"
                className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              {managerQuery.trim() !== "" && !managerId && (
                <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-surface shadow-slab">
                  {(() => {
                    const q = managerQuery.trim().toLowerCase();
                    const matches = members.filter(
                      (m) =>
                        m.status === "active" &&
                        ((m.name || "").toLowerCase().includes(q) ||
                          (m.email || "").toLowerCase().includes(q)),
                    );
                    if (matches.length === 0)
                      return <div className="px-3 py-2 text-[11px] text-ink-muted">No match.</div>;
                    return matches.slice(0, 8).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setManagerId(m.id);
                          setManagerQuery(m.name || m.email);
                        }}
                        className="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-accent-soft/50"
                      >
                        <span className="text-[12.5px] text-ink">{m.name || m.email}</span>
                        {m.name && <span className="text-[10.5px] text-ink-muted">{m.email}</span>}
                      </button>
                    ));
                  })()}
                </div>
              )}
            </div>
            {managerId !== "" && (
              <button
                type="button"
                onClick={() => {
                  setManagerId("");
                  setManagerQuery("");
                }}
                className="mt-1 text-[10px] text-ink-muted transition-colors hover:text-err"
              >
                Clear report-to
              </button>
            )}
          </div>
          <div className="pt-2">
            <Button variant="brass" className="w-full" onClick={submit} disabled={busy}>
              {busy ? "Issuing…" : "Issue Invitation"}
            </Button>
          </div>
        </PanelSection>
      ) : (
        <PanelSection title="Invitation Issued">
          <p className="text-[12.5px] text-ink-secondary">
            {issued.email_sent ? (
              <>
                We emailed the invitation to{" "}
                <span className="font-semibold text-ink">{issued.email}</span>.
                The same link is below if you want to share it directly.
              </>
            ) : (
              <>
                The invitation email could not be sent — copy this link and
                share it with{" "}
                <span className="font-semibold text-ink">{issued.email}</span>{" "}
                yourself.
              </>
            )}
          </p>
          <div className="rounded-md border border-border bg-bg p-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Invite Link
            </div>
            <div className="break-all font-mono text-[11px] text-ink">
              {issued.invite_url ||
                `${window.location.origin}/#invite=${issued.token}`}
            </div>
          </div>
          <Button variant="brass" className="w-full" icon={<Copy size={14} />} onClick={copyLink}>
            Copy Link
          </Button>
          <div className="text-[10px] text-ink-muted">
            The link expires in 14 days. You can also revoke it from the Pending Invitations
            list at any time.
          </div>
        </PanelSection>
      )}
    </Panel>
  );
}
