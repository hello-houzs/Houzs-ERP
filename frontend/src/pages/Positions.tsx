import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { Skeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import type { AccessLevel, Department, PageDef, Position } from "../types";

// 4-level position matrix (none/view/edit/full). Lets an admin set, per
// position, which pages it can see — the source of truth that drives nav +
// route guards (no "乱跳"). Mirrors the Roles page-access editor but 4-level.
const LEVELS: AccessLevel[] = ["none", "view", "edit", "full"];

/** Embedded in the Team (User Management) page as the "Positions" tab. */
export function PositionsTab() {
  const toast = useToast();
  const dialog = useDialog();
  const positionsQ = useQuery<{ positions: Position[] }>(() => api.get("/api/positions"));
  const pagesQ = useQuery<{ pages: PageDef[] }>(() => api.get("/api/positions/pages"));
  const deptsQ = useQuery<{ departments: Department[] }>(() => api.get("/api/departments"));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // null = closed · "new" = create · Position = edit that one
  const [editing, setEditing] = useState<Position | "new" | null>(null);

  const positions = positionsQ.data?.positions ?? [];
  const selected = positions.find((p) => p.id === selectedId) ?? null;

  const byDept = useMemo(() => {
    const m = new Map<string, Position[]>();
    for (const p of positions) {
      const d = p.department_name ?? "No department";
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(p);
    }
    return Array.from(m.entries());
  }, [positions]);

  async function deletePosition(p: Position) {
    if (p.member_count > 0) {
      toast.error(`${p.name} still has ${p.member_count} member(s) — reassign them first.`);
      return;
    }
    if (!(await dialog.confirm(`Delete the position “${p.name}”?`))) return;
    try {
      await api.del(`/api/positions/${p.id}`);
      toast.success("Position deleted");
      if (selectedId === p.id) setSelectedId(null);
      positionsQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed (members may still hold it)");
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-brand text-accent">
          {positions.length} position{positions.length === 1 ? "" : "s"}
        </span>
        <Button variant="brass" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
          New Position
        </Button>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Position list — grouped by department, each row editable/deletable */}
        <div className="shrink-0 space-y-4 lg:w-64">
          {positionsQ.loading && <Skeleton className="h-40 w-full" />}
          {byDept.map(([dept, list]) => (
            <div key={dept}>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                {dept}
              </div>
              <div className="space-y-1">
                {list.map((p) => (
                  <div
                    key={p.id}
                    className={cn(
                      "group flex items-center gap-1 rounded-md border pr-1 transition-colors",
                      selectedId === p.id
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-surface hover:border-accent/50",
                    )}
                  >
                    <button
                      onClick={() => setSelectedId(p.id)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left text-[12px]"
                    >
                      <span
                        className={cn(
                          "truncate",
                          selectedId === p.id ? "font-semibold text-accent-ink" : "text-ink",
                        )}
                      >
                        {p.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-ink-muted">{p.member_count}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => setEditing(p)}
                        title="Edit position"
                        aria-label={`Edit ${p.name}`}
                        className="rounded p-1 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => deletePosition(p)}
                        title="Delete position"
                        aria-label={`Delete ${p.name}`}
                        className="rounded p-1 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!positionsQ.loading && positions.length === 0 && (
            <div className="rounded-md border border-dashed border-border p-4 text-center text-[11px] text-ink-muted">
              No positions yet — add one to start.
            </div>
          )}
        </div>

        {/* Page-access matrix for the selected position */}
        <div className="min-w-0 flex-1">
          {selected ? (
            <PositionMatrixEditor
              key={selected.id}
              position={selected}
              pages={pagesQ.data?.pages ?? []}
              onEdit={() => setEditing(selected)}
            />
          ) : (
            <div className="rounded-lg border border-border bg-surface p-8 text-center text-[12px] text-ink-muted shadow-stone">
              Select a position to set which pages it can see, or{" "}
              <button
                type="button"
                onClick={() => setEditing("new")}
                className="font-semibold text-accent hover:underline"
              >
                add a new one
              </button>
              .
            </div>
          )}
        </div>
      </div>

      {editing && (
        <PositionEditPanel
          position={editing === "new" ? null : editing}
          departments={deptsQ.data?.departments ?? []}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            positionsQ.reload();
            if (id) setSelectedId(id);
          }}
          onDeleted={() => {
            setEditing(null);
            setSelectedId(null);
            positionsQ.reload();
          }}
        />
      )}
    </div>
  );
}

/** Create / edit a single position (name + department). */
function PositionEditPanel({
  position,
  departments,
  onClose,
  onSaved,
  onDeleted,
}: {
  position: Position | null;
  departments: Department[];
  onClose: () => void;
  onSaved: (newId?: number) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const isNew = !position;
  const [name, setName] = useState(position?.name || "");
  const [deptId, setDeptId] = useState<number | "">(position?.department_id ?? "");
  const [busy, setBusy] = useState(false);

  const inputCls =
    "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";
  const labelCls =
    "mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

  async function save() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        const res = await api.post<{ id?: number }>("/api/positions", {
          name: name.trim(),
          department_id: deptId || undefined,
        });
        toast.success(`Created “${name.trim()}”`);
        onSaved(res?.id);
      } else {
        await api.patch(`/api/positions/${position!.id}`, {
          name: name.trim(),
          department_id: deptId || null,
        });
        toast.success(`Saved “${name.trim()}”`);
        onSaved(position!.id);
      }
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!position) return;
    if (position.member_count > 0) {
      toast.error(`Still has ${position.member_count} member(s) — reassign them first.`);
      return;
    }
    if (!(await dialog.confirm(`Delete the position “${position.name}”?`))) return;
    setBusy(true);
    try {
      await api.del(`/api/positions/${position.id}`);
      toast.success("Position deleted");
      onDeleted();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={isNew ? "New Position" : position!.name}
      subtitle={isNew ? "Create a position" : "Edit position"}
      width={420}
    >
      <PanelSection title="Details">
        <div>
          <label className={labelCls}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ops Executive"
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>Department</label>
          <select
            value={deptId}
            onChange={(e) => setDeptId(e.target.value ? Number(e.target.value) : "")}
            className={inputCls}
          >
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <div className="mt-1 text-[10px] text-ink-muted">
            Groups the position under a department. The position drives which pages members can see.
          </div>
        </div>
      </PanelSection>

      <div className="pb-1">
        <Button variant="brass" className="w-full" onClick={save} disabled={busy}>
          {busy ? "Saving…" : isNew ? "Create Position" : "Save Changes"}
        </Button>
      </div>

      {!isNew && (
        <PanelSection title="Danger">
          <button
            type="button"
            onClick={del}
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-err/30 bg-surface px-3 py-2 text-[12px] font-semibold text-err transition-colors hover:bg-err/10 disabled:opacity-50"
          >
            <Trash2 size={13} /> Delete position
            {position!.member_count > 0 ? ` (${position!.member_count} members)` : ""}
          </button>
          {position!.member_count > 0 && (
            <div className="text-[10px] text-ink-muted">
              Reassign its {position!.member_count} member(s) to another position before deleting.
            </div>
          )}
        </PanelSection>
      )}
    </Panel>
  );
}

function PositionMatrixEditor({
  position,
  pages,
  onEdit,
}: {
  position: Position;
  pages: PageDef[];
  onEdit: () => void;
}) {
  const toast = useToast();
  const accessQ = useQuery<{
    position_id: number;
    page_access: Record<string, { level: AccessLevel; explicit: boolean }>;
  }>(() => api.get(`/api/positions/${position.id}/page-access`), [position.id]);

  const [levels, setLevels] = useState<Record<string, AccessLevel>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accessQ.data) return;
    const init: Record<string, AccessLevel> = {};
    for (const [k, v] of Object.entries(accessQ.data.page_access)) init[k] = v.level;
    setLevels(init);
    setDirty(new Set());
  }, [accessQ.data]);

  function change(key: string, level: AccessLevel) {
    setLevels((p) => ({ ...p, [key]: level }));
    setDirty((p) => new Set(p).add(key));
  }

  const parents = pages.filter((p) => !p.parent);
  const childrenOf = (key: string) => pages.filter((p) => p.parent === key);

  async function save() {
    if (dirty.size === 0) return;
    setBusy(true);
    try {
      const entries = Array.from(dirty).map((k) => ({ page_key: k, level: levels[k] ?? "none" }));
      await api.patch(`/api/positions/${position.id}/page-access`, { entries });
      setDirty(new Set());
      toast.success(`Saved access for ${position.name}`);
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
              {position.name}
            </div>
            <button
              type="button"
              onClick={onEdit}
              title="Edit position name / department"
              className="rounded p-1 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
            >
              <Pencil size={12} />
            </button>
          </div>
          <div className="truncate text-[10px] text-ink-muted">
            {position.department_name ?? "No department"} · which pages this position can see
          </div>
        </div>
        <Button variant="brass" onClick={save} disabled={busy || dirty.size === 0}>
          {busy ? "Saving…" : dirty.size ? `Save (${dirty.size})` : "Saved"}
        </Button>
      </div>

      {accessQ.loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-2">
          {parents.map((parent) => {
            const kids = childrenOf(parent.key);
            return (
              <div key={parent.key} className="rounded-md border border-border bg-bg/40 p-3">
                <LevelRow
                  page={parent}
                  level={levels[parent.key] ?? "none"}
                  dirty={dirty.has(parent.key)}
                  onChange={(l) => change(parent.key, l)}
                />
                {kids.length > 0 && (
                  <div className="mt-2 space-y-2 border-l-2 border-border-subtle pl-3">
                    {kids.map((child) => (
                      <LevelRow
                        key={child.key}
                        page={child}
                        level={levels[child.key] ?? "none"}
                        dirty={dirty.has(child.key)}
                        onChange={(l) => change(child.key, l)}
                        dense
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="pt-1 text-[10.5px] text-ink-muted">
            Sub-pages inherit their parent's level unless set directly. Set a parent to grant a
            whole area, then override individual sub-pages (e.g. Projects = view, Finances = none).
          </p>
        </div>
      )}
    </div>
  );
}

function LevelRow({
  page,
  level,
  dirty,
  onChange,
  dense,
}: {
  page: PageDef;
  level: AccessLevel;
  dirty: boolean;
  onChange: (l: AccessLevel) => void;
  dense?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className={cn("font-semibold text-ink", dense ? "text-[11.5px]" : "text-[12px]")}>
          {page.label}
          {dirty && (
            <span className="ml-2 rounded bg-warning-bg px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-warning-text">
              unsaved
            </span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[9px] text-ink-muted">{page.key}</div>
      </div>
      {/* Segmented level control — clearer than 4 loose radios */}
      <div className="inline-flex overflow-hidden rounded-md border border-border">
        {LEVELS.map((opt, i) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              "px-2.5 py-1 text-[11px] capitalize transition-colors",
              i > 0 && "border-l border-border",
              level === opt
                ? "bg-accent font-semibold text-white"
                : "bg-surface text-ink-secondary hover:bg-accent-soft/50 hover:text-accent",
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
