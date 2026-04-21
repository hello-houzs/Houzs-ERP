import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/**
 * Right-side document panel.
 *
 * Rendered through a React portal into <body>. This is required because the
 * page wrapper in Layout.tsx applies an `animate-rise` (transform), and any
 * non-`none` transform on an ancestor turns `position: fixed` into
 * "fixed relative to that ancestor" instead of the viewport. Without the
 * portal, the panel's `translate-x-full` off-screen state ends up inside
 * the page's horizontal scroll area and slides into view whenever a wide
 * table makes the page scrollable to the right.
 */
export function Panel({ open, onClose, title, subtitle, children, footer, width = 420 }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const node = (
    <div
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex transition-transform duration-200",
        // Width is set inline but capped at 100vw so it can never exceed
        // the viewport on mobile. On a 360px phone, a requested width of
        // 460px clamps down to 360px automatically.
        "max-w-[100vw]",
        // pointer-events-none when closed so the off-screen panel can't
        // intercept clicks on the underlying canvas.
        open ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none"
      )}
      style={{ width }}
      aria-hidden={!open}
    >
      <div className="relative flex h-full w-full flex-col border-l border-border bg-surface shadow-slab">
        {/* Brass accent rail at the very left edge of the panel */}
        <span className="pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-gradient-to-b from-accent/0 via-accent/60 to-accent/0" />
        <div className="flex items-start justify-between border-b border-border px-6 py-5">
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-brand text-accent">
              Document
            </div>
            <h2 className="mt-1 font-display text-[18px] font-extrabold tracking-tight text-ink">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-secondary">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-muted transition-colors hover:bg-surface-dim hover:text-ink"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <div className="border-t border-border bg-bg/60 px-6 py-3">{footer}</div>
        )}
      </div>
    </div>
  );

  // SSR safety: createPortal requires a real DOM target.
  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}

interface SectionProps {
  title: string;
  children: ReactNode;
  muted?: boolean;
}

export function PanelSection({ title, children, muted }: SectionProps) {
  return (
    <section
      className={cn(
        "mb-3 rounded-md border border-border p-3",
        muted ? "bg-bg/60" : "bg-surface"
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <div className="text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
          {title}
        </div>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function FieldRow({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-xs text-ink-muted">{label}</span>
      <span className={cn("text-right text-sm", mono && "font-mono")}>{children}</span>
    </div>
  );
}
