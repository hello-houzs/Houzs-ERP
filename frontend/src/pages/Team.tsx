import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Copy, Trash2, UserX, UserCheck, X, KeyRound, ChevronDown, ChevronRight } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { StatusDot } from "../components/StatusDot";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { relativeTime, cn } from "../lib/utils";
import type { TeamMember, Invitation, Role } from "../types";
import { RolesTab } from "./Roles";

type TeamTabValue = "members" | "roles" | "orgchart";

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
  const [params, setParams] = useSearchParams();

  const canUsers = can("users.read");
  const canRoles = can("roles.read");
  const canManageUsers = can("users.manage");
  const canManageRoles = can("roles.manage");

  const raw = params.get("tab") as TeamTabValue | null;
  const active: TeamTabValue =
    raw && ["members", "roles", "orgchart"].includes(raw)
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

  const tabs: TabOption<TeamTabValue>[] = [
    { value: "members", label: "Members", show: canUsers },
    { value: "orgchart", label: "Org Chart", show: canUsers },
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
    orgchart: {
      eyebrow: "Workspace · Hierarchy",
      title: "Org Chart",
      description:
        "Who reports to whom. Reporting lines drive project access — a user sees projects where they or their manager is the PIC (when their role is scoped).",
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
    ) : canManageRoles ? (
      <Button
        variant="brass"
        icon={<Plus size={14} />}
        onClick={() => setCreatingRole(true)}
      >
        New Role
      </Button>
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
      {active === "orgchart" && canUsers && <OrgChartTab />}
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
      }>(`/api/users/${u.id}/reset-password`);
      const link = `${window.location.origin}${res.reset_path}`;
      try {
        await navigator.clipboard.writeText(link);
        toast.success(`Reset link sent to ${u.email} and copied to clipboard`);
      } catch {
        toast.success(`Reset link sent to ${u.email}`);
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
    if (!(await dialog.confirm(`Remove ${u.email}? This cannot be undone.`))) return;
    try {
      await api.del(`/api/users/${u.id}`);
      toast.success(`${u.email} removed`);
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

  function copyInviteLink(token: string) {
    const link = `${window.location.origin}/#invite=${token}`;
    navigator.clipboard.writeText(link).then(
      () => toast.success("Invite link copied to clipboard"),
      () => toast.error("Could not access clipboard")
    );
  }

  return (
    <div>
      {/* Active members */}
      <div className="mb-6">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Members ({members.data?.users.length ?? 0})
          </h2>
        </div>
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
          {members.loading && (
            <div className="px-5 py-6 text-sm text-ink-muted">Loading…</div>
          )}
          {members.error && (
            <div className="px-5 py-4 text-sm text-err">{members.error}</div>
          )}
          {members.data?.users.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-4 last:border-b-0 sm:flex-nowrap sm:gap-4 sm:px-5"
            >
              <StatusDot
                variant={
                  u.status === "active"
                    ? "synced"
                    : u.status === "disabled"
                    ? "error"
                    : "neutral"
                }
              />
              <div className="min-w-0 flex-1 basis-[calc(100%-40px)] sm:basis-auto">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">
                    {u.name || u.email}
                  </span>
                  {u.id === me?.id && (
                    <span className="rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                      You
                    </span>
                  )}
                  {u.status !== "active" && (
                    <span className="rounded bg-bg px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                      {u.status}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-ink-muted">
                  {u.email} · last seen{" "}
                  {u.last_login_at ? relativeTime(u.last_login_at) : "never"}
                </div>
              </div>
              {canManage && u.id !== me?.id ? (
                <>
                  <select
                    value={u.role_id}
                    onChange={(e) => changeRole(u, Number(e.target.value))}
                    title="Role"
                    className="h-8 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] font-semibold text-ink outline-none transition-colors hover:border-accent/50 focus:border-accent focus:ring-2 focus:ring-accent/20"
                  >
                    {roles.data?.roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={u.manager_id ?? ""}
                    onChange={(e) =>
                      changeManager(
                        u,
                        e.target.value ? Number(e.target.value) : null
                      )
                    }
                    title="Reports to"
                    className="h-8 max-w-[180px] cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none transition-colors hover:border-accent/50 focus:border-accent focus:ring-2 focus:ring-accent/20"
                  >
                    <option value="">— No manager —</option>
                    {(members.data?.users ?? [])
                      .filter(
                        (m) =>
                          m.id !== u.id &&
                          m.status === "active" &&
                          // Hide this user's descendants to pre-empt cycles.
                          // Backend does the authoritative check; this is UX.
                          !isDescendantOf(m.id, u.id, members.data?.users ?? [])
                      )
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.email}
                        </option>
                      ))}
                  </select>
                </>
              ) : (
                <>
                  <span className="rounded bg-accent-soft px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent-ink">
                    {u.role_name}
                  </span>
                  {u.manager_name && (
                    <span
                      className="truncate text-[10.5px] text-ink-muted"
                      title={`Reports to ${u.manager_name}`}
                    >
                      → {u.manager_name}
                    </span>
                  )}
                </>
              )}
              {canManage && u.id !== me?.id && (
                <div className="flex items-center gap-1">
                  {u.status !== "invited" && (
                    <button
                      onClick={() => sendReset(u)}
                      className="rounded p-1.5 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
                      aria-label="Send password reset"
                      title="Send password reset link"
                    >
                      <KeyRound size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => toggleStatus(u)}
                    className="rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-dim hover:text-ink"
                    aria-label={u.status === "active" ? "Disable" : "Enable"}
                    title={u.status === "active" ? "Disable user" : "Enable user"}
                  >
                    {u.status === "active" ? <UserX size={14} /> : <UserCheck size={14} />}
                  </button>
                  <button
                    onClick={() => removeUser(u)}
                    className="rounded p-1.5 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                    aria-label="Remove"
                    title="Remove user"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
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
                </div>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => copyInviteLink(inv.token)}
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
        onInvited={() => {
          onCloseInvite();
          reload();
        }}
      />
    </div>
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
// Org Chart tab — recursive nested tree of reporting lines
// ──────────────────────────────────────────────────────────

function OrgChartTab() {
  const members = useQuery<{ users: TeamMember[] }>(() => api.get("/api/users"));
  const users = (members.data?.users ?? []).filter((u) => u.status !== "disabled");

  // Roots: users with no manager. Any user whose manager_id points at
  // someone not in the active set also gets re-rooted so no-one is
  // invisible. Walk up once to find each user's highest visible ancestor.
  const { roots, childrenOf } = useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u]));
    const childrenOf = new Map<number | null, TeamMember[]>();
    for (const u of users) {
      const parentId =
        u.manager_id != null && byId.has(u.manager_id) ? u.manager_id : null;
      const arr = childrenOf.get(parentId) ?? [];
      arr.push(u);
      childrenOf.set(parentId, arr);
    }
    // Sort every sibling group alphabetically so the tree is stable.
    for (const arr of childrenOf.values()) {
      arr.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    }
    const roots = childrenOf.get(null) ?? [];
    return { roots, childrenOf };
  }, [users]);

  if (members.loading) {
    return <div className="text-[12px] text-ink-muted">Loading…</div>;
  }
  if (members.error) {
    return <div className="text-[12px] text-err">{members.error}</div>;
  }
  if (!roots.length) {
    return (
      <div className="rounded-md border border-border bg-surface px-5 py-8 text-center text-[12px] text-ink-muted">
        No one reports to anyone yet. Head to the <b>Members</b> tab and set a
        manager on each user — the tree builds itself from there.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {roots.map((r) => (
        <OrgNode key={r.id} user={r} depth={0} childrenOf={childrenOf} />
      ))}
    </div>
  );
}

function OrgNode({
  user,
  depth,
  childrenOf,
}: {
  user: TeamMember;
  depth: number;
  childrenOf: Map<number | null, TeamMember[]>;
}) {
  const kids = childrenOf.get(user.id) ?? [];
  const [open, setOpen] = useState(true);

  const initial = (user.name || user.email).slice(0, 1).toUpperCase();

  return (
    <div className="relative">
      <div
        className={cn(
          "flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 shadow-stone",
          depth > 0 && "ml-6"
        )}
      >
        {kids.length > 0 ? (
          <button
            onClick={() => setOpen(!open)}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-surface-dim hover:text-accent"
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="inline-block h-5 w-5" aria-hidden />
        )}
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[11px] font-bold text-accent-ink">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[12.5px] font-semibold text-ink">
              {user.name || user.email}
            </span>
            {user.status !== "active" && (
              <span className="rounded bg-bg px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                {user.status}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-ink-muted">
            {user.email}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wider text-accent-ink">
            {user.role_name}
          </span>
          {kids.length > 0 && (
            <span
              className="font-mono text-[10px] text-ink-muted"
              title={`${kids.length} direct report${kids.length === 1 ? "" : "s"}`}
            >
              {kids.length}
            </span>
          )}
        </div>
      </div>
      {open && kids.length > 0 && (
        <div className="relative mt-1.5 space-y-1.5 border-l border-border-subtle pl-0 ml-4">
          {kids.map((k) => (
            <OrgNode
              key={k.id}
              user={k}
              depth={depth + 1}
              childrenOf={childrenOf}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Invite panel
// ──────────────────────────────────────────────────────────
function InvitePanel({
  open,
  onClose,
  roles,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  roles: Role[];
  onInvited: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ token: string; email: string } | null>(null);

  if (roleId === "" && roles.length > 0) {
    const defaultRole = roles.find((r) => !r.is_system) || roles[0];
    setRoleId(defaultRole.id);
  }

  async function submit() {
    if (!email || !roleId) {
      toast.error("Email and role are required");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ token: string; email: string }>(
        "/api/users/invite",
        { email: email.toLowerCase().trim(), role_id: roleId }
      );
      setIssued(res);
      toast.success(`Invitation issued for ${res.email}`);
      onInvited();
    } catch (e: any) {
      toast.error(e?.message || "Failed to invite");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setEmail("");
    setIssued(null);
    onClose();
  }

  function copyLink() {
    if (!issued) return;
    const link = `${window.location.origin}/#invite=${issued.token}`;
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
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="member@example.com"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Role
            </label>
            <select
              value={roleId}
              onChange={(e) => setRoleId(Number(e.target.value))}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
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
            Send this link to <span className="font-semibold text-ink">{issued.email}</span>.
            They'll be prompted to set a password and join the workspace.
          </p>
          <div className="rounded-md border border-border bg-bg p-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Invite Link
            </div>
            <div className="break-all font-mono text-[11px] text-ink">
              {`${window.location.origin}/#invite=${issued.token}`}
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
