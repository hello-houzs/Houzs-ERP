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
    // Outer track is the visible "slab"; the inner scroller is what
    // actually owns the buttons. When the option set is short the
    // group stays inline-sized; when it overflows (long label set on
    // a phone) it scrolls horizontally inside the slab without
    // bleeding into the layout. max-w-full prevents the inline-flex
    // from forcing parent width.
    <div className="inline-block max-w-full overflow-hidden rounded-md border border-border bg-surface shadow-stone align-middle">
      <div
        className={cn(
          "no-scrollbar flex items-center gap-0.5 overflow-x-auto p-1",
          "[&>*]:shrink-0"
        )}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={cn(
                "whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-all duration-150",
                active
                  ? "bg-primary text-white shadow-sm"
                  : "text-ink-secondary hover:bg-primary-soft hover:text-primary"
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
