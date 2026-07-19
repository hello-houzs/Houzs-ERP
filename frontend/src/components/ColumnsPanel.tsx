import { useEffect, useState } from "react";
import { Check, GripVertical, Plus, Trash2, Columns3 } from "lucide-react";
import { Panel } from "./Panel";
import { Button } from "./Button";
import type { UseUdfResult, UdfFieldType } from "../hooks/useUdf";
import { useDialog } from "../hooks/useDialog";
import { useToast } from "../hooks/useToast";
import { cn } from "../lib/utils";

/**
 * Unified columns panel — replaces the old dropdown "Columns" chooser
 * AND the separate "Fields" (UDF) button. Two sections:
 *
 *   1. Columns — reorderable + show/hide. Drag a row by its handle to
 *      move it. Hidden columns still appear in the list; toggle them
 *      back on via the checkbox.
 *   2. Custom Fields (when udf is provided) — add, delete. Renaming
 *      isn't exposed here; the backend `key` is stable by design.
 *
 * Rendered as a right-side <Panel/> so it can grow as needed without
 * getting cramped on mobile.
 */

interface Option {
  key: string;
  label: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** All column options (excluding alwaysVisible). In storage-order, i.e. the
   *  order the user has arranged them in. */
  options: Option[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onResetVisibility: () => void;
  onReorder: (nextOrder: string[]) => void;
  onResetOrder: () => void;
  /** Optional UDF integration. When provided, the Custom Fields section
   *  shows up and its add/delete wire through to the hook. */
  udf?: UseUdfResult;
  udfTableLabel?: string;
}

const FIELD_TYPES: Array<{ value: UdfFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select" },
  { value: "checkbox", label: "Checkbox" },
];

export function ColumnsPanel({
  open,
  onClose,
  options,
  hidden,
  onToggle,
  onResetVisibility,
  onReorder,
  onResetOrder,
  udf,
  udfTableLabel,
}: Props) {
  // ── Drag state ──────────────────────────────────────────────
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  function handleDragStart(key: string) {
    setDragKey(key);
  }
  function handleDragOver(e: React.DragEvent, key: string) {
    e.preventDefault();
    if (key !== overKey) setOverKey(key);
  }
  function handleDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null);
      setOverKey(null);
      return;
    }
    const order = options.map((o) => o.key);
    const from = order.indexOf(dragKey);
    const to = order.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, dragKey);
    onReorder(order);
    setDragKey(null);
    setOverKey(null);
  }
  function handleDragEnd() {
    setDragKey(null);
    setOverKey(null);
  }

  return (
    <Panel
      open={open}
      onClose={onClose}
      title="Columns"
      subtitle="Show / hide, reorder, and manage custom fields"
      width={460}
    >
      {/* ── Columns list ───────────────────────────────────── */}
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Table Columns
          </h3>
          <div className="flex items-center gap-2 text-[10px]">
            <button
              onClick={onResetVisibility}
              className="text-ink-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Show all
            </button>
            <span className="text-ink-muted">·</span>
            <button
              onClick={onResetOrder}
              className="text-ink-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Reset order
            </button>
          </div>
        </div>
        <div className="divide-y divide-border-subtle rounded-md border border-border bg-surface">
          {options.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-ink-muted">No reorderable columns.</div>
          )}
          {options.map((opt) => {
            const visible = !hidden.has(opt.key);
            const isDragging = dragKey === opt.key;
            const isDropTarget = overKey === opt.key && dragKey && dragKey !== opt.key;
            return (
              <div
                key={opt.key}
                draggable
                onDragStart={() => handleDragStart(opt.key)}
                onDragOver={(e) => handleDragOver(e, opt.key)}
                onDrop={() => handleDrop(opt.key)}
                onDragEnd={handleDragEnd}
                className={cn(
                  "flex items-center gap-2 px-2 py-2 transition-colors",
                  isDragging && "opacity-50",
                  isDropTarget && "bg-accent-soft/40"
                )}
              >
                <span
                  className="cursor-grab text-ink-muted hover:text-ink active:cursor-grabbing"
                  title="Drag to reorder"
                >
                  <GripVertical size={14} />
                </span>
                <button
                  onClick={() => onToggle(opt.key)}
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                    visible ? "border-primary bg-primary text-white" : "border-border bg-surface"
                  )}
                  aria-label={visible ? "Hide column" : "Show column"}
                >
                  {visible && <Check size={10} strokeWidth={3} />}
                </button>
                <button
                  onClick={() => onToggle(opt.key)}
                  className={cn(
                    "flex-1 text-left text-[12.5px]",
                    visible ? "text-ink" : "text-ink-muted"
                  )}
                >
                  {opt.label}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Custom fields (UDF) section ─────────────────────── */}
      {udf && <CustomFieldsSection udf={udf} label={udfTableLabel || ""} />}
    </Panel>
  );
}

