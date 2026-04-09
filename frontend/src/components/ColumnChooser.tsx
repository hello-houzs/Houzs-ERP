import { useEffect, useRef, useState } from "react";
import { Columns3, Check } from "lucide-react";
import { cn } from "../lib/utils";

interface Option {
  key: string;
  label: string;
}

interface Props {
  options: Option[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onReset: () => void;
}

export function ColumnChooser({ options, hidden, onToggle, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const visibleCount = options.filter((o) => !hidden.has(o.key)).length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent",
          open && "border-accent/50 bg-accent-soft/60 text-accent"
        )}
      >
        <Columns3 size={13} />
        Columns ({visibleCount}/{options.length})
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-60 rounded-md border border-border bg-surface py-1.5 shadow-slab">
          <div className="max-h-72 overflow-y-auto">
            {options.map((opt) => {
              const visible = !hidden.has(opt.key);
              return (
                <button
                  key={opt.key}
                  onClick={() => onToggle(opt.key)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-dim"
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                      visible ? "border-accent bg-accent text-white" : "border-border bg-surface"
                    )}
                  >
                    {visible && <Check size={10} strokeWidth={3} />}
                  </span>
                  <span className="flex-1 text-ink">{opt.label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-1 border-t border-border-subtle pt-1">
            <button
              onClick={onReset}
              className="w-full px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-muted transition-colors hover:bg-surface-dim hover:text-accent"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
