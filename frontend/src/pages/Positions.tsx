import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, GripVertical } from "lucide-react";
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
  // Department groups the admin has collapsed in the left list.
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());
  const toggleDept = (dept: string) =>
    setCollapsedDepts((prev) => {
      const next = new Set(prev);
      next.has(dept) ? next.delete(dept) : next.add(dept);
      return next;
    });

  const positions = positionsQ.data?.positions ?? [];
  const selected = positions.find((p) => p.id === selectedId) ?? null;

  const deptList = deptsQ.data?.departments ?? [];
  const deptByName = useMemo(() => {
    const m = new Map<string, Department>();
    for (const d of deptList) m.set(d.name, d);
    return m;
  }, [deptList]);

  const byDept = useMemo(() => {
    const m = new Map<string, Position[]>();
    for (const p of positions) {
      const d = p.department_name ?? "No department";
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(p);
    }
    // Order the department groups by their saved sort_order (drag-reorderable),
    // then name; positions inside each come back from the API already ordered.
    const ord = (name: string) => deptByName.get(name)?.sort_order ?? 9999;
    return Array.from(m.entries()).sort(
      (a, b) => ord(a[0]) - ord(b[0]) || a[0].localeCompare(b[0]),
    );
  }, [positions, deptByName]);

  // ── Drag-and-drop reordering (Super Admin) ──────────────────
  const [drag, setDrag] = useState<{ kind: "pos" | "dept"; id?: number; dept: string } | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  async function persistPositions(
    updates: { id: number; sort_order: number; department_id?: number | null }[],
  ) {
    try {
      await Promise.all(
        updates.map((u) =>
          api.patch(`/api/positions/${u.id}`, {
            sort_order: u.sort_order,
            ...(u.department_id !== undefined ? { department_id: u.department_id } : {}),
          }),
        ),
      );
    } catch (e: any) {
      toast.error(e?.message || "Reorder failed");
    } finally {
      positionsQ.reload();
    }
  }

  function dropOnPosition(target: Position) {
    const d = drag;
    setDrag(null);
    setDragOverKey(null);
    if (!d || d.kind !== "pos" || d.id == null || d.id === target.id) return;
    const dragged = positions.find((p) => p.id === d.id);
    if (!dragged) return;
    const targetDeptName = target.department_name ?? "No department";
    const list = byDept.find(([name]) => name === targetDeptName)?.[1] ?? [];
    const ids = list.filter((p) => p.id !== dragged.id).map((p) => p.id);
    const at = ids.indexOf(target.id);
    ids.splice(at < 0 ? ids.length : at, 0, dragged.id);
    const targetDeptId = deptByName.get(targetDeptName)?.id ?? dragged.department_id ?? null;
    persistPositions(
      ids.map((id, i) => ({
        id,
        sort_order: (i + 1) * 10,
        ...(id === dragged.id ? { department_id: targetDeptId } : {}),
      })),
    );
  }

  function dropOnDept(targetDeptName: string) {
    const d = drag;
    setDrag(null);
    setDragOverKey(null);
    if (!d) return;
    if (d.kind === "pos" && d.id != null) {
      // Move a position into this department (appended at the end).
      const dragged = positions.find((p) => p.id === d.id);
      if (!dragged || (dragged.department_name ?? "No department") === targetDeptName) return;
      const list = byDept.find(([name]) => name === targetDeptName)?.[1] ?? [];
      const targetDeptId = deptByName.get(targetDeptName)?.id ?? null;
      persistPositions([
        ...list.map((p, i) => ({ id: p.id, sort_order: (i + 1) * 10 })),
        { id: dragged.id, sort_order: (list.length + 1) * 10, department_id: targetDeptId },
      ]);
    } else if (d.kind === "dept" && d.dept !== targetDeptName) {
      const names = byDept.map(([n]) => n).filter((n) => n !== d.dept);
      const at = names.indexOf(targetDeptName);
      names.splice(at < 0 ? names.length : at, 0, d.dept);
      const updates = names
        .map((name, i) => ({ dep: deptByName.get(name), so: (i + 1) * 10 }))
        .filter((x) => x.dep && x.dep.sort_order !== x.so);
      if (updates.length === 0) return;
      Promise.all(
        updates.map((u) => api.patch(`/api/departments/${u.dep!.id}`, { sort_order: u.so })),
      )
        .then(() => {
          deptsQ.reload();
        })
        .catch((e: any) => toast.error(e?.message || "Reorder failed"));
    }
  }

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
        {/* Position list — single column, department-grouped + collapsible */}
        <div className="shrink-0 lg:w-64">
          {positionsQ.loading && <Skeleton className="h-40 w-full" />}
          <div className="space-y-2.5">
          {byDept.map(([dept, list]) => {
            const collapsed = collapsedDepts.has(dept);
            return (
            <div
              key={dept}
              className={cn(
                "break-inside-avoid rounded",
                dragOverKey === `dept:${dept}` && "ring-1 ring-accent ring-offset-1",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverKey(`dept:${dept}`);
              }}
              onDrop={() => dropOnDept(dept)}
            >
              <div className="mb-1.5 flex w-full items-center gap-1">
                <span
                  draggable
                  onDragStart={() => setDrag({ kind: "dept", dept })}
                  onDragEnd={() => {
                    setDrag(null);
                    setDragOverKey(null);
                  }}
                  title="Drag to reorder department"
                  className="cursor-grab text-ink-muted/60 hover:text-accent active:cursor-grabbing"
                >
                  <GripVertical size={14} />
                </span>
                <button
                  type="button"
                  onClick={() => toggleDept(dept)}
                  className="flex flex-1 items-center gap-1 text-[13px] font-bold uppercase tracking-brand text-ink transition-colors hover:text-accent"
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="truncate">{dept}</span>
                  <span className="ml-auto rounded bg-surface-dim px-1.5 text-[9px] font-semibold text-ink-muted">
                    {list.length}
                  </span>
                </button>
              </div>
              {!collapsed && (
              <div className="space-y-0.5">
                {list.map((p) => (
                  <div
                    key={p.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverKey(`pos:${p.id}`);
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      dropOnPosition(p);
                    }}
                    className={cn(
                      "group flex items-center gap-1 rounded-md border pr-1 transition-colors",
                      selectedId === p.id
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-surface hover:border-accent/50",
                      dragOverKey === `pos:${p.id}` && "ring-1 ring-accent",
                    )}
                  >
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDrag({ kind: "pos", id: p.id, dept });
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setDragOverKey(null);
                      }}
                      title="Drag to reorder, or onto a department to move it"
                      className="shrink-0 cursor-grab pl-1 text-ink-muted/40 transition-colors hover:text-accent active:cursor-grabbing"
                    >
                      <GripVertical size={12} />
                    </span>
                    <button
                      onClick={() => setSelectedId(p.id)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 py-1.5 pr-2 text-left text-[12px]"
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
              )}
            </div>
            );
          })}
          </div>
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
  // Module groups the admin has collapsed (parent page keys).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  // Open tidy: collapse NESTED groups by default (a group that is itself a
  // sub-page of another), so SCM shows its 6 areas instead of all ~30 rows.
  // Top-level groups stay open. Runs once when the catalogue first loads.
  const collapseInited = useRef(false);
  useEffect(() => {
    if (collapseInited.current || pages.length === 0) return;
    collapseInited.current = true;
    const nested = pages
      .filter((p) => p.parent && pages.some((c) => c.parent === p.key))
      .map((p) => p.key);
    if (nested.length) setCollapsed(new Set(nested));
  }, [pages]);

  useEffect(() => {
    if (!accessQ.data) return;
    const init: Record<string, AccessLevel> = {};
    for (const [k, v] of Object.entries(accessQ.data.page_access)) init[k] = v.level;
    setLevels(init);
    setDirty(new Set());
  }, [accessQ.data]);

  function change(key: string, level: AccessLevel) {
    // Setting a parent cascades the level to its whole sub-tree so the admin
    // sees the entire category flip at once; they can then click an individual
    // sub-page to override it. (Every cascaded page is written explicitly.)
    const subtree: string[] = [];
    let frontier = pages.filter((p) => p.parent === key);
    while (frontier.length) {
      subtree.push(...frontier.map((p) => p.key));
      frontier = frontier.flatMap((p) => pages.filter((c) => c.parent === p.key));
    }
    const all = [key, ...subtree];
    setLevels((p) => {
      const next = { ...p };
      for (const k of all) next[k] = level;
      return next;
    });
    setDirty((p) => {
      const next = new Set(p);
      for (const k of all) next.add(k);
      return next;
    });
  }

  const parents = pages.filter((p) => !p.parent);
  const childrenOf = (key: string) => pages.filter((p) => p.parent === key);
  const groupParents = parents.filter((p) => childrenOf(p.key).length > 0);
  const allCollapsed =
    groupParents.length > 0 && groupParents.every((p) => collapsed.has(p.key));
  const toggleAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(groupParents.map((p) => p.key)));

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

  // Render a page + ALL its descendants (recursive) so every leaf — e.g. each
  // SCM sub-page (Sales Orders / Delivery / PO / GRN / …) — gets its own
  // None/View/Edit/Full control. Each level indents under its parent; nodes
  // with children are collapsible.
  const renderNode = (page: PageDef, depth: number) => {
    const kids = childrenOf(page.key);
    const isCollapsed = collapsed.has(page.key);
    return (
      <div key={page.key} className={depth > 0 ? "mt-1" : ""}>
        <LevelRow
          page={page}
          level={levels[page.key] ?? "none"}
          dirty={dirty.has(page.key)}
          onChange={(l) => change(page.key, l)}
          collapsible={kids.length > 0}
          collapsed={isCollapsed}
          onToggleCollapse={() => toggleGroup(page.key)}
          dense={depth > 0}
        />
        {kids.length > 0 && !isCollapsed && (
          <div className="mt-1 space-y-1 border-l-2 border-border-subtle pl-2.5">
            {kids.map((kid) => renderNode(kid, depth + 1))}
          </div>
        )}
      </div>
    );
  };

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
        <div className="flex shrink-0 items-center gap-2">
          {groupParents.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="text-[11px] font-semibold text-ink-muted transition-colors hover:text-accent"
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          )}
          <Button variant="brass" onClick={save} disabled={busy || dirty.size === 0}>
            {busy ? "Saving…" : dirty.size ? `Save (${dirty.size})` : "Saved"}
          </Button>
        </div>
      </div>

      {accessQ.loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* Cards flow into columns so the whole matrix fits one screen — no scroll */}
          <div className="space-y-2">
            {parents.map((parent) => (
              <div
                key={parent.key}
                className="break-inside-avoid rounded-md border border-border bg-bg/40 p-2.5"
              >
                {renderNode(parent, 0)}
              </div>
            ))}
          </div>
          <p className="pt-2 text-[10.5px] text-ink-muted">
            Every page (incl. each SCM sub-page) has its own level. Sub-pages inherit their parent
            unless set directly — set a parent to grant a whole area, then override individual pages.
          </p>
        </>
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
  collapsible,
  collapsed,
  onToggleCollapse,
}: {
  page: PageDef;
  level: AccessLevel;
  dirty: boolean;
  onChange: (l: AccessLevel) => void;
  dense?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  return (
    <div className="group -mx-1 flex items-center justify-between gap-2 rounded px-1 transition-colors hover:bg-accent-soft/40">
      {/* Label + key on one line keeps each page to a single dense row */}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {collapsible && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sub-pages" : "Collapse sub-pages"}
            className="-ml-0.5 shrink-0 self-center rounded p-0.5 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
        <span
          title={page.key}
          className={cn("truncate font-semibold text-ink transition-colors group-hover:font-bold group-hover:text-accent", dense ? "text-[12.5px]" : "text-[13.5px]")}
        >
          {page.label}
        </span>
        {dirty && (
          <span className="shrink-0 rounded bg-warning-bg px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-warning-text">
            unsaved
          </span>
        )}
      </div>
      {/* Segmented level control — clearer than 4 loose radios */}
      <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-border">
        {LEVELS.map((opt, i) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              "px-2.5 py-1 text-[12px] capitalize transition-colors",
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
