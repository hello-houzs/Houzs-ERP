import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";

interface Props {
  /** Called on backdrop click or Escape (when dismissable). */
  onClose: () => void;
  /**
   * The dialog card. The caller owns the card markup (a `<div>` or a
   * `<form>`, its own width / padding / header) — Modal only provides the
   * centered, blurred backdrop, the portal, Escape-to-close and
   * click-outside. Stop propagation on the card so inner clicks don't
   * close (the helper `stopCardClick` is exported for that).
   */
  children: ReactNode;
  /** "center" (default) or "top" for tall, scrollable content. */
  align?: "center" | "top";
  /** Stacking context — defaults to z-50. Pass e.g. "z-[80]" to layer above another modal. */
  zClassName?: string;
  /** When false, backdrop click + Escape don't close (e.g. mid-submit). Default true. */
  dismissable?: boolean;
  /** Extra classes on the backdrop. */
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

/**
 * Centered modal backdrop — the shared replacement for the
 * `fixed inset-0 flex items-center justify-center bg-ink/60 backdrop-blur`
 * pattern hand-rolled across PettyCash, Shop, the SCM detail pages, etc.
 * Renders through a portal (so it escapes any clipping/overflow ancestor),
 * closes on Escape, and locks body scroll while open.
 *
 * Render it conditionally — `{open && <Modal …>…</Modal>}` — and put your
 * own card inside:
 *
 *   <Modal onClose={close} aria-label="New entry">
 *     <form onClick={stopCardClick} className="w-full max-w-md …">…</form>
 *   </Modal>
 */
export function Modal({
  onClose,
  children,
  align = "center",
  zClassName = "z-50",
  dismissable = true,
  className,
  ...aria
}: Props) {
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissable, onClose]);

  // Lock background scroll while the modal is mounted.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      {...aria}
      onClick={dismissable ? onClose : undefined}
      className={cn(
        "fixed inset-0 flex justify-center bg-ink/60 p-4 backdrop-blur-sm animate-fade-in",
        zClassName,
        align === "top" ? "items-start overflow-y-auto sm:p-10" : "items-center",
        className
      )}
    >
      {children}
    </div>,
    document.body
  );
}

/** Attach to the dialog card so inner clicks don't bubble to the backdrop. */
export const stopCardClick = (e: React.MouseEvent) => e.stopPropagation();
