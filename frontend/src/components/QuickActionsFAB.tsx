import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Plus,
  ShoppingCart,
  Truck,
  Package,
  Briefcase,
  Wrench,
  Wallet,
  Lightbulb,
  MessageCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/utils";

/**
 * Replaces the previous FloatingChatWidget. The bottom nav already
 * exposes Inbox / chat surfaces, so the floating button is repurposed
 * as a global "create new …" speed dial.
 *
 * Click the FAB → a small popover lists every "New X" shortcut the
 * caller has the read perm for. Click an item → navigate to the
 * relevant list page. Each list page owns its own create UI so we
 * don't duplicate it here.
 */

interface ActionItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Read perm on the surface. Items without a perm are open to all. */
  perm?: string;
  description?: string;
}

const ACTIONS: ActionItem[] = [
  {
    to: "/orders",
    label: "Sales order",
    icon: ShoppingCart,
    perm: "sales_orders.read",
    description: "New customer order",
  },
  {
    to: "/delivery-orders",
    label: "Delivery order",
    icon: Truck,
    perm: "delivery_orders.read",
    description: "Outbound DO",
  },
  {
    to: "/po",
    label: "Purchase order",
    icon: Package,
    perm: "purchase_orders.read",
    description: "Inbound PO",
  },
  {
    to: "/projects",
    label: "Project",
    icon: Briefcase,
    perm: "projects.write",
    description: "Exhibition or build",
  },
  {
    to: "/assr",
    label: "Service case",
    icon: Wrench,
    perm: "service_cases.read",
    description: "ASSR ticket",
  },
  {
    to: "/petty-cash",
    label: "Petty cash",
    icon: Wallet,
    perm: "petty_cash.post",
    description: "Cash in or out",
  },
  {
    to: "/innovations",
    label: "Innovation",
    icon: Lightbulb,
    description: "Pitch a big idea",
  },
  {
    to: "/suggestions",
    label: "Suggestion",
    icon: MessageCircle,
    description: "Quick operational fix",
  },
];

export function QuickActionsFAB() {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Close on Esc or click outside the FAB / panel.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onMouse(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (fabRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouse);
    };
  }, [open]);

  // Auto-close on route change so the popover never lingers when the
  // user navigates away by other means.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Hide on the driver shell (separate layout) and when not authed.
  if (!user) return null;
  if (location.pathname.startsWith("/driver")) return null;

  const visible = ACTIONS.filter((a) => !a.perm || can(a.perm));
  if (visible.length === 0) return null;

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  const node = (
    <>
      {/* FAB */}
      <button
        ref={fabRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close quick actions" : "Open quick actions"}
        title="Create new…"
        className={cn(
          "fixed right-4 z-40 inline-flex items-center justify-center rounded-full bg-accent text-white shadow-slab transition-all duration-200 hover:scale-105 hover:bg-accent-hover",
          "h-12 w-12 lg:h-14 lg:w-14 lg:right-5",
          "bottom-[calc(theme(spacing.24)+env(safe-area-inset-bottom))] lg:bottom-5",
          open && "rotate-45 scale-95",
        )}
      >
        <Plus size={22} strokeWidth={2.4} />
      </button>

      {/* Popover */}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Quick actions"
          className={cn(
            "fixed z-40 flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-slab animate-rise",
            // Desktop: anchored above the FAB at bottom-right corner.
            "bottom-24 right-5 w-[300px]",
            // Mobile: full-width sheet that floats above the tab rail
            // and the FAB itself, leaving the FAB visible below it.
            "max-sm:inset-x-2 max-sm:w-auto max-sm:bottom-[calc(theme(spacing.24)+env(safe-area-inset-bottom)+3.5rem)]",
          )}
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border bg-bg/60 px-3 py-2.5">
            <Zap size={13} className="text-accent" />
            <div className="flex-1">
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-accent">
                Quick actions
              </div>
              <div className="font-display text-[13px] font-extrabold leading-tight text-ink">
                Create new…
              </div>
            </div>
          </div>

          {/* Action list */}
          <ul className="thin-scroll max-h-[60vh] divide-y divide-border-subtle overflow-y-auto">
            {visible.map((a) => {
              const Icon = a.icon;
              return (
                <li key={a.to}>
                  <button
                    type="button"
                    onClick={() => go(a.to)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent-soft/30 active:scale-[0.99]"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent-soft/60 text-accent-ink transition-colors group-hover:bg-accent group-hover:text-white">
                      <Icon size={16} strokeWidth={2} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-bold text-ink">
                        {a.label}
                      </span>
                      {a.description && (
                        <span className="block truncate text-[11px] text-ink-muted">
                          {a.description}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
