import { useState } from "react";
import {
  Plus,
  Trash2,
  Eye,
  EyeOff,
  GripVertical,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { RowActionsMenu } from "./RowActionsMenu";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useReorderable } from "../hooks/useReorderable";
import { api } from "../api/client";
import { cn } from "../lib/utils";

/**
 * Generic CRUD card for a "lookup" table — slug + name + active +
 * sort_order, with drag-and-arrow reordering, plus an optional extra
 * numeric column (e.g. SLA hours for ASSR priorities, level for
 * Sales Team positions, rate for commission tiers).
 *
 * Originally lived inline in ServiceSettings.tsx; hoisted on
 * 2026-05-08 so the Sales Team Maintenance page can reuse it.
 *
 * URL contract: the component talks to a back-end that exposes:
 *    GET    {apiPath}?include_inactive=1    → { data: LookupRow[] }
 *    POST   {apiPath}                       → 200 OK (body: { name, sort_order, [extra.key] })
 *    PATCH  {apiPath}/:id                   → 200 OK
 *    DELETE {apiPath}/:id                   → 200 OK (soft delete sets active=0)
 *    PUT    {apiPath}/reorder               → 200 OK (body: { ids: number[] })
 */

export interface LookupRow {
  id: number;
  slug: string;
  name: string;
  sort_order: number;
  active: number;
  [extra: string]: any;
}

export interface LookupExtraField {
  /** Column key on the row (e.g. "sla_hours", "level", "rate"). */
  key: string;
  /** Placeholder + title for the add input + each row's input. */
  addLabel: string;
  rowTitle?: string;
  /** Default value (for placeholder when blank). */
  placeholder?: string;
  /** Step / min for the numeric input. */
  step?: string;
  min?: number;
  /** Width class for the input. */
  width?: string;
}

interface Props {
  /** Full base URL, e.g. "/api/assr/lookups/issue-categories" */
  apiPath: string;
  title: string;
  description: string;
  /** Optional single extra numeric column. Add multiple later if needed. */
  extra?: LookupExtraField;
}

