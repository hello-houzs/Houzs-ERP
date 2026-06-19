import { type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";

// Shared, consistent primitives for SCM document LINE-ITEM editors (PO/GRN/PI/PR
// /SO/DO/DR/transfer/take/consignment "New" forms). Before this, each form's line
// editor was hand-rolled by a different agent → inconsistent + label-less bare
// inputs. Every line editor now composes LineCard + LineField + lineInputCls so
// they all look like one app (Houzs warm theme, 2990's labeled layout). Compact:
// 10px uppercase labels (smaller than the panel-form Field) so multi-line lists
// stay dense.

/** Input styling for a line field — same as the panel Input, kept here so line
 *  editors don't re-derive it. Use on <input>/<select>/<textarea>. */
export const lineInputCls =
  "h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50";

/** A labeled field inside a line card. The label is mandatory — that's the whole
 *  point (no more bare placeholder-only boxes). `align="right"` for numeric. */
export function LineField({
  label,
  required,
  className,
  align,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  align?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span
        className={cn(
          "mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted",
          align === "right" && "text-right",
        )}
      >
        {label}
        {required && <span className="ml-0.5 text-err">*</span>}
      </span>
      {children}
    </label>
  );
}

/** Per-line card shell: numbered badge + remove button + the form's fields. Gives
 *  every document's line list the same card rhythm. */
export function LineCard({
  index,
  onRemove,
  removeDisabled,
  removeTitle,
  children,
}: {
  index: number;
  onRemove?: () => void;
  removeDisabled?: boolean;
  removeTitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3.5 shadow-stone">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded bg-surface-dim px-1 text-[11px] font-bold text-ink-muted">
          {index}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={removeDisabled}
            title={removeTitle ?? "Remove line"}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-err/5 hover:text-err disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

/** A right-aligned line total / amount pill row, used under the fields. */
export function LineTotalRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-border-subtle pt-2 text-[13px]",
        className,
      )}
    >
      {children}
    </div>
  );
}
