import { useEffect, useRef, useState } from "react";
import { usePresence } from "../hooks/usePresence";
import { cn } from "../lib/utils";

/**
 * Compact "who's online" pill for the desktop top navbar. Shows a
 * live green dot + count; click reveals a popover listing every
 * active member. Distinct from the richer PresencePanel that lives
 * in the sidebar / mobile drawer — this one is styled for a tight
 * navbar and uses the navbar's surface colours, not the sidebar's.
 */
export function PresenceIndicator() {
  const { members, loading } = usePresence();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (loading || members.length === 0) {
    // Quiet fallback — saves the navbar from flashing "0 online" on
    // first load. The presence hook polls; it'll appear when data
    // lands.
    return null;
  }

  const visible = members.slice(0, 3);
  const overflow = Math.max(0, members.length - visible.length);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${members.length} online`}
        title={`${members.length} online`}
        className="inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-ink-secondary transition-colors hover:bg-bg/60 hover:text-accent"
      >
        {/* Pulsing green dot */}
        <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-synced/60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-synced" />
        </span>
        {/* Avatar stack */}
        <div className="flex -space-x-1.5">
          {visible.map((m) => (
            <span
              key={m.id}
              title={displayName(m)}
              className="grid h-6 w-6 place-items-center rounded-full border-2 border-surface bg-accent-soft font-mono text-[9px] font-bold uppercase text-accent-ink"
            >
              {initialsOf(m)}
            </span>
          ))}
          {overflow > 0 && (
            <span className="grid h-6 w-6 place-items-center rounded-full border-2 border-surface bg-bg/80 font-mono text-[9px] font-bold text-ink-muted">
              +{overflow}
            </span>
          )}
        </div>
        {/* Count label (xl+ only — keeps the bar tight on mid-size laptops) */}
        <span className="hidden font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted xl:inline">
          {members.length} online
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-[260px] overflow-hidden rounded-md border border-border bg-surface shadow-slab">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
            <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
              Active Now
            </span>
            <span className="font-mono text-[10px] text-ink-muted">
              {members.length}
            </span>
          </div>
          <div className="thin-scroll max-h-[60vh] overflow-y-auto">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2.5 border-b border-border-subtle px-3 py-2 last:border-b-0"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[10px] font-bold uppercase text-accent-ink">
                  {initialsOf(m)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-ink">
                    {displayName(m)}
                    {m.is_self && (
                      <span className="ml-1 font-mono text-[9px] font-medium uppercase tracking-wider text-ink-muted">
                        you
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[10px] text-ink-muted">
                    {m.role_name}
                  </div>
                </div>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-synced" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function initialsOf(m: { name: string | null; email: string }): string {
  const source = m.name || m.email;
  const parts = source.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function displayName(m: { name: string | null; email: string }): string {
  return m.name || m.email.split("@")[0];
}
