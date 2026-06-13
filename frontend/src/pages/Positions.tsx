import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button";
import { Skeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import type { AccessLevel, PageDef, Position } from "../types";

// 4-level position matrix (none/view/edit/full). Lets an admin set, per
// position, which pages it can see — the source of truth that drives nav +
// route guards (no "乱跳"). Mirrors the Roles page-access editor but 4-level.
const LEVELS: AccessLevel[] = ["none", "view", "edit", "full"];

/** Embedded in the Team (User Management) page as the "Positions" tab. */
export function PositionsTab() {
  const positionsQ = useQuery<{ positions: Position[] }>(() => api.get("/api/positions"));
  const pagesQ = useQuery<{ pages: PageDef[] }>(() => api.get("/api/positions/pages"));
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const positions = positionsQ.data?.positions ?? [];
  const selected = positions.find((p) => p.id === selectedId) ?? null;

  const byDept = useMemo(() => {
    const m = new Map<string, Position[]>();
    for (const p of positions) {
      const d = p.department_name ?? "—";
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(p);
    }
    return Array.from(m.entries());
  }, [positions]);

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Position picker */}
      <div className="shrink-0 space-y-4 lg:w-60">
        {positionsQ.loading && <Skeleton className="h-40 w-full" />}
        {byDept.map(([dept, list]) => (
          <div key={dept}>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-accent">
              {dept}
            </div>
            <div className="space-y-1">
              {list.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-[12px] transition-colors",
                    selectedId === p.id
                      ? "border-accent bg-accent-soft text-accent-ink"
                      : "border-border bg-surface text-ink hover:border-accent/50"
                  )}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="ml-2 text-[10px] text-ink-muted">{p.member_count}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Matrix editor */}
      <div className="min-w-0 flex-1">
        {selected ? (
          <PositionMatrixEditor
            key={selected.id}
            position={selected}
            pages={pagesQ.data?.pages ?? []}
          />
        ) : (
          <div className="rounded-md border border-border bg-surface p-8 text-center text-[12px] text-ink-muted">
            Select a position to set which pages it can see.
          </div>
        )}
      </div>
    </div>
  );
}

function PositionMatrixEditor({ position, pages }: { position: Position; pages: PageDef[] }) {
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
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{position.name}</div>
          <div className="truncate text-[10px] text-ink-muted">
            {position.department_name ?? "—"} · controls which pages this position can see
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
              <div key={parent.key} className="rounded-md border border-border bg-surface p-3">
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
            Sub-pages inherit their parent's level unless set directly. Set a parent to
            grant a whole area, then override individual sub-pages (e.g. Projects = view,
            Finances = none).
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
      <div className="flex gap-2.5">
        {LEVELS.map((opt) => (
          <label key={opt} className="flex cursor-pointer items-center gap-1 text-[11px]">
            <input
              type="radio"
              name={`pos-${page.key}`}
              checked={level === opt}
              onChange={() => onChange(opt)}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span className="capitalize">{opt}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
