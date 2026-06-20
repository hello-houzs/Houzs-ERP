import { useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Copy, Trash2, UserX, UserCheck, X, KeyRound, Pencil, Check, Tag, RefreshCw, Search, ArrowUp, ArrowDown, ChevronsUpDown, Printer, LayoutGrid, List, Phone, Mail, ArrowLeft, SlidersHorizontal, ListTree, Network, ChevronRight, ChevronDown, Users as UsersIcon } from "lucide-react";
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
import { DataTable, type Column } from "../components/DataTable";
import { StatCard } from "../components/StatCard";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { relativeTime, cn } from "../lib/utils";
import type { TeamMember, Invitation, Role, Department, Position } from "../types";
import { RolesTab } from "./Roles";
import { PositionsTab } from "./Positions";

type TeamTabValue = "members" | "positions" | "roles" | "orgchart" | "departments";

const TEAM_KEYS = ["tab"] as const;

// One-click member segments (label + key). Shared by the Filters popover
// and the active-filter pill row.
const QUICK_SEGMENTS = [
  ["online", "Online now"],
  ["joined7d", "Joined ≤ 7d"],
  ["no_login", "Never signed in"],
  ["stale", "Inactive 30d+"],
  ["no_dept", "No department"],
  ["no_pos", "No position"],
  ["no_mgr", "No manager"],
  ["no_photo", "No photo"],
] as const;

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
    // Roles tab removed (owner: "删了role") — Position governs page access; a
    // baseline role is auto-assigned on invite. Re-add this line to restore.
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
  // Live presence — who's online right now (active in the last few minutes).
  const presence = useQuery<{ active: { id: number }[] }>(() =>
    api.get("/api/presence")
  );
  const onlineIds = useMemo(
    () => new Set((presence.data?.active ?? []).map((a) => a.id)),
    [presence.data],
  );

  // Members-list filters (owner ask: filter/sort by department and/or position).
  const [filterDept, setFilterDept] = useState<number | "">("");
  const [filterPos, setFilterPos] = useState<number | "">("");
  const [filterStatus, setFilterStatus] = useState<"" | "active" | "invited" | "disabled">("");
  // One-click segments to surface misconfigured / stale accounts.
  // Multi-select: any number of segments can be active; each adds a
  // constraint (AND), the same way the dropdown filters compose.
  const [quickFilters, setQuickFilters] = useState<Set<string>>(new Set());
  const toggleQuick = (key: string) =>
    setQuickFilters((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const [filterRole, setFilterRole] = useState<number | "">("");
  const [filterBrand, setFilterBrand] = useState<string>("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  // Card grid (reference look) vs. dense table. Grid is the default.
  const [view, setView] = useLocalStorage<"grid" | "list">("team:view", "grid");
  // Grid ordering (the table view has its own column sort).
  const [gridSort, setGridSort] = useLocalStorage<"name" | "recent" | "status">(
    "team:gridSort",
    "name",
  );

  // Per-user brand picker — opens a small modal scoped to one member.
  const [brandsFor, setBrandsFor] = useState<TeamMember | null>(null);
  // Member being edited in the side panel (name/email/phone/org + actions).
  const [editing, setEditing] = useState<TeamMember | null>(null);
  // Member whose full-screen detail is open. Stored by id so it re-reads
  // from the live list after an edit/reload instead of going stale.
  const [viewingId, setViewingId] = useState<number | null>(null);
  // Invitation row whose resend is in flight (spinner + disable).
  const [resendingId, setResendingId] = useState<number | null>(null);

  const canManage = can("users.manage");

  function reload() {
    members.reload();
    invites.reload();
  }

  // Per-field inline editing moved into the Edit Member panel — it sends
  // one PATCH with all changed fields (name/email/phone/department/
  // position/reports-to), keeping the members table read-only and tidy.

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
    const body: Record<string, unknown> = { status: next };
    if (next === "disabled") {
      const reason = await dialog.prompt({
        title: `Disable ${u.name || u.email}?`,
        message: "Optional — note why. Shown on their profile and cleared if re-enabled.",
        placeholder: "e.g. left the company",
        confirmLabel: "Disable",
      });
      if (reason === null) return; // cancelled
      body.status_reason = reason.trim() || null;
    }
    try {
      await api.patch(`/api/users/${u.id}`, body);
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

  const expiredInvites = (invites.data?.invitations ?? []).filter(
    (inv) => new Date(inv.expires_at).getTime() < Date.now(),
  );

  async function revokeAllExpired() {
    if (expiredInvites.length === 0) return;
    if (
      !(await dialog.confirm(
        `Revoke ${expiredInvites.length} expired invitation${expiredInvites.length === 1 ? "" : "s"}? This can't be undone.`,
      ))
    )
      return;
    try {
      await Promise.all(
        expiredInvites.map((inv) => api.del(`/api/users/invitations/${inv.id}`)),
      );
      toast.success(`Revoked ${expiredInvites.length} expired invitation(s)`);
      invites.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to revoke some invitations");
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

  const posNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of positions.data?.positions ?? []) m.set(p.id, p.name);
    return m;
  }, [positions.data]);
  const filteredMembers = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const segMatch = (key: string, u: TeamMember) => {
      switch (key) {
        case "no_login":
          return !u.last_login_at;
        case "no_dept":
          return u.department_id == null;
        case "no_pos":
          return u.position_id == null;
        case "no_mgr":
          return u.manager_id == null;
        case "stale":
          return !!u.last_login_at && now - new Date(u.last_login_at).getTime() > 30 * DAY;
        case "online":
          return onlineIds.has(u.id);
        case "joined7d":
          return !!u.joined_at && now - new Date(u.joined_at).getTime() <= 7 * DAY;
        case "no_photo":
          return !u.profile_pic_r2_key;
        default:
          return true;
      }
    };
    const segs = [...quickFilters];
    return (members.data?.users ?? []).filter(
      (u) =>
        (filterDept === "" || u.department_id === filterDept) &&
        (filterPos === "" || u.position_id === filterPos) &&
        (filterStatus === "" || u.status === filterStatus) &&
        (filterRole === "" || u.role_id === filterRole) &&
        (filterBrand === "" || (u.brands ?? []).includes(filterBrand)) &&
        segs.every((k) => segMatch(k, u)) &&
        (q === "" ||
          (u.name || "").toLowerCase().includes(q) ||
          (u.email || "").toLowerCase().includes(q)),
    );
  }, [
    members.data,
    filterDept,
    filterPos,
    filterStatus,
    filterRole,
    filterBrand,
    quickFilters,
    onlineIds,
    searchQ,
  ]);

  // Distinct brands across members — drives the brand filter dropdown.
  const allBrands = useMemo(() => {
    const s = new Set<string>();
    for (const u of members.data?.users ?? []) for (const b of u.brands ?? []) s.add(b);
    return [...s].sort();
  }, [members.data]);

  // Active-filter bookkeeping for the Filters popover + removable pills.
  const statusLabels: Record<string, string> = {
    active: "Active",
    invited: "Pending",
    disabled: "Disabled",
  };
  const activeFilters: { label: string; clear: () => void }[] = [];
  if (filterStatus)
    activeFilters.push({ label: statusLabels[filterStatus], clear: () => setFilterStatus("") });
  if (filterDept !== "")
    activeFilters.push({
      label: depts.data?.departments.find((d) => d.id === filterDept)?.name ?? "Department",
      clear: () => setFilterDept(""),
    });
  if (filterPos !== "")
    activeFilters.push({
      label: posNameById.get(filterPos as number) ?? "Position",
      clear: () => setFilterPos(""),
    });
  if (filterRole !== "")
    activeFilters.push({
      label: roles.data?.roles.find((r) => r.id === filterRole)?.name ?? "Role",
      clear: () => setFilterRole(""),
    });
  if (filterBrand)
    activeFilters.push({ label: filterBrand, clear: () => setFilterBrand("") });
  for (const key of quickFilters)
    activeFilters.push({
      label: QUICK_SEGMENTS.find(([k]) => k === key)?.[1] ?? "Segment",
      clear: () => toggleQuick(key),
    });

  function clearAllFilters() {
    setFilterStatus("");
    setFilterDept("");
    setFilterPos("");
    setFilterRole("");
    setFilterBrand("");
    setQuickFilters(new Set());
  }

  // Grid ordering (table view keeps its own column sort).
  const gridMembers = useMemo(() => {
    const arr = filteredMembers.slice();
    if (gridSort === "name") {
      arr.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    } else if (gridSort === "recent") {
      arr.sort(
        (a, b) =>
          new Date(b.last_login_at || 0).getTime() - new Date(a.last_login_at || 0).getTime(),
      );
    } else if (gridSort === "status") {
      const rank: Record<string, number> = { active: 0, invited: 1, disabled: 2 };
      arr.sort(
        (a, b) =>
          (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
          (a.name || a.email).localeCompare(b.name || b.email),
      );
    }
    return arr;
  }, [filteredMembers, gridSort]);

  // Status tallies for the stat strip (reference layout). Mirrors the
  // member lifecycle: active / invited (pending) / disabled (archived).
  const counts = useMemo(() => {
    const all = members.data?.users ?? [];
    return {
      total: all.length,
      active: all.filter((u) => u.status === "active").length,
      invited: all.filter((u) => u.status === "invited").length,
      disabled: all.filter((u) => u.status === "disabled").length,
    };
  }, [members.data]);

  // Click a stat card to toggle that status filter (like the reference).
  function pickStatus(s: "active" | "invited" | "disabled") {
    setFilterStatus((cur) => (cur === s ? "" : s));
  }

  // Re-read the viewed member from the live list so the detail page stays
  // current after an edit reload (rather than holding a stale snapshot).
  const viewing =
    viewingId != null
      ? (members.data?.users.find((u) => u.id === viewingId) ?? null)
      : null;

  // ── Bulk selection (list view) ─────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function clearSelect() {
    setSelectedIds(new Set());
  }
  // Only ever act on rows the admin may modify (manageable + not self).
  const selectableFiltered = filteredMembers.filter(
    (u) => canManage && u.id !== me?.id,
  );
  function selectAllFiltered() {
    setSelectedIds(new Set(selectableFiltered.map((u) => u.id)));
  }
  async function bulkPatch(fields: Record<string, unknown>, label: string) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      const results = await Promise.allSettled(
        ids.map((id) => api.patch(`/api/users/${id}`, fields)),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = ids.length - ok;
      if (failed === 0) toast.success(`${label} — ${ok} member${ok === 1 ? "" : "s"}`);
      else toast.error(`${label}: ${ok} done, ${failed} failed`);
      clearSelect();
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Bulk action failed");
    }
  }

  const memberColumns: Column<TeamMember>[] = [
    ...(canManage
      ? [
          {
            key: "select",
            label: "",
            width: "36px",
            alwaysVisible: true,
            disableSort: true,
            renderHeader: () => {
              const all =
                selectableFiltered.length > 0 &&
                selectableFiltered.every((u) => selectedIds.has(u.id));
              const some = selectableFiltered.some((u) => selectedIds.has(u.id));
              return (
                <input
                  type="checkbox"
                  checked={all}
                  ref={(el) => {
                    if (el) el.indeterminate = some && !all;
                  }}
                  onChange={() => (all ? clearSelect() : selectAllFiltered())}
                  onClick={(e) => e.stopPropagation()}
                  className="h-3.5 w-3.5 cursor-pointer accent-[#a16a2e]"
                  aria-label="Select all members"
                  title="Select all"
                />
              );
            },
            render: (u: TeamMember) =>
              u.id === me?.id ? (
                <span className="block w-3.5" />
              ) : (
                <input
                  type="checkbox"
                  checked={selectedIds.has(u.id)}
                  onChange={() => toggleSelect(u.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-3.5 w-3.5 cursor-pointer accent-[#a16a2e]"
                  aria-label={`Select ${u.name || u.email}`}
                />
              ),
          } as Column<TeamMember>,
        ]
      : []),
    {
      key: "name",
      label: "Member",
      getValue: (u) => u.name || u.email || "",
      render: (u) => (
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
      ),
    },
    {
      key: "department",
      label: "Department",
      width: "150px",
      getValue: (u) => u.department_name || "",
      render: (u) =>
        u.department_name ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-ink-secondary">
            {u.department_color && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: `#${u.department_color}` }}
              />
            )}
            <span className="truncate">{u.department_name}</span>
          </span>
        ) : (
          <span className="text-[12px] text-ink-muted">—</span>
        ),
    },
    {
      key: "position",
      label: "Position",
      width: "160px",
      getValue: (u) =>
        u.position_id != null ? posNameById.get(u.position_id) || "" : "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {u.position_id != null ? posNameById.get(u.position_id) || "—" : "—"}
        </span>
      ),
    },
    {
      key: "last_seen",
      label: "Last Seen",
      width: "110px",
      getValue: (u) => u.last_login_at || "",
      render: (u) => (
        <span className="truncate text-[11px] text-ink-muted">
          {u.last_login_at ? relativeTime(u.last_login_at) : "never"}
        </span>
      ),
    },
    {
      key: "manager",
      label: "Reports to",
      width: "160px",
      getValue: (u) => u.manager_name || u.manager_email || "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {u.manager_name || u.manager_email || "—"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      width: "72px",
      align: "right",
      render: (u) => {
        const manageable = canManage && u.id !== me?.id;
        if (!manageable) return <span className="text-[11px] text-ink-muted">—</span>;
        return (
          <button
            onClick={() => setEditing(u)}
            title="Edit member"
            aria-label="Edit member"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
          >
            <Pencil size={12} /> Edit
          </button>
        );
      },
    },
  ];

  return (
    <div>
      {viewing ? (
        <MemberDetail
          user={viewing}
          members={members.data?.users ?? []}
          posName={
            viewing.position_id != null ? posNameById.get(viewing.position_id) : undefined
          }
          canManage={canManage && viewing.id !== me?.id}
          online={onlineIds.has(viewing.id)}
          onBack={() => setViewingId(null)}
          onOpenMember={(id) => setViewingId(id)}
          onEdit={() => setEditing(viewing)}
          onSendReset={() => sendReset(viewing)}
          onToggleStatus={async () => {
            await toggleStatus(viewing);
          }}
          onRemove={async () => {
            await removeUser(viewing);
            setViewingId(null);
          }}
          onEditBrands={() => setBrandsFor(viewing)}
        />
      ) : (
      <>
      {/* Status overview — each card filters the list when clicked. */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Active Users"
          value={counts.active}
          subtitle="Can sign in"
          tone="success"
          onClick={() => pickStatus("active")}
          active={filterStatus === "active"}
        />
        <StatCard
          label="Pending Invites"
          value={counts.invited}
          subtitle="Awaiting first sign-in"
          tone="warning"
          onClick={() => pickStatus("invited")}
          active={filterStatus === "invited"}
        />
        <StatCard
          label="Disabled"
          value={counts.disabled}
          subtitle="Access revoked"
          tone="error"
          onClick={() => pickStatus("disabled")}
          active={filterStatus === "disabled"}
        />
        <StatCard
          label="Total Members"
          value={counts.total}
          subtitle="All accounts"
          onClick={() => setFilterStatus("")}
          active={filterStatus === ""}
        />
      </div>

      {/* Members */}
      <div className="mb-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <h2 className="text-[10px] font-bold uppercase tracking-brand text-accent">
            Members ({filteredMembers.length}/{members.data?.users.length ?? 0})
          </h2>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
              />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search name or email…"
                className="h-7 w-48 rounded-md border border-border bg-surface pl-7 pr-2 text-[11px] text-ink outline-none placeholder:text-ink-muted hover:border-accent/50 focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>

            {/* Filters — everything tucked into one popover to keep the bar tidy */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setFiltersOpen((o) => !o)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border bg-surface px-2.5 text-[11px] font-semibold transition-colors",
                  activeFilters.length > 0
                    ? "border-accent/50 text-accent"
                    : "border-border text-ink-secondary hover:border-accent/40 hover:text-accent",
                )}
              >
                <SlidersHorizontal size={13} /> Filters
                {activeFilters.length > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
                    {activeFilters.length}
                  </span>
                )}
              </button>
              {filtersOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setFiltersOpen(false)}
                    aria-hidden
                  />
                  <div className="absolute right-0 z-40 mt-1.5 w-64 rounded-lg border border-border bg-surface p-3 text-left shadow-slab">
                    <div className="space-y-2.5">
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                          Department
                        </label>
                        <select
                          value={filterDept}
                          onChange={(e) => {
                            setFilterDept(e.target.value ? Number(e.target.value) : "");
                            setFilterPos("");
                          }}
                          className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-accent"
                        >
                          <option value="">All departments</option>
                          {depts.data?.departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                          Position
                        </label>
                        <select
                          value={filterPos}
                          onChange={(e) =>
                            setFilterPos(e.target.value ? Number(e.target.value) : "")
                          }
                          className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-accent"
                        >
                          <option value="">All positions</option>
                          {(positions.data?.positions ?? [])
                            .filter(
                              (p) =>
                                filterDept === "" ||
                                !p.department_id ||
                                p.department_id === filterDept,
                            )
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                          Role
                        </label>
                        <select
                          value={filterRole}
                          onChange={(e) =>
                            setFilterRole(e.target.value ? Number(e.target.value) : "")
                          }
                          className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-accent"
                        >
                          <option value="">All roles</option>
                          {(roles.data?.roles ?? []).map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      {allBrands.length > 0 && (
                        <div>
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                            Brand
                          </label>
                          <select
                            value={filterBrand}
                            onChange={(e) => setFilterBrand(e.target.value)}
                            className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-accent"
                          >
                            <option value="">All brands</option>
                            {allBrands.map((b) => (
                              <option key={b} value={b}>
                                {b}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="mt-3 border-t border-border-subtle pt-3">
                      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                        Quick segments
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {QUICK_SEGMENTS.map(([key, label]) => {
                          const on = quickFilters.has(key);
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => toggleQuick(key)}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                                on
                                  ? "border-accent/50 bg-accent-soft text-accent"
                                  : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                              )}
                            >
                              {on && <Check size={10} className="-ml-0.5" />}
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {activeFilters.length > 0 && (
                      <button
                        type="button"
                        onClick={clearAllFilters}
                        className="mt-3 w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-err/40 hover:text-err"
                      >
                        Clear all filters
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            {view === "grid" && (
              <select
                value={gridSort}
                onChange={(e) => setGridSort(e.target.value as "name" | "recent" | "status")}
                title="Sort cards"
                className="h-7 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none hover:border-accent/50 focus:border-accent"
              >
                <option value="name">Sort: Name</option>
                <option value="recent">Sort: Recently active</option>
                <option value="status">Sort: Status</option>
              </select>
            )}
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              <button
                type="button"
                onClick={() => setView("grid")}
                title="Card grid"
                aria-label="Card grid view"
                className={cn(
                  "inline-flex h-6 w-7 items-center justify-center rounded",
                  view === "grid" ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink",
                )}
              >
                <LayoutGrid size={13} />
              </button>
              <button
                type="button"
                onClick={() => setView("list")}
                title="List"
                aria-label="List view"
                className={cn(
                  "inline-flex h-6 w-7 items-center justify-center rounded",
                  view === "list" ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink",
                )}
              >
                <List size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* Active filters — removable pills so applied filters are visible. */}
        {activeFilters.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
              Filtered by
            </span>
            {activeFilters.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pl-2 pr-1 text-[10.5px] font-medium text-ink-secondary shadow-stone"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                {f.label}
                <button
                  type="button"
                  onClick={f.clear}
                  className="rounded-full p-0.5 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                  aria-label={`Remove ${f.label} filter`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={clearAllFilters}
              className="ml-1 text-[10.5px] text-ink-muted underline-offset-2 transition-colors hover:text-err hover:underline"
            >
              Clear all
            </button>
          </div>
        )}

        {view === "list" ? (
          <DataTable
            tableId="team-members"
            columns={memberColumns}
            rows={members.data ? filteredMembers : null}
            loading={members.loading}
            error={members.error}
            getRowKey={(u) => u.id}
            emptyLabel="No members match these filters."
            exportName="team-members"
          />
        ) : members.loading && !members.data ? (
          <ListSkeleton rows={6} />
        ) : gridMembers.length === 0 ? (
          <EmptyState compact message="No members match these filters." />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {gridMembers.map((u) => (
              <MemberCard
                key={u.id}
                u={u}
                posName={u.position_id != null ? posNameById.get(u.position_id) : undefined}
                isYou={u.id === me?.id}
                online={onlineIds.has(u.id)}
                onOpen={() => setViewingId(u.id)}
              />
            ))}
          </div>
        )}

        {/* Bulk action bar — appears when rows are selected (list view). */}
        {view === "list" && selectedIds.size > 0 && (
          <div className="sticky bottom-3 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-surface px-3 py-2 shadow-slab">
            <span className="text-[12px] font-semibold text-ink">
              {selectedIds.size} selected
            </span>
            {selectedIds.size < selectableFiltered.length && (
              <button
                type="button"
                onClick={selectAllFiltered}
                className="text-[11px] font-medium text-accent hover:underline"
              >
                Select all {selectableFiltered.length}
              </button>
            )}
            <span className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => bulkPatch({ status: "active" }, "Enabled")}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
            >
              <UserCheck size={12} /> Enable
            </button>
            <button
              type="button"
              onClick={() => bulkPatch({ status: "disabled" }, "Disabled")}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
            >
              <UserX size={12} /> Disable
            </button>
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  bulkPatch({ department_id: Number(e.target.value) }, "Department updated");
                  e.target.value = "";
                }
              }}
              className="h-7 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none hover:border-accent/50 focus:border-accent"
            >
              <option value="" disabled>
                Set department…
              </option>
              {depts.data?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  bulkPatch({ position_id: Number(e.target.value) }, "Position updated");
                  e.target.value = "";
                }
              }}
              className="h-7 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none hover:border-accent/50 focus:border-accent"
            >
              <option value="" disabled>
                Set position…
              </option>
              {(positions.data?.positions ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={clearSelect}
              className="ml-1 text-[11px] font-medium text-ink-muted transition-colors hover:text-err"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Pending invitations */}
      <div className="mb-6">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <h2 className="text-[10px] font-bold uppercase tracking-brand text-accent">
            Pending Invitations ({invites.data?.invitations.length ?? 0})
          </h2>
          {canManage && expiredInvites.length > 0 && (
            <button
              type="button"
              onClick={revokeAllExpired}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-err/30 bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-err transition-colors hover:bg-err/10"
            >
              <Trash2 size={12} /> Revoke {expiredInvites.length} expired
            </button>
          )}
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
              <StatusDot
                variant={new Date(inv.expires_at).getTime() < Date.now() ? "error" : "neutral"}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink">{inv.email}</span>
                  <span className="rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                    {inv.role_name}
                  </span>
                  {(() => {
                    const ms = new Date(inv.expires_at).getTime() - Date.now();
                    if (ms < 0) return <Badge tone="error" size="xs">Expired</Badge>;
                    if (ms < 2 * 24 * 60 * 60 * 1000)
                      return <Badge tone="warning" size="xs">Expiring soon</Badge>;
                    return null;
                  })()}
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
      </>
      )}

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

      {editing && (
        <EditMemberPanel
          user={editing}
          departments={depts.data?.departments ?? []}
          positions={positions.data?.positions ?? []}
          members={members.data?.users ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            members.reload();
          }}
          onChanged={() => members.reload()}
          onSendReset={(u) => sendReset(u)}
          onToggleStatus={async (u) => {
            await toggleStatus(u);
            setEditing(null);
          }}
          onRemove={async (u) => {
            await removeUser(u);
            setEditing(null);
          }}
          onEditBrands={(u) => {
            setEditing(null);
            setBrandsFor(u);
          }}
        />
      )}

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

// Bordered column card with a bold header — the right-hand groups on the
// member detail page (reference layout: profile on the left, grouped
// columns on the right).
function DetailCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      <div className="border-b border-border px-4 py-2.5 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
        {title}
      </div>
      <div className="space-y-2.5 px-4 py-3.5">{children}</div>
    </div>
  );
}

// "service_cases.cases" → "Service cases · Cases" for the page-access list.
function prettyPageKey(key: string): string {
  return key
    .split(".")
    .map((part) =>
      part
        .replace(/_/g, " ")
        .replace(/\b\w/, (c) => c.toUpperCase()),
    )
    .join(" · ");
}

function DetailKV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-[12.5px] text-ink">{children}</span>
    </div>
  );
}

/**
 * Full-screen member detail (reference layout, Houzs theme): a profile card
 * on the left, grouped columns on the right — Organisation, Direct reports,
 * Access & Activity. All data comes from the members payload (no extra
 * fetch). Manage actions live on the profile card; clicking a direct report
 * navigates to their detail.
 */
function MemberDetail({
  user,
  members,
  posName,
  canManage,
  online,
  onBack,
  onOpenMember,
  onEdit,
  onSendReset,
  onToggleStatus,
  onRemove,
  onEditBrands,
}: {
  user: TeamMember;
  members: TeamMember[];
  posName?: string;
  canManage: boolean;
  online?: boolean;
  onBack: () => void;
  onOpenMember: (id: number) => void;
  onEdit: () => void;
  onSendReset: () => void;
  onToggleStatus: () => void | Promise<void>;
  onRemove: () => void | Promise<void>;
  onEditBrands: () => void;
}) {
  const reports = members
    .filter((m) => m.manager_id === user.id)
    .slice()
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  // Pages this member can reach, via their position's access matrix.
  const pageAccessQ = useQuery<{ page_access: { page_key: string; level: string }[] }>(
    () =>
      user.position_id != null
        ? api.get(`/api/positions/${user.position_id}/page-access`)
        : Promise.resolve({ page_access: [] }),
    [user.position_id],
  );
  const grantedPages = (pageAccessQ.data?.page_access ?? [])
    .filter((p) => p.level && p.level !== "none")
    .sort((a, b) => a.page_key.localeCompare(b.page_key));

  const tone: "success" | "warning" | "error" | "neutral" =
    user.status === "active"
      ? "success"
      : user.status === "invited"
      ? "warning"
      : user.status === "disabled"
      ? "error"
      : "neutral";
  const statusLabel =
    user.status === "active"
      ? "Active"
      : user.status === "invited"
      ? "Pending invite"
      : user.status === "disabled"
      ? "Disabled"
      : user.status;
  const isActive = user.status === "active";
  const actionCls =
    "inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent";

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} /> Back to members
      </button>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* Profile card */}
        <div className="self-start rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="flex flex-col items-center text-center">
            <span className="relative">
              <Avatar
                userId={user.id}
                hasImage={user.profile_pic_r2_key}
                name={user.name}
                email={user.email}
                size={80}
              />
              {online && (
                <span
                  className="absolute bottom-1 right-1 h-3.5 w-3.5 rounded-full border-2 border-surface bg-synced"
                  title="Online now"
                />
              )}
            </span>
            <h2 className="mt-3 text-[16px] font-bold leading-tight text-ink">
              {user.name || user.email}
            </h2>
            <div className="mt-0.5 text-[12px] text-ink-muted">
              {posName || "—"}
              {user.department_name ? ` · ${user.department_name}` : ""}
            </div>
            <div className="mt-2 flex items-center justify-center gap-1.5">
              <Badge tone={tone} size="sm">
                {statusLabel}
              </Badge>
              {online && (
                <span className="text-[11px] font-medium text-synced">● Online</span>
              )}
            </div>
            {user.status === "disabled" && user.status_reason && (
              <div className="mt-2 w-full rounded-md border border-err/20 bg-err/5 px-2.5 py-1.5 text-left text-[11px] text-err">
                <span className="font-semibold">Disabled:</span> {user.status_reason}
              </div>
            )}
          </div>

          <div className="mt-4 space-y-2 border-t border-border-subtle pt-4">
            {user.phone && (
              <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <Phone size={12} className="shrink-0 text-ink-muted" />
                <span className="truncate">{user.phone}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
              <Mail size={12} className="shrink-0 text-ink-muted" />
              <span className="truncate">{user.email}</span>
            </div>
          </div>

          {canManage && (
            <div className="mt-4 grid gap-2 border-t border-border-subtle pt-4">
              <Button variant="brass" className="w-full" icon={<Pencil size={13} />} onClick={onEdit}>
                Edit member
              </Button>
              <button type="button" onClick={onEditBrands} className={actionCls}>
                <Tag size={13} /> Brand access…
              </button>
              {user.status !== "invited" && (
                <button type="button" onClick={onSendReset} className={actionCls}>
                  <KeyRound size={13} /> Reset password
                </button>
              )}
              <button type="button" onClick={onToggleStatus} className={actionCls}>
                {isActive ? <UserX size={13} /> : <UserCheck size={13} />}
                {isActive ? "Disable account" : "Enable account"}
              </button>
              <button
                type="button"
                onClick={onRemove}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-err/30 bg-surface px-3 py-2 text-[12px] font-semibold text-err transition-colors hover:bg-err/10"
              >
                <Trash2 size={13} /> Delete permanently
              </button>
            </div>
          )}
        </div>

        {/* Grouped columns */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <DetailCol title="Organisation">
            <DetailKV label="Department">
              {user.department_name ? (
                <span className="inline-flex items-center gap-1.5">
                  {user.department_color && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: `#${user.department_color}` }}
                    />
                  )}
                  {user.department_name}
                </span>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </DetailKV>
            <DetailKV label="Position">{posName || <span className="text-ink-muted">—</span>}</DetailKV>
            <DetailKV label="Role">{user.role_name || <span className="text-ink-muted">—</span>}</DetailKV>
            <DetailKV label="Reports to">
              {user.manager_name || user.manager_email || <span className="text-ink-muted">—</span>}
            </DetailKV>
          </DetailCol>

          <DetailCol title={`Direct reports (${reports.length})`}>
            {reports.length === 0 ? (
              <div className="py-1 text-[12px] text-ink-muted">No direct reports.</div>
            ) : (
              reports.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onOpenMember(r.id)}
                  className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent-soft/40"
                >
                  <Avatar
                    userId={r.id}
                    hasImage={r.profile_pic_r2_key}
                    name={r.name}
                    email={r.email}
                    size={28}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-ink">
                      {r.name || r.email}
                    </span>
                    <span className="block truncate text-[10.5px] text-ink-muted">
                      {r.position_name || r.department_name || r.email}
                    </span>
                  </span>
                </button>
              ))
            )}
          </DetailCol>

          <DetailCol title={`Page access (${grantedPages.length})`}>
            {pageAccessQ.loading ? (
              <div className="py-1 text-[12px] text-ink-muted">Loading…</div>
            ) : user.position_id == null ? (
              <div className="py-1 text-[12px] text-ink-muted">
                No position set — no page access.
              </div>
            ) : grantedPages.length === 0 ? (
              <div className="py-1 text-[12px] text-ink-muted">No pages granted.</div>
            ) : (
              <div className="space-y-1.5">
                {grantedPages.map((p) => (
                  <div
                    key={p.page_key}
                    className="flex items-center justify-between gap-2 text-[12px]"
                  >
                    <span className="truncate text-ink-secondary">
                      {prettyPageKey(p.page_key)}
                    </span>
                    <Badge
                      tone={p.level === "full" ? "accent" : p.level === "edit" ? "success" : "neutral"}
                      size="xs"
                    >
                      {p.level}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
            <div className="border-t border-border-subtle pt-2.5">
              <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                Brand access
              </span>
              {user.brands.length === 0 ? (
                <span className="text-[12px] text-ink-muted">No brand restriction</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {user.brands.map((b) => (
                    <Badge key={b} tone="neutral" size="xs" caseless>
                      {b}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </DetailCol>

          <DetailCol title="Timeline">
            <DetailKV label="Created">{relativeTime(user.created_at)}</DetailKV>
            {user.invited_at && (
              <DetailKV label="Invited">{relativeTime(user.invited_at)}</DetailKV>
            )}
            {(user.invited_by_name || user.invited_by_email) && (
              <DetailKV label="Invited by">
                {user.invited_by_name || user.invited_by_email}
              </DetailKV>
            )}
            <DetailKV label="Joined">
              {user.joined_at ? relativeTime(user.joined_at) : <span className="text-ink-muted">—</span>}
            </DetailKV>
            <DetailKV label="Last sign-in">
              {user.last_login_at ? relativeTime(user.last_login_at) : "never"}
            </DetailKV>
            <DetailKV label="Presence">
              {online ? (
                <span className="font-medium text-synced">Online now</span>
              ) : (
                <span className="text-ink-muted">Offline</span>
              )}
            </DetailKV>
          </DetailCol>
        </div>
      </div>
    </div>
  );
}

/**
 * Member card for the grid view (reference layout, Houzs theme). Avatar +
 * name + position, contact lines, a status chip, and a hover "Edit" hint.
 * Clicking opens the Edit Member panel when the viewer can manage.
 */
function MemberCard({
  u,
  posName,
  isYou,
  online,
  onOpen,
}: {
  u: TeamMember;
  posName?: string;
  isYou: boolean;
  online?: boolean;
  onOpen: () => void;
}) {
  const tone: "success" | "warning" | "error" | "neutral" =
    u.status === "active"
      ? "success"
      : u.status === "invited"
      ? "warning"
      : u.status === "disabled"
      ? "error"
      : "neutral";
  const label =
    u.status === "active"
      ? "Active"
      : u.status === "invited"
      ? "Pending"
      : u.status === "disabled"
      ? "Disabled"
      : u.status;
  const inner = (
    <>
      <span className="absolute right-2 top-2">
        <Badge tone={tone} size="xs">
          {label}
        </Badge>
      </span>
      <span className="relative">
        <Avatar
          userId={u.id}
          hasImage={u.profile_pic_r2_key}
          name={u.name}
          email={u.email}
          size={56}
        />
        {online && (
          <span
            className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-surface bg-synced"
            title="Online now"
          />
        )}
      </span>
      <div className="mt-2.5 w-full px-1">
        <div className="flex items-center justify-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-ink">
            {u.name || u.email}
          </span>
          {isYou && (
            <span className="shrink-0 rounded bg-accent-soft px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wider text-accent-ink">
              You
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-ink-muted">
          {posName || u.department_name || "—"}
        </div>
      </div>
      <div className="mt-2.5 w-full space-y-1 border-t border-border-subtle pt-2.5 text-left">
        {u.phone && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
            <Phone size={11} className="shrink-0 text-ink-muted" />
            <span className="truncate">{u.phone}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <Mail size={11} className="shrink-0 text-ink-muted" />
          <span className="truncate">{u.email}</span>
        </div>
      </div>
      <span className="pointer-events-none mt-2.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted opacity-0 transition-opacity group-hover:text-accent group-hover:opacity-100">
        View details
      </span>
    </>
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group relative flex flex-col items-center rounded-lg border border-border bg-surface p-4 text-center shadow-stone transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-slab",
        u.status === "disabled" && "opacity-70",
      )}
    >
      {inner}
    </button>
  );
}

/**
 * Edit Member side panel — the single hub for one member. Replaces the
 * inline per-row <select>s + the four text action buttons that cluttered
 * the table. Editable fields (name/email/phone/department/position/
 * reports-to) save in ONE PATCH; account actions (brands, reset, disable,
 * delete) are handed in from the parent so their confirms/toasts stay put.
 */
function EditMemberPanel({
  user,
  departments,
  positions,
  members,
  onClose,
  onSaved,
  onChanged,
  onSendReset,
  onToggleStatus,
  onRemove,
  onEditBrands,
}: {
  user: TeamMember;
  departments: Department[];
  positions: Position[];
  members: TeamMember[];
  onClose: () => void;
  onSaved: () => void;
  /** Reload the list without closing the panel (e.g. after a photo change). */
  onChanged: () => void;
  onSendReset: (u: TeamMember) => void;
  onToggleStatus: (u: TeamMember) => void | Promise<void>;
  onRemove: (u: TeamMember) => void | Promise<void>;
  onEditBrands: (u: TeamMember) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(user.name || "");
  const [email, setEmail] = useState(user.email || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [deptId, setDeptId] = useState<number | "">(user.department_id ?? "");
  const [positionId, setPositionId] = useState<number | "">(user.position_id ?? "");
  const [managerId, setManagerId] = useState<number | "">(user.manager_id ?? "");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [picBusy, setPicBusy] = useState(false);
  const [picBump, setPicBump] = useState(0);

  async function uploadPic(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be under 5 MB");
      return;
    }
    setPicBusy(true);
    try {
      await api.putBinary(
        `/api/users/${user.id}/profile-pic?name=${encodeURIComponent(file.name)}`,
        file,
        file.type,
      );
      setPicBump((n) => n + 1); // remount the preview avatar to bust its cache
      onChanged();
      toast.success("Photo updated");
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setPicBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const inputCls =
    "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";
  const labelCls =
    "mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";
  const actionCls =
    "inline-flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent";

  async function save() {
    const em = email.toLowerCase().trim();
    if (!em || !em.includes("@")) {
      toast.error("A valid email is required");
      return;
    }
    const patch: Record<string, unknown> = {};
    if (name.trim() !== (user.name || "")) patch.name = name.trim() || null;
    if (em !== (user.email || "")) patch.email = em;
    if (phone.trim() !== (user.phone || "")) patch.phone = phone.trim() || null;
    if ((deptId || null) !== (user.department_id ?? null)) patch.department_id = deptId || null;
    if ((positionId || null) !== (user.position_id ?? null)) patch.position_id = positionId || null;
    if ((managerId || null) !== (user.manager_id ?? null)) patch.manager_id = managerId || null;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/api/users/${user.id}`, patch);
      toast.success(`Saved ${name.trim() || em}`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const isActive = user.status === "active";

  return (
    <Panel
      open
      onClose={onClose}
      title={user.name || user.email}
      subtitle="Edit member"
      width={440}
    >
      <PanelSection title="Details">
        <div className="flex items-center gap-3">
          <Avatar
            key={picBump}
            userId={user.id}
            hasImage={user.profile_pic_r2_key}
            name={user.name}
            email={user.email}
            size={52}
          />
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPic(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={picBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent disabled:opacity-50"
            >
              {picBusy ? "Uploading…" : "Change photo"}
            </button>
            <div className="mt-1 text-[10px] text-ink-muted">JPG/PNG, under 5 MB.</div>
          </div>
        </div>
        <div>
          <label className={labelCls}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="member@houzscentury.com"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Phone</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 012-345 6789 (optional)"
            className={inputCls}
          />
        </div>
      </PanelSection>

      <PanelSection title="Organisation">
        <div>
          <label className={labelCls}>Department</label>
          <select
            value={deptId}
            onChange={(e) => {
              setDeptId(e.target.value ? Number(e.target.value) : "");
              setPositionId(""); // positions are department-scoped — reset
            }}
            className={inputCls}
          >
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Position</label>
          <select
            value={positionId}
            onChange={(e) => setPositionId(e.target.value ? Number(e.target.value) : "")}
            className={inputCls}
          >
            <option value="">— None —</option>
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
          <label className={labelCls}>Reports to</label>
          <select
            value={managerId}
            onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : "")}
            className={inputCls}
          >
            <option value="">— None —</option>
            {members
              .filter((m) => m.id !== user.id && m.status !== "disabled")
              .slice()
              .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.email}
                </option>
              ))}
          </select>
        </div>
      </PanelSection>

      <div className="pb-1">
        <Button variant="brass" className="w-full" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save Changes"}
        </Button>
      </div>

      <PanelSection title="Account">
        <button type="button" onClick={() => onEditBrands(user)} className={actionCls}>
          <Tag size={13} /> Brand access…
        </button>
        {user.status !== "invited" && (
          <button type="button" onClick={() => onSendReset(user)} className={actionCls}>
            <KeyRound size={13} /> Send password reset link
          </button>
        )}
        <button type="button" onClick={() => onToggleStatus(user)} className={actionCls}>
          {isActive ? <UserX size={13} /> : <UserCheck size={13} />}
          {isActive ? "Disable account" : "Enable account"}
        </button>
        <button
          type="button"
          onClick={() => onRemove(user)}
          className="inline-flex w-full items-center gap-2 rounded-md border border-err/30 bg-surface px-3 py-2 text-[12px] font-semibold text-err transition-colors hover:bg-err/10"
        >
          <Trash2 size={13} /> Delete permanently
        </button>
      </PanelSection>
    </Panel>
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
  const [zoom, setZoom] = useState(1);
  // "list" = vertical indented collapsible tree (default) · "chart" = the
  // classic horizontal org chart. Choice persists per user.
  const [orgView, setOrgView] = useLocalStorage<"list" | "chart">("team:orgView", "list");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggleCollapse = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

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

  async function changeDept(userId: number, departmentId: number | null) {
    const current = byId.get(userId);
    if (!current || (current.department_id ?? null) === departmentId) return;
    try {
      await api.patch(`/api/users/${userId}`, { department_id: departmentId });
      const name = departmentId
        ? (depts.data?.departments.find((d) => d.id === departmentId)?.name ?? "department")
        : null;
      toast.success(
        name
          ? `${current.name || current.email} → ${name}`
          : `${current.name || current.email} removed from department`,
      );
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update department");
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
        <>
          {/* Controls: view toggle · export · (zoom | collapse) */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              <button
                type="button"
                onClick={() => setOrgView("list")}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-semibold transition-colors",
                  orgView === "list" ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink",
                )}
              >
                <ListTree size={12} /> Tree
              </button>
              <button
                type="button"
                onClick={() => setOrgView("chart")}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-semibold transition-colors",
                  orgView === "chart" ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink",
                )}
              >
                <Network size={12} /> Chart
              </button>
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  // Shrink the tree to fit one landscape page so a wide chart
                  // isn't clipped (see the @media print rule in index.css).
                  const el = document.querySelector(".org-print-scale") as HTMLElement | null;
                  if (el)
                    el.style.setProperty(
                      "--print-zoom",
                      String(Math.min(1, 1000 / (el.scrollWidth || 1))),
                    );
                  window.print();
                }}
                className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
                title="Export as PDF or print"
              >
                <Printer size={13} strokeWidth={2} />
                Export
              </button>
              {orgView === "chart" ? (
                <>
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-[15px] leading-none text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
                    title="Zoom out"
                    aria-label="Zoom out"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom(1)}
                    className="inline-flex h-7 min-w-[3.25rem] items-center justify-center rounded-md border border-border bg-surface text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
                    title="Reset zoom to 100%"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-[15px] leading-none text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
                    title="Zoom in"
                    aria-label="Zoom in"
                  >
                    +
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed(
                        new Set(
                          users
                            .filter((u) => (childrenOf.get(u.id) ?? []).length > 0)
                            .map((u) => u.id),
                        ),
                      )
                    }
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
                  >
                    Collapse all
                  </button>
                  <button
                    type="button"
                    onClick={() => setCollapsed(new Set())}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
                  >
                    Expand all
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="org-print-area thin-scroll overflow-auto pb-6">
            {orgView === "chart" ? (
              <div
                className="org-print-scale mx-auto flex min-w-fit items-start justify-center gap-10 px-4 pt-2"
                style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
              >
                {roots.map((r) => (
                  <OrgTreeNode
                    key={r.id}
                    user={r}
                    childrenOf={childrenOf}
                    canManage={canManage}
                    users={users}
                    departments={deptList}
                    onChangeDept={changeDept}
                    draggingId={draggingId}
                    setDraggingId={setDraggingId}
                    onDrop={reassign}
                    editingId={editingId}
                    setEditingId={setEditingId}
                    onPickManager={reassign}
                  />
                ))}
              </div>
            ) : (
              <div className="org-print-scale mx-auto max-w-3xl rounded-lg border border-border bg-surface p-1.5 shadow-stone">
                {roots.map((r) => (
                  <OrgListNode
                    key={r.id}
                    user={r}
                    depth={0}
                    childrenOf={childrenOf}
                    collapsed={collapsed}
                    toggleCollapse={toggleCollapse}
                    canManage={canManage}
                    users={users}
                    departments={deptList}
                    onChangeDept={changeDept}
                    draggingId={draggingId}
                    setDraggingId={setDraggingId}
                    onDrop={reassign}
                    editingId={editingId}
                    setEditingId={setEditingId}
                    onPickManager={reassign}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="text-[10.5px] text-ink-muted">
        <span className="font-semibold">Tip:</span> drag any row/card onto another
        to reassign reporting; drop on the strip at the top to make them top-level.
        In Tree view, use the chevrons to fold a branch.
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
  departments,
  onChangeDept,
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
  departments: Department[];
  onChangeDept: (userId: number, departmentId: number | null) => void;
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
        departments={departments}
        onChangeDept={onChangeDept}
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
                    departments={departments}
                    onChangeDept={onChangeDept}
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
  departments,
  onChangeDept,
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
  departments: Department[];
  onChangeDept: (userId: number, departmentId: number | null) => void;
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
        "relative w-[250px] shrink-0 overflow-hidden rounded-lg border bg-surface shadow-stone transition-all",
        isDragSource && "opacity-50",
        dropHover && isValidDropTarget ? "border-accent ring-2 ring-accent/30" : "border-border",
        canManage && "cursor-grab active:cursor-grabbing",
      )}
    >
      {/* Department colour accent bar across the top (reference look). */}
      <span
        aria-hidden
        className="block h-1.5 w-full"
        style={{
          backgroundColor: user.department_color ? `#${user.department_color}` : "transparent",
        }}
      />
      <div className="flex items-start gap-2.5 p-2.5">
        <Avatar
          userId={user.id}
          hasImage={user.profile_pic_r2_key}
          name={user.name}
          email={user.email}
          size={42}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <span
              title={user.name || user.email}
              className="line-clamp-2 min-w-0 flex-1 break-words text-[12.5px] font-bold leading-snug text-ink"
            >
              {user.name || user.email}
            </span>
            {user.status !== "active" && (
              <span className="shrink-0 rounded bg-bg px-1 py-px font-mono text-[9px] font-semibold uppercase text-ink-muted">
                {user.status}
              </span>
            )}
            {canManage && !editing && (
              <button
                onClick={() => setEditing(true)}
                className="-mr-0.5 -mt-0.5 shrink-0 rounded p-0.5 text-ink-muted transition-colors hover:bg-surface-dim hover:text-accent"
                aria-label="Edit reporting & department"
                title="Edit reporting & department"
              >
                <Pencil size={11} />
              </button>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] font-medium text-ink-secondary">
            {user.position_name || user.role_name}
          </div>
          {user.phone && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-ink-muted">
              <Phone size={9} className="shrink-0" />
              <span className="truncate">{user.phone}</span>
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-muted">
            {user.department_name ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                {user.department_color && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: `#${user.department_color}` }}
                  />
                )}
                <span className="truncate">{user.department_name}</span>
              </span>
            ) : (
              <span className="text-ink-muted/70">No department</span>
            )}
            {reportsCount > 0 && (
              <span className="shrink-0">
                · {reportsCount} report{reportsCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <div className="space-y-2 border-t border-border-subtle bg-bg/60 px-3 py-2.5">
          <div>
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
              className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[11px] text-ink outline-none focus:border-accent"
            >
              <option value="">— No manager —</option>
              {users
                .filter((m) => m.id !== user.id && !isDescendantOf(m.id, user.id, users))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.email}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
              Department
            </label>
            <select
              defaultValue={user.department_id ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onChangeDept(user.id, v ? Number(v) : null);
              }}
              className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[11px] text-ink outline-none focus:border-accent"
            >
              <option value="">— No department —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-[10px] text-ink-muted hover:text-ink"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

// Vertical indented row in the "Tree" org view — compact + collapsible,
// shares the drag-to-reassign + manager-picker behaviour with OrgCard.
function OrgListNode({
  user,
  depth,
  childrenOf,
  collapsed,
  toggleCollapse,
  canManage,
  users,
  departments,
  onChangeDept,
  draggingId,
  setDraggingId,
  onDrop,
  editingId,
  setEditingId,
  onPickManager,
}: {
  user: TeamMember;
  depth: number;
  childrenOf: Map<number | null, TeamMember[]>;
  collapsed: Set<number>;
  toggleCollapse: (id: number) => void;
  canManage: boolean;
  users: TeamMember[];
  departments: Department[];
  onChangeDept: (userId: number, departmentId: number | null) => void;
  draggingId: number | null;
  setDraggingId: (id: number | null) => void;
  onDrop: (userId: number, managerId: number | null) => void;
  editingId: number | null;
  setEditingId: (id: number | null) => void;
  onPickManager: (userId: number, managerId: number | null) => void;
}) {
  const kids = childrenOf.get(user.id) ?? [];
  const hasKids = kids.length > 0;
  const isCollapsed = collapsed.has(user.id);
  const editing = editingId === user.id;
  const [dropHover, setDropHover] = useState(false);
  const isDragSource = draggingId === user.id;
  const isValidDropTarget =
    draggingId != null && draggingId !== user.id && !isDescendantOf(user.id, draggingId, users);

  return (
    <div>
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
          "group flex items-center gap-2 rounded-md py-1 pl-1 pr-2 transition-colors",
          isDragSource && "opacity-50",
          dropHover && isValidDropTarget ? "bg-accent-soft ring-1 ring-accent/30" : "hover:bg-bg/50",
          canManage && "cursor-grab active:cursor-grabbing",
        )}
      >
        <button
          type="button"
          onClick={() => hasKids && toggleCollapse(user.id)}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted",
            hasKids ? "hover:bg-surface-dim hover:text-accent" : "invisible",
          )}
          aria-label={isCollapsed ? "Expand" : "Collapse"}
          tabIndex={hasKids ? 0 : -1}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="relative shrink-0">
          {user.department_color && (
            <span
              className="absolute -left-1 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded"
              style={{ backgroundColor: `#${user.department_color}` }}
            />
          )}
          <Avatar
            userId={user.id}
            hasImage={user.profile_pic_r2_key}
            name={user.name}
            email={user.email}
            size={28}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-ink">
              {user.name || user.email}
            </span>
            {user.status !== "active" && (
              <span className="shrink-0 rounded bg-bg px-1 py-px font-mono text-[8.5px] font-semibold uppercase text-ink-muted">
                {user.status}
              </span>
            )}
          </div>
          <div className="truncate text-[10.5px] text-ink-muted">
            {user.position_name || user.role_name}
            {user.department_name ? ` · ${user.department_name}` : ""}
          </div>
        </div>
        {hasKids && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-dim px-2 py-0.5 text-[10px] text-ink-muted"
            title={`${kids.length} direct report${kids.length === 1 ? "" : "s"}`}
          >
            <UsersIcon size={11} /> {kids.length}
          </span>
        )}
        {canManage && !editing && (
          <button
            type="button"
            onClick={() => setEditingId(user.id)}
            className="shrink-0 rounded p-1 text-ink-muted opacity-0 transition-opacity hover:bg-surface-dim hover:text-accent group-hover:opacity-100"
            aria-label="Edit reporting & department"
            title="Edit reporting & department"
          >
            <Pencil size={11} />
          </button>
        )}
      </div>

      {editing && (
        <div className="mb-1 ml-7 max-w-xs space-y-2 rounded-md border border-border bg-bg/60 px-2 py-2">
          <div>
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
              className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[11px] text-ink outline-none focus:border-accent"
            >
              <option value="">— No manager —</option>
              {users
                .filter((m) => m.id !== user.id && !isDescendantOf(m.id, user.id, users))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.email}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
              Department
            </label>
            <select
              defaultValue={user.department_id ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onChangeDept(user.id, v ? Number(v) : null);
              }}
              className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[11px] text-ink outline-none focus:border-accent"
            >
              <option value="">— No department —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setEditingId(null)}
            className="block text-[10px] text-ink-muted hover:text-ink"
          >
            Done
          </button>
        </div>
      )}

      {hasKids && !isCollapsed && (
        <div className="ml-[15px] border-l border-border-subtle pl-2">
          {kids.map((k) => (
            <OrgListNode
              key={k.id}
              user={k}
              depth={depth + 1}
              childrenOf={childrenOf}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              canManage={canManage}
              users={users}
              departments={departments}
              onChangeDept={onChangeDept}
              draggingId={draggingId}
              setDraggingId={setDraggingId}
              onDrop={onDrop}
              editingId={editingId}
              setEditingId={setEditingId}
              onPickManager={onPickManager}
            />
          ))}
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
export function InvitePanel({
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