export function LookupManager({ apiPath, title, description, extra }: Props) {
  const toast = useToast();
  const dialog = useDialog();
  // `apiPath` MUST be in deps. useQuery keys on `fetcher.toString()` — the
  // arrow function's SOURCE TEXT — and `apiPath` is closed over, so it does not
  // appear there. Every LookupManager on the page therefore produced a
  // byte-identical key and they all shared one cache entry: Service Settings
  // mounts five (ServiceSettings.tsx:87,92,97,103,108) and all five rendered
  // whichever list resolved first, under five different headings. The bug is
  // invisible to the component — it renders exactly what it was handed.
  const q = useQuery<{ data: LookupRow[] }>("lookup-manager-options",
    () => api.get(`${apiPath}?include_inactive=1`),
    [apiPath],
  );
  const [name, setName] = useState("");
  const [extraVal, setExtraVal] = useState("");
  const [adding, setAdding] = useState(false);

  const reorder = useReorderable(q.data?.data ?? [], async (ids) => {
    try {
      await api.put(`${apiPath}/reorder`, { ids });
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reorder");
      q.reload();
    }
  });

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const body: Record<string, any> = {
        name: trimmed,
        sort_order: (q.data?.data.length ?? 0) * 10,
      };
      if (extra && extraVal.trim() !== "") {
        const n = parseFloat(extraVal);
        if (Number.isFinite(n)) body[extra.key] = n;
      }
      await api.post(apiPath, body);
      setName("");
      setExtraVal("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setAdding(false);
    }
  }

  async function patch(row: LookupRow, body: Partial<LookupRow>) {
    try {
      await api.patch(`${apiPath}/${row.id}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function remove(row: LookupRow) {
    if (
      !(await dialog.confirm({
        title: `Hide ${title.replace(/s$/, "").toLowerCase()}`,
        message: `Hide "${row.name}" from the picker? Existing references keep this value.`,
        danger: true,
        confirmLabel: "Hide",
      }))
    )
      return;
    try {
      await api.del(`${apiPath}/${row.id}`);
      toast.success("Hidden");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        {title}
      </h2>
      <p className="mb-4 text-[12px] text-ink-secondary">{description}</p>

      <div className="mb-3 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New name…"
          className="h-9 flex-1 min-w-[160px] rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        {extra && (
          <input
            type="number"
            step={extra.step ?? "1"}
            value={extraVal}
            min={extra.min ?? 0}
            onChange={(e) => setExtraVal(e.target.value)}
            placeholder={extra.addLabel}
            title={extra.rowTitle ?? extra.addLabel}
            className={cn(
              "h-9 rounded-md border border-border bg-surface px-3 font-mono text-[12px] outline-none focus:border-primary",
              extra.width ?? "w-24",
            )}
          />
        )}
        <button
          onClick={add}
          disabled={adding || !name.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          <Plus size={12} className="inline" /> Add
        </button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">Loading…</li>
        )}
        {!q.loading && (q.data?.data.length ?? 0) === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">
            No entries yet — add one above.
          </li>
        )}
        {reorder.view.map((row, idx) => {
          const active = row.active !== 0;
          const handlers = reorder.rowHandlers(row.id);
          const isDragging = reorder.isDragging(row.id);
          const isDropTarget = reorder.isDropTarget(row.id);
          return (
            <li
              key={row.id}
              {...handlers}
              className={cn(
                "flex flex-wrap items-center gap-2 px-3 py-2 transition-colors",
                !active && "opacity-50",
                isDragging && "opacity-40",
                isDropTarget && "bg-accent-soft/40",
              )}
            >
              <div className="flex items-center gap-0.5 text-ink-muted">
                <span
                  className="cursor-grab rounded p-1 hover:bg-bg/70 active:cursor-grabbing"
                  title="Drag to reorder"
                  aria-label="Drag handle"
                >
                  <GripVertical size={14} />
                </span>
                <button
                  type="button"
                  onClick={() => reorder.moveBy(idx, -1)}
                  disabled={idx === 0}
                  title="Move up"
                  aria-label="Move up"
                  className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => reorder.moveBy(idx, 1)}
                  disabled={idx === reorder.view.length - 1}
                  title="Move down"
                  aria-label="Move down"
                  className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              <input
                defaultValue={row.name}
                key={`name-${row.id}-${row.name}`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== row.name) patch(row, { name: v });
                }}
                className="flex-1 min-w-[140px] h-8 rounded-md border border-transparent bg-transparent px-2 text-[13px] font-medium text-ink hover:border-border focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary/20 focus:outline-none"
              />
              {/* Slug hidden (Houzs 2026-06-24) — owner: the tiny gray machine
                  code next to each name (e.g. product_defect, missing__short_items)
                  is unnecessary clutter + misaligned. The slug stays the stable
                  machine value on the row; it's just no longer shown in the UI. */}
              {extra && (
                <input
                  type="number"
                  step={extra.step ?? "1"}
                  defaultValue={row[extra.key] ?? ""}
                  key={`${extra.key}-${row.id}-${row[extra.key] ?? ""}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    const n = v === "" ? null : parseFloat(v);
                    if (n !== row[extra.key])
                      patch(row, { [extra.key]: n } as any);
                  }}
                  placeholder={extra.placeholder ?? "—"}
                  title={extra.rowTitle ?? extra.addLabel}
                  className={cn(
                    "h-8 rounded-md border border-border bg-surface px-2 font-mono text-[11px]",
                    extra.width ?? "w-20",
                  )}
                />
              )}
              <span
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
                  active ? "bg-synced/15 text-synced" : "bg-bg text-ink-muted",
                )}
              >
                {active ? "Active" : "Hidden"}
              </span>
              <RowActionsMenu
                indicator={!active}
                items={[
                  {
                    type: "toggle",
                    icon: active ? Eye : EyeOff,
                    label: active ? "Active" : "Hidden",
                    active,
                    onClick: () => patch(row, { active: active ? 0 : 1 } as any),
                  },
                  {
                    type: "action",
                    icon: Trash2,
                    label: "Hide from picker",
                    danger: true,
                    onClick: () => remove(row),
                  },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
