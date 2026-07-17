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

// Shape of GET /api/positions/page-access/export (backend/src/routes/positions.ts:208).
// Declared here rather than in types.ts because that file is owned by another
// live branch. A PARTIAL description, not an exhaustive one: only `positions` is
// read (the confirmation count + the empty-export guard). Everything else —
// `totals`, `orphan_keys`, `missing_keys` — is never touched and rides through to
// the file verbatim, because the file is a photograph and this page is only the
// shutter. `entries` (the explicit rows) and `resolved` (inheritance applied) are
// DIFFERENT facts and neither may ever be flattened into the other.
type PageAccessExport = {
  generatedFrom: string;
  generatedAt: string;
  totals: { positions: number; explicit_rows: number; orphan_rows: number; gap_cells: number };
  positions: Array<{
    id: number;
    name: string;
    /** EXPLICIT rows only. An absent key means NO ROW (inherit the parent,
     *  pageAccess.ts:748) — which is NOT the same fact as a row of "none". */
    entries: Record<string, string>;
    /** Derived: inheritance applied. Review aid, never a source of rows. */
    resolved: Record<string, AccessLevel>;
  }>;
};

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

  // The owner's live matrix, out of prod and onto his disk in ONE click.
  //
  // WHY A BUTTON. The rules are moving out of this table and into backend code,
  // and the export is their only honest source — but the endpoint needs a bearer
  // token, which lives in his browser and nowhere anyone can hand over safely
  // (DASHBOARD_API_KEY is a write-only Cloudflare secret; nobody can read it
  // back, him included). Asking him to paste a token out of DevTools stalled the
  // whole workstream for a day. He is already authenticated in this tab — so the
  // click IS the handover, and no credential ever leaves the browser.
  const [exporting, setExporting] = useState(false);
  async function exportPageAccess() {
    setExporting(true);
    try {
      const data = await api.get<PageAccessExport>("/api/positions/page-access/export");
      // Refuse to hand him a plausible-looking empty file: a snapshot generated
      // from a photograph of nothing would silently blank real people's access.
      // Prefer a visible failure over an invisible one (the same bar the
      // generator sets on itself, export-position-access.mjs:88-99). Explicit
      // checks, never `?? []` — an unknown must not be defaulted into a fact.
      if (!Array.isArray(data?.positions) || data.positions.length === 0) {
        toast.error("The export came back with no positions — nothing was saved. Please try again.");
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "houzs-position-access.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(
        `Exported ${data.positions.length} positions — saved to your Downloads as houzs-position-access.json`,
      );
    } catch (e: any) {
      // Always a sentence, never a code, and never a silent no-op: the client
      // has already turned the HTTP status into plain language (humanHttpMessage).
      toast.error(e?.message || "Couldn't export the page-access matrix. Please try again.");
    } finally {
      setExporting(false);
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
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={exportPageAccess}
            disabled={exporting}
            title="Download every position's page-access rows as JSON"
          >
            {exporting ? "Exporting…" : "Export"}
          </Button>
          <Button variant="brass" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
            New Position
          </Button>
        </div>
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
              reloadPages={pagesQ.reload}
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
    "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";
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
  reloadPages,
  onEdit,
}: {
  position: Position;
  pages: PageDef[];
  reloadPages: () => void;
  onEdit: () => void;
}) {
  const toast = useToast();
  const accessQ = useQuery<{
    position_id: number;
    page_access: Record<string, { level: AccessLevel; explicit: boolean }>;
    /** Class B — rows whose page_key is not in the catalogue, so every read
     *  discards them (backend isValidPageKey filter). Optional: an older
     *  backend does not send it, and absent must read as "not told", never as
     *  "there are none". */
    orphan_rows?: Array<{ page_key: string; level: string }>;
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
  // Drag-reorder of matrix rows. Only siblings (same parent) may swap; the
  // dragged key is moved just before the drop target in the GLOBAL page order
  // and persisted, so the new order shows in every position's matrix.
  const [rowDrag, setRowDrag] = useState<string | null>(null);
  const [rowOver, setRowOver] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const parentOf = (key: string) => pages.find((p) => p.key === key)?.parent ?? null;
  async function reorderRow(targetKey: string) {
    const src = rowDrag;
    setRowDrag(null);
    setRowOver(null);
    if (!src || src === targetKey) return;
    if (parentOf(src) !== parentOf(targetKey)) {
      toast.error("Only items in the same group can be reordered");
      return;
    }
    const keys = pages.map((p) => p.key).filter((k) => k !== src);
    const at = keys.indexOf(targetKey);
    if (at < 0) return;
    keys.splice(at, 0, src);
    setReordering(true);
    try {
      await api.patch("/api/positions/page-order", { order: keys });
      reloadPages();
    } catch (e: any) {
      toast.error(e?.message || "Reorder failed");
    } finally {
      setReordering(false);
    }
  }

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
    //
    // DORMANT CHILDREN ARE STILL CASCADED, deliberately. Greying a row disables
    // the DIRECT control; it does not carve the key out of the cascade, because
    // that would change which rows a save writes — a behaviour change, and this
    // change is required to have none. Excluding them would also break the one
    // promise the editor does make ("set a parent to grant a whole area"): the
    // day a dormant key IS wired, a position granted its parent would silently
    // not have it. So the stored value keeps tracking the parent exactly as it
    // does today; the greyed row just shows it honestly instead of inviting a
    // click that means nothing.
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
    // Does any descendant carry a grant? Used to flag a parent that is itself
    // "none" but has sub-pages granted (so a collapsed area shows it's not empty).
    let hasGrantedDescendant = false;
    if (kids.length > 0) {
      let frontier = kids;
      while (frontier.length && !hasGrantedDescendant) {
        if (frontier.some((k) => (levels[k.key] ?? "none") !== "none")) hasGrantedDescendant = true;
        frontier = frontier.flatMap((k) => childrenOf(k.key));
      }
    }
    const canDrop = rowDrag != null && rowDrag !== page.key && parentOf(rowDrag) === (page.parent ?? null);
    return (
      <div key={page.key} className={depth > 0 ? "mt-1" : ""}>
        <div
          onDragOver={(e) => {
            if (!canDrop) return;
            e.preventDefault();
            if (rowOver !== page.key) setRowOver(page.key);
          }}
          onDragLeave={() => setRowOver((k) => (k === page.key ? null : k))}
          onDrop={(e) => {
            e.preventDefault();
            reorderRow(page.key);
          }}
          className={cn(
            "rounded transition-colors",
            canDrop && rowOver === page.key && "ring-1 ring-accent bg-accent-soft/40",
          )}
        >
          <LevelRow
            page={page}
            level={levels[page.key] ?? "none"}
            dirty={dirty.has(page.key)}
            onChange={(l) => change(page.key, l)}
            collapsible={kids.length > 0}
            collapsed={isCollapsed}
            onToggleCollapse={() => toggleGroup(page.key)}
            mixed={kids.length > 0 && (levels[page.key] ?? "none") === "none" && hasGrantedDescendant}
            dense={depth > 0}
            onDragStartRow={() => setRowDrag(page.key)}
            onDragEndRow={() => {
              setRowDrag(null);
              setRowOver(null);
            }}
            dragging={rowDrag === page.key}
          />
        </div>
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
          {/* CLASS B — settings that were saved against a page that does not
              exist. Unlike a dormant row there is nothing in the matrix above to
              grey: the key is not in the catalogue, so every read throws the row
              away. Listed rather than hidden because these rows are the record
              of rules the admin believes are in force — six of them on Finance
              Manager are the owner's 2026-06-13 "money pages: Finance only",
              dead since the day he saved it while the UI said Saved. Read-only:
              they grant nothing, and deleting them would destroy the evidence of
              what was intended. Only rendered when this position actually has
              some. */}
          {(accessQ.data?.orphan_rows?.length ?? 0) > 0 && (
            <div className="mt-3 rounded-md border border-dashed border-border bg-bg/40 p-2.5">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-brand text-ink-muted">
                Saved settings that were never wired
              </div>
              <p className="mb-2 text-[10.5px] leading-snug text-ink-muted">
                These were saved against pages this system does not have, so they have never done
                anything and cannot be edited here. They are kept on screen as a record of what was
                intended — nothing is lost by leaving them, and nobody's access depends on them.
              </p>
              <div className="space-y-0.5">
                {accessQ.data!.orphan_rows!.map((r) => (
                  <div
                    key={r.page_key}
                    className="flex items-center justify-between gap-2 rounded px-1 py-0.5 opacity-60"
                  >
                    <span className="truncate text-[12.5px] font-semibold text-ink-muted">
                      {r.page_key}
                    </span>
                    <span className="shrink-0 rounded border border-border bg-surface-dim px-2 py-0.5 text-[11px] capitalize text-ink-muted">
                      {r.level}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="pt-2 text-[10.5px] text-ink-muted">
            Every page (incl. each SCM sub-page) has its own level. Sub-pages inherit their parent
            unless set directly — set a parent to grant a whole area, then override individual pages.
            Pages marked <span className="font-semibold">not wired</span> are part of the plan but
            nothing reads them yet, so their level cannot be changed.
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
  mixed,
  onDragStartRow,
  onDragEndRow,
  dragging,
}: {
  page: PageDef;
  level: AccessLevel;
  dirty: boolean;
  onChange: (l: AccessLevel) => void;
  dense?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  mixed?: boolean;
  onDragStartRow?: () => void;
  onDragEndRow?: () => void;
  dragging?: boolean;
}) {
  // Nothing in the system reads this key, so the control is disabled rather than
  // removed — the owner wants the row kept ("最重要是我要它的 UI"): the inventory
  // of what the system is meant to have is the point, the working switch is not.
  const dormant = page.dormant === true;
  const dormantTitle =
    "This setting isn't wired to anything yet — nothing in the system reads it, so changing it would have no effect. Shown here because the page is part of the plan.";
  return (
    <div
      title={dormant ? dormantTitle : undefined}
      className={cn(
        "group -mx-1 flex items-center justify-between gap-1 rounded px-1 transition-colors",
        dormant ? "opacity-60" : "hover:bg-accent-soft/40",
        dragging && "opacity-40",
      )}
    >
      {/* Grip — drag to reorder within the same group. Native HTML5 DnD; the
          parent row is the drop target. */}
      <span
        draggable
        onDragStart={onDragStartRow}
        onDragEnd={onDragEndRow}
        title="Drag to reorder"
        className="shrink-0 cursor-grab self-center rounded p-0.5 text-ink-muted/40 opacity-0 transition-opacity hover:text-accent group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical size={13} />
      </span>
      {/* Label row. For groups the WHOLE label toggles collapse (not just the
          tiny chevron), so each area is easy to fold individually. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {collapsible ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand this area" : "Collapse this area"}
            className="-ml-0.5 flex min-w-0 flex-1 items-center gap-1 rounded py-0.5 text-left transition-colors hover:text-accent"
          >
            {collapsed ? (
              <ChevronRight size={14} className="shrink-0 text-ink-muted" />
            ) : (
              <ChevronDown size={14} className="shrink-0 text-ink-muted" />
            )}
            <span className={cn("truncate font-semibold text-ink transition-colors group-hover:text-accent", dense ? "text-[12.5px]" : "text-[13.5px]")}>
              {page.label}
            </span>
            {mixed && (
              <span
                title="Some sub-pages here are granted (this area isn't blanket-granted)"
                className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-[8.5px] font-bold uppercase tracking-wide text-accent"
              >
                sub
              </span>
            )}
          </button>
        ) : (
          <span
            title={dormant ? undefined : page.key}
            className={cn(
              "truncate font-semibold transition-colors",
              dormant ? "text-ink-muted" : "text-ink group-hover:font-bold group-hover:text-accent",
              dense ? "text-[12.5px]" : "text-[13.5px]",
            )}
          >
            {page.label}
          </span>
        )}
        {dormant && (
          <span
            title={dormantTitle}
            className="shrink-0 rounded-full bg-surface-dim px-1.5 py-px text-[8.5px] font-bold uppercase tracking-wide text-ink-muted"
          >
            not wired
          </span>
        )}
        {dirty && (
          <span className="shrink-0 rounded bg-warning-bg px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-warning-text">
            unsaved
          </span>
        )}
      </div>
      {/* Segmented level control — clearer than 4 loose radios. Disabled for a
          dormant page: the level still SHOWS (it is the real stored value and
          must keep reading true), it just cannot be changed into a promise the
          system will not keep. */}
      <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-border">
        {LEVELS.map((opt, i) => (
          <button
            key={opt}
            type="button"
            disabled={dormant}
            title={dormant ? dormantTitle : undefined}
            onClick={() => onChange(opt)}
            className={cn(
              "px-2.5 py-1 text-[12px] capitalize transition-colors",
              i > 0 && "border-l border-border",
              dormant
                ? cn(
                    "cursor-not-allowed",
                    level === opt
                      ? "bg-ink-muted/30 font-semibold text-ink-muted"
                      : "bg-surface-dim text-ink-muted/60",
                  )
                : level === opt
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
