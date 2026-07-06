import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Search, Check } from "lucide-react";
import { cn } from "../lib/utils";

export interface UserOptionItem {
  id: number;
  name: string | null;
  email?: string | null;
}

/**
 * Searchable, A→Z sorted, multi-select people picker (Nick 2026-07-06:
 * "选人的做成 sort A to Z + 搜索 + multi-select"). Selected people render
 * as removable chips; the dropdown filters as you type. `max` caps the
 * selection (e.g. 2 for primary + co-assignee) — at the cap, picking
 * another person is ignored until one chip is removed.
 *
 * Selection ORDER is meaningful to callers (first = primary), so chips
 * keep insertion order while the dropdown stays alphabetical.
 *
 * The dropdown renders through a PORTAL with fixed positioning so it
 * escapes any card/panel overflow clipping (Nick's follow-up: options
 * must never be trapped inside the card, on every page).
 */
export function UserMultiSelect({
  options,
  value,
  onChange,
  max,
  placeholder = "Search people…",
  disabled,
}: {
  options: UserOptionItem[];
  value: number[];
  onChange: (ids: number[]) => void;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Track the control's viewport position while open so the portalled
  // menu follows it through scrolling panels and window resizes.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const el = controlRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Close on outside click — the menu lives in a portal, so check both.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (controlRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
      setQuery("");
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const labelOf = (o: UserOptionItem) => o.name || o.email || `user #${o.id}`;

  const sorted = useMemo(
    () => [...options].sort((a, b) => labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: "base" })),
    [options]
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (o) => labelOf(o).toLowerCase().includes(q) || (o.email || "").toLowerCase().includes(q)
    );
  }, [sorted, query]);

  const selected = value
    .map((id) => options.find((o) => o.id === id))
    .filter((o): o is UserOptionItem => !!o);
  const atMax = max != null && value.length >= max;

  function toggle(id: number) {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      if (atMax) return;
      onChange([...value, id]);
    }
    setQuery("");
    inputRef.current?.focus();
  }

  const menu =
    open && rect
      ? createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width, zIndex: 90 }}
            className="max-h-64 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-stone"
          >
            {max != null && (
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Up to {max} {max === 1 ? "person" : "people"}
                {atMax ? " — remove one to change" : ""}
              </div>
            )}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-ink-muted">No matches</div>
            )}
            {filtered.map((o) => {
              const isSel = value.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => toggle(o.id)}
                  disabled={!isSel && atMax}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-bg",
                    isSel && "font-semibold text-primary",
                    !isSel && atMax && "cursor-not-allowed opacity-45"
                  )}
                >
                  <span className="truncate">{labelOf(o)}</span>
                  {isSel && <Check size={13} className="shrink-0" />}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <div ref={controlRef} className="relative">
      <div
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] transition-colors",
          open && "border-primary ring-2 ring-primary/20",
          disabled && "pointer-events-none opacity-60"
        )}
      >
        {selected.map((o) => (
          <span
            key={o.id}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[12px] font-medium text-primary"
          >
            {labelOf(o)}
            <button
              type="button"
              aria-label={`Remove ${labelOf(o)}`}
              onClick={(e) => {
                e.stopPropagation();
                toggle(o.id);
              }}
              className="rounded-full p-0.5 hover:bg-primary/15"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <span className="flex flex-1 items-center gap-1.5 min-w-[120px]">
          {selected.length === 0 && <Search size={13} className="shrink-0 text-ink-muted" />}
          <input
            ref={inputRef}
            value={query}
            disabled={disabled}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={selected.length === 0 ? placeholder : atMax ? "" : "Add another…"}
            className="w-full min-w-[80px] bg-transparent py-0.5 outline-none placeholder:text-ink-muted"
          />
        </span>
      </div>
      {menu}
    </div>
  );
}
