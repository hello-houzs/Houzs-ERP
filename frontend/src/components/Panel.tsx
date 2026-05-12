import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** When true, Esc and X-click route through `onAttemptClose` (typically a
   *  confirm dialog) instead of `onClose`. The page is responsible for
   *  calling `onClose` itself if the user confirms the discard. */
  dirty?: boolean;
  /** Called when the user attempts to dismiss while `dirty`. Required when
   *  `dirty` is set; ignored otherwise. */
  onAttemptClose?: () => void;
}

/** Selector for "anything keyboard-tabbable" used by the focus trap. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
export function Panel({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 420,
  dirty,
  onAttemptClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Route Esc + X click through the dirty guard when set; otherwise close
  // directly. `onClose` callers (e.g. on submit success) bypass this.
  function attemptClose() {
    if (dirty && onAttemptClose) {
      onAttemptClose();
    } else {
      onClose();
    }
  }

  // Keyboard handling: Esc dismiss + Tab focus cycling inside the panel.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        attemptClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const insidePanel = !!(active && panelRef.current.contains(active));
        if (e.shiftKey) {
          if (!insidePanel || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (!insidePanel || active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dirty, onAttemptClose, onClose]);

  // Focus management: capture the previously-focused element on open, focus
  // the first focusable inside the panel after the slide-in begins, restore
  // focus when the panel closes.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      if (!panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      );
      const first = Array.from(focusables).find((el) => el.offsetParent !== null);
      first?.focus();
    }, 50);
    return () => {
      window.clearTimeout(t);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  const node = (
    <div
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex transition-transform duration-200",
        // Width is set inline but capped to leave a 24 px gutter on the
        // left at narrow widths so the panel reads as a sheet, not a
        // full-screen takeover. At sm+ (≥640 px) the gutter falls away
        // because the panel never needs to fill the viewport there.
        "max-w-[calc(100vw-1.5rem)] sm:max-w-[100vw]",
        // pointer-events-none when closed so the off-screen panel can't
        // intercept clicks on the underlying canvas.
        open ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none",
      )}
      style={{ width }}
      aria-hidden={!open}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div
        ref={panelRef}
        className="relative flex h-full w-full flex-col border-l border-border bg-surface shadow-slab"
      >
        {/* Brass accent rail at the very left edge of the panel */}
        <span className="pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-gradient-to-b from-accent/0 via-accent/60 to-accent/0" />
        <div className="flex items-start justify-between border-b border-border px-4 py-4 sm:px-6 sm:py-5">
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
            onClick={attemptClose}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-dim hover:text-ink"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">{children}</div>
        {footer && (
          <div className="border-t border-border bg-bg/60 px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-6">
            {footer}
          </div>
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
  /** Optional control rendered top-right of the section header. */
  action?: ReactNode;
}

export function PanelSection({ title, children, muted, action }: SectionProps) {
  return (
    <section
      className={cn(
        "mb-3 rounded-md border border-border p-3",
        muted ? "bg-bg/60" : "bg-surface"
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <div className="flex-1 text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
          {title}
        </div>
        {action && <div className="shrink-0">{action}</div>}
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
