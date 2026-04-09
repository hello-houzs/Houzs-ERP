import { useState } from "react";
import { Plus, Copy, Trash2, UserX, UserCheck, X } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { StatusDot } from "../components/StatusDot";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn, relativeTime } from "../lib/utils";
import type { TeamMember, Invitation, Role } from "../types";

export function Team() {
  const { user: me, can } = useAuth();
  const toast = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);

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
    if (!confirm(`Remove ${u.email}? This cannot be undone.`)) return;
    try {
      await api.del(`/api/users/${u.id}`);
      toast.success(`${u.email} removed`);
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function revokeInvite(inv: Invitation) {
    if (!confirm(`Revoke invitation for ${inv.email}?`)) return;
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
      <PageHeader
        eyebrow="Workspace · Members"
        title="Team"
        description="Manage who can access this workspace and what they can do."
        actions={
          canManage && (
            <Button
              variant="brass"
              icon={<Plus size={14} />}
              onClick={() => setInviteOpen(true)}
            >
              Invite Member
            </Button>
          )
        }
      />

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
                <select
                  value={u.role_id}
                  onChange={(e) => changeRole(u, Number(e.target.value))}
                  className="h-8 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] font-semibold text-ink outline-none transition-colors hover:border-accent/50 focus:border-accent focus:ring-2 focus:ring-accent/20"
                >
                  {roles.data?.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="rounded bg-accent-soft px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent-ink">
                  {u.role_name}
                </span>
              )}
              {canManage && u.id !== me?.id && (
                <div className="flex items-center gap-1">
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
        onClose={() => setInviteOpen(false)}
        roles={roles.data?.roles ?? []}
        onInvited={() => {
          setInviteOpen(false);
          reload();
        }}
      />
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

  // Default to the first non-system role if available, otherwise the first role.
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
