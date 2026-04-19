import { cn } from "../lib/utils";

interface Pill<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: Pill<T>[];
  value: T;
  onChange: (v: T) => void;
}

/**
 * In-page filter chip group. Visually paired with <TabStrip/> — both
 * use brass as the active colour, but FilterPills stays compact and
 * self-contained (rounded slab) so it reads as "filter the current
 * view" while TabStrip reads as "switch views".
 */
export function FilterPills<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-1 shadow-stone">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-all duration-150",
              active
                ? "bg-accent text-white shadow-sm"
                : "text-ink-secondary hover:bg-accent-soft/50 hover:text-accent"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
