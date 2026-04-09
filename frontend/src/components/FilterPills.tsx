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
                ? "bg-ink text-bg shadow-sm"
                : "text-ink-secondary hover:bg-surface-dim hover:text-ink"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