function CustomFieldsSection({ udf, label }: { udf: UseUdfResult; label: string }) {
  const dialog = useDialog();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [formLabel, setFormLabel] = useState("");
  const [key, setKey] = useState("");
  const [type, setType] = useState<UdfFieldType>("text");
  const [optionsRaw, setOptionsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!creating) return;
    const auto = formLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (auto && (key === "" || key === prevAutoKey(formLabel))) setKey(auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formLabel, creating]);

  function prevAutoKey(s: string) {
    return s
      .slice(0, -1)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  }

  async function submitNew() {
    setFormError(null);
    if (!formLabel.trim()) return setFormError("Label is required");
    if (!/^[a-z][a-z0-9_]*$/.test(key)) return setFormError("Key must be snake_case starting with a letter");
    let options: string[] | undefined;
    if (type === "select") {
      options = optionsRaw.split(/\r?\n|,/).map((o) => o.trim()).filter(Boolean);
      if (!options.length) return setFormError("Select fields need at least one option");
    }
    setSubmitting(true);
    try {
      await udf.addField({ label: formLabel.trim(), key, type, options });
      setFormLabel("");
      setKey("");
      setType("text");
      setOptionsRaw("");
      setCreating(false);
    } catch (e: any) {
      setFormError(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(fieldKey: string, fieldLabel: string) {
    if (!await dialog.confirm(`Delete custom field "${fieldLabel}"?\n\nAll stored values will be removed.`)) return;
    try {
      await udf.deleteField(fieldKey);
    } catch (e: any) {
      toast.error(`Failed to delete: ${e?.message || e}`);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Custom Fields {label && `· ${label}`}
        </h3>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-brand text-accent hover:underline"
          >
            <Plus size={11} /> Add field
          </button>
        )}
      </div>

      {udf.loading && <div className="text-[11px] text-ink-muted">Loading…</div>}
      {udf.error && (
        <div className="rounded border border-err/30 bg-err/5 px-3 py-2 text-[11px] text-err">
          {udf.error}
        </div>
      )}

      {!udf.loading && !udf.error && udf.fields.length === 0 && !creating && (
        <div className="rounded-md border border-dashed border-border bg-bg/60 px-4 py-5 text-center text-[11px] text-ink-muted">
          No custom fields yet.
        </div>
      )}

      {udf.fields.length > 0 && (
        <ul className="divide-y divide-border-subtle rounded-md border border-border bg-surface">
          {udf.fields.map((f) => (
            <li key={f.key} className="group flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold text-ink">{f.label}</span>
                  <span className="rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                    {f.type}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-ink-muted">
                  {f.key}
                  {f.options && ` · ${f.options.length} options`}
                </div>
              </div>
              <button
                onClick={() => handleDelete(f.key, f.label)}
                className="rounded p-1 text-ink-muted opacity-0 transition-all hover:bg-err/10 hover:text-err group-hover:opacity-100"
                aria-label={`Delete ${f.label}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/30 p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-accent">
            New Custom Field
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <FieldLabel>Label</FieldLabel>
              <input
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder="e.g. Internal Notes"
                autoFocus
                className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <FieldLabel>Key</FieldLabel>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="snake_case"
                className="h-9 w-full rounded-md border border-border bg-surface px-3 font-mono text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <FieldLabel>Type</FieldLabel>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as UdfFieldType)}
                className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            {type === "select" && (
              <div className="col-span-2">
                <FieldLabel>Options (comma or newline separated)</FieldLabel>
                <textarea
                  value={optionsRaw}
                  onChange={(e) => setOptionsRaw(e.target.value)}
                  placeholder="High&#10;Medium&#10;Low"
                  className="min-h-[68px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}
          </div>
          {formError && <div className="mt-2 text-[11px] text-err">{formError}</div>}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="brass" onClick={submitNew} disabled={submitting}>
              {submitting ? "Adding…" : "Add Field"}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 text-[10px] text-ink-muted">
        Stored locally · Never sent to AutoCount
      </div>
    </section>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      {children}
    </label>
  );
}

// ── Trigger button ──────────────────────────────────────────
// Rendered by DataTable next to Export/Density. Kept in this file so
// the look stays in one place.

export function ColumnsPanelButton({
  visibleCount,
  totalCount,
  onClick,
  active,
  disabled,
}: {
  visibleCount: number;
  totalCount: number;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={`Columns — ${visibleCount} of ${totalCount} shown`}
      className={cn(
        "group inline-flex h-[34px] items-center gap-2.5 rounded-lg border bg-surface px-3.5 text-[12.5px] font-medium text-ink-secondary",
        "shadow-[0_1px_1px_rgba(17,20,15,0.03)] transition-all duration-fast ease-out",
        "hover:-translate-y-px hover:border-primary/45 hover:shadow-[0_4px_12px_rgba(22,105,95,0.12)]",
        "active:translate-y-0 disabled:pointer-events-none disabled:opacity-45",
        active ? "border-primary text-primary" : "border-border"
      )}
    >
      {/* icon tile */}
      <span
        className={cn(
          "-ml-1 grid h-[22px] w-[22px] place-items-center rounded-md transition-colors duration-fast",
          active
            ? "bg-primary text-white"
            : "bg-surface-2 text-ink-muted group-hover:bg-primary/12 group-hover:text-primary"
        )}
      >
        <Columns3 size={13} />
      </span>

      {/* label — hidden on narrow screens (collapses to compact form C) */}
      <span className="hidden sm:inline">Columns</span>

      {/* fraction, tabular-nums so it doesn't jitter */}
      <span
        className={cn(
          "font-mono text-[11.5px] font-bold tabular-nums",
          active ? "text-primary" : "text-ink-muted"
        )}
      >
        {visibleCount}/{totalCount}
      </span>
    </button>
  );
}
