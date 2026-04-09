import { useMemo, useState } from "react";
import { Plus, Trash2, Lock, Shield } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/utils";
import type { Role, PermissionDef } from "../types";

export function Roles() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can("roles.manage");

  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);

  const rolesQ = useQuery<{ roles: Role[] }>(() => api.get("/api/roles"));
  const permsQ = useQuery<{ permissions: PermissionDef[] }>(() =>
    api.get("/api/roles/permissions")
  );

  function reload() {
    rolesQ.reload();
  }

  async function deleteRole(r: Role) {
    if (
      !confirm(
        `Delete role "${r.name}"?\n\nThis cannot be undone. Reassign any members holding this role first.`
      )
    )
      return;
    try {
      await api.del(`/api/roles/${r.id}`);
      toast.success(`Deleted ${r.name}`);
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Workspace · Access Control"
        title="Roles"
        description="Define what each role can access. System roles are locked; create custom roles for fine-grained control."
        actions={
          canManage && (
            <Button
              variant="brass"
              icon={<Plus size={14} />}
              onClick={() => setCreating(true)}
            >
              New Role
            </Button>
          )
        }
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {rolesQ.loading && (
          <div className="px-5 py-6 text-sm text-ink-muted">Loading…</div>
        )}
        {rolesQ.data?.roles.map((r) => (
          <div
            key={r.id}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface p-5 shadow-stone transition-all duration-200 hover:-translate-y-px hover:shadow-slab"
          >
            <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent/40 to-transparent transition-opacity duration-300 group-hover:via-accent" />

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Shield size={14} className="text-accent" />
                  <h3 className="font-display text-[16px] font-extrabold tracking-tight text-ink">
                    {r.name}
                  </h3>
                  {r.is_system && (
                    <span
                      className="inline-flex items-center gap-1 rounded bg-bg px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted"
                      title="System role — cannot be edited or deleted"
                    >
                      <Lock size={9} />
                      System
                    </span>
                  )}
                </div>
                {r.description && (
                  <p className="mt-1 text-[12px] text-ink-secondary">{r.description}</p>
                )}
                <div className="mt-3 flex items-center gap-3 text-[11px] text-ink-muted">
                  <span>
                    <span className="font-mono text-ink">{r.member_count}</span> member
                    {r.member_count === 1 ? "" : "s"}
                  </span>
                  <span>·</span>
                  <span>
                    <span className="font-mono text-ink">
                      {r.permissions.includes("*") ? "All" : r.permissions.length}
                    </span>{" "}
                    permission{r.permissions.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              {canManage && !r.is_system && (
                <button
                  onClick={() => deleteRole(r)}
                  className="rounded p-1.5 text-ink-muted opacity-0 transition-all hover:bg-err/10 hover:text-err group-hover:opacity-100"
                  aria-label="Delete role"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            <div className="mt-4 border-t border-border-subtle pt-3">
              <button
                onClick={() => setEditing(r)}
                className="text-[11px] font-semibold uppercase tracking-wider text-accent hover:underline"
              >
                {canManage && !r.is_system ? "Edit permissions →" : "View permissions →"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {(editing || creating) && (
        <RoleEditorPanel
          open={true}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          role={editing}
          permissions={permsQ.data?.permissions ?? []}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            reload();
          }}
          canManage={canManage}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Role editor panel (create + edit)
// ──────────────────────────────────────────────────────────
function RoleEditorPanel({
  open,
  onClose,
  role,
  permissions,
  onSaved,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  role: Role | null;
  permissions: PermissionDef[];
  onSaved: () => void;
  canManage: boolean;
}) {
  const toast = useToast();
  const isCreate = role === null;
  const isSystem = !!role?.is_system;
  const readOnly = !canManage || isSystem;

  const [name, setName] = useState(role?.name || "");
  const [description, setDescription] = useState(role?.description || "");
  const [selected, setSelected] = useState<Set<string>>(
    new Set(role?.permissions || [])
  );
  const [busy, setBusy] = useState(false);

  // Group permissions by resource for the picker UI.
  const grouped = useMemo(() => {
    const m = new Map<string, PermissionDef[]>();
    for (const p of permissions) {
      if (!m.has(p.resource)) m.set(p.resource, []);
      m.get(p.resource)!.push(p);
    }
    return Array.from(m.entries());
  }, [permissions]);

  function toggle(key: string) {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll(perms: PermissionDef[]) {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = perms.every((p) => next.has(p.key));
      if (allOn) {
        for (const p of perms) next.delete(p.key);
      } else {
        for (const p of perms) next.add(p.key);
      }
      return next;
    });
  }

  async function save() {
    if (readOnly) return;
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        permissions: Array.from(selected),
      };
      if (isCreate) {
        await api.post("/api/roles", body);
        toast.success(`Created ${body.name}`);
      } else {
        await api.patch(`/api/roles/${role!.id}`, body);
        toast.success(`Updated ${body.name}`);
      }
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  // Owner role with wildcard — show a special note instead of the full picker
  const isWildcard = role?.permissions.includes("*");

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={isCreate ? "New Role" : role!.name}
      subtitle={
        isSystem ? "System role · read-only" : isCreate ? "Custom role" : "Custom role"
      }
      width={520}
    >
      <PanelSection title="Identity">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            placeholder="e.g. Operations Lead"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-bg disabled:text-ink-muted"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={readOnly}
            placeholder="What this role is for"
            className="min-h-[60px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-bg disabled:text-ink-muted"
          />
        </div>
      </PanelSection>

      <PanelSection title="Permissions">
        {isWildcard ? (
          <div className="rounded-md border border-accent/30 bg-accent-soft/40 p-4">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-accent-ink">
              <Shield size={14} />
              Full access
            </div>
            <p className="mt-1 text-[11px] text-ink-secondary">
              This role has the wildcard <code className="font-mono">*</code> permission and
              can access everything in the workspace, including team and role management.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {grouped.map(([resource, perms]) => {
              const allOn = perms.every((p) => selected.has(p.key));
              const someOn = perms.some((p) => selected.has(p.key));
              return (
                <div
                  key={resource}
                  className="rounded-md border border-border bg-surface"
                >
                  <button
                    type="button"
                    onClick={() => toggleAll(perms)}
                    disabled={readOnly}
                    className="flex w-full items-center justify-between border-b border-border-subtle px-3 py-2 text-left transition-colors enabled:hover:bg-surface-dim"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink">
                      {resource}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider",
                        allOn
                          ? "bg-accent-soft text-accent-ink"
                          : someOn
                          ? "bg-warning-bg text-warning-text"
                          : "bg-bg text-ink-muted"
                      )}
                    >
                      {perms.filter((p) => selected.has(p.key)).length}/{perms.length}
                    </span>
                  </button>
                  <div className="divide-y divide-border-subtle">
                    {perms.map((p) => {
                      const on = selected.has(p.key);
                      return (
                        <label
                          key={p.key}
                          className={cn(
                            "flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors",
                            !readOnly && "hover:bg-surface-dim",
                            readOnly && "cursor-default"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={readOnly}
                            onChange={() => toggle(p.key)}
                            className="mt-0.5 h-4 w-4 cursor-pointer accent-accent disabled:cursor-default"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-semibold text-ink">{p.label}</div>
                            <div className="mt-0.5 text-[10.5px] text-ink-muted">
                              {p.description}
                            </div>
                            <div className="mt-1 font-mono text-[9.5px] text-ink-muted">
                              {p.key}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PanelSection>

      {!readOnly && !isWildcard && (
        <div className="sticky bottom-0 -mx-6 mt-4 flex justify-end gap-2 border-t border-border bg-surface px-6 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brass" onClick={save} disabled={busy}>
            {busy ? "Saving…" : isCreate ? "Create Role" : "Save Changes"}
          </Button>
        </div>
      )}
    </Panel>
  );
}
