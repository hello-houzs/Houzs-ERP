import { useEffect, useRef, useState } from "react";
import { MoreVertical, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Generic ellipsis menu for table rows / chips. Collapses arbitrary
 * per-row controls into a single trigger so admin tables and inline
 * row-affordances share one visual language.
 *
 * Used by Project Maintenance (checklist items, brands, event types,
 * venues, organizers) and per-task attachment chips. Click-outside
 * and Esc close.
 */

export interface MenuItem {
  /** "toggle" shows an ON chip + filled icon plate when active.
   *  "action" fires the click without state. Defaults to "action". */
  type?: "toggle" | "action";
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  /** For toggles: current value drives the plate fill. */
  active?: boolean;
  /** Renders the row in `err` colour with an err-tinted icon plate. */
  danger?: boolean;
}

export function RowActionsMenu({
  items,
  indicator,
  title = "Row actions",
  size = 28,
}: {
  items: MenuItem[];
  /** Tiny brass dot on the trigger to flag a state worth noticing
   *  (e.g. "this template item needs management review") without
   *  having to open every menu. */
  indicator?: boolean;
  title?: string;
  /** Trigger square size in px. Default 28 (h-7 w-7). */
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        style={{ width: size, height: size }}
        className={cn(
          "inline-flex items-center justify-center rounded-md border transition-colors",
          open
            ? "border-primary/50 bg-primary-soft text-primary"
            : "border-transparent text-ink-muted hover:border-border hover:bg-bg/60 hover:text-ink",
          indicator &&
            "after:absolute after:right-1 after:top-1 after:h-1.5 after:w-1.5 after:rounded-full after:bg-primary"
        )}
      >
        <MoreVertical size={Math.round(size / 2)} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-md border border-border bg-surface shadow-slab"
        >
          {items.map((it, i) => {
            const Icon = it.icon;
            const isToggle = it.type === "toggle";
            const isDanger = !!it.danger;
            return (
              <div key={i}>
                {i > 0 && <div className="h-px bg-border-subtle" />}
                <button
                  type="button"
                  role={isToggle ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={isToggle ? !!it.active : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    it.onClick();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-2 text-left text-[11.5px]",
                    isDanger
                      ? "text-err hover:bg-err/10"
                      : "hover:bg-accent-soft/30"
                  )}
                >
                  <span
                    className={cn(
                      "grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors",
                      isDanger
                        ? "border-err/30 bg-err/5 text-err"
                        : isToggle && it.active
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-bg/40 text-ink-muted"
                    )}
                  >
                    <Icon
                      size={11}
                      strokeWidth={isToggle && it.active ? 2.4 : 1.8}
                    />
                  </span>
                  <span
                    className={cn(
                      "flex-1 font-medium",
                      !isDanger && "text-ink"
                    )}
                  >
                    {it.label}
                  </span>
                  {isToggle && it.active && (
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-accent">
                      On
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
