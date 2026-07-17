import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { Plus, ShoppingCart, Wrench, FolderPlus, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { quickActionAccess } from "../auth/salesAccess";
import { cn } from "../lib/utils";

/**
 * Floating "+" FAB with a speed-dial menu.
 *
 * Owner (2026-06-23): the "+" originally opened New Sales Order
 * directly. Nick (2026-07-09): "这个+符号目前是sales order - 需要加上
 * create service case的function" — so the FAB now offers both actions
 * as a small popover that opens on tap:
 *   · New Sales Order  → /scm/sales-orders/new
 *   · New Service Case → /assr?view=cases&new=1 (ServiceCases page
 *     seeds `showCreate` from `?new=1` so the create panel is already
 *     open on arrival)
 *
 * Each action is gated by its own permission. If the operator can only
 * reach one of the two, the FAB skips the menu entirely and behaves
 * like the old direct-open button — no unnecessary click.
 *
 * The SO route is gated on `scm.access` (or a per-position SCM
 * sales-orders grant); the Service Case route is gated on `service_cases`
 * L2. If neither is reachable the FAB is hidden entirely (no dead "+"
 * on the driver shell for example).
 */
export function QuickActionsFAB() {
  const { user, can, pageAccess } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Close the menu on route change so tapping an action doesn't leave
  // the popover hanging on the next page.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Also close on Escape when open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Hide on the driver shell (separate layout) and when not authed.
  if (!user) return null;
  if (location.pathname.startsWith("/driver")) return null;

  // Shared with the mobile MobileSalesOrders FAB (auth/salesAccess) so the
  // "New Service Case includes Sales staff" rule lives in one place.
  const { canNewSo, canNewCase } = quickActionAccess(user, can, pageAccess);
  // New Project — for users who can create events (owner/management/directors).
  const canNewProject = can("projects.write");

  const actions: Array<{
    key: "so" | "case" | "project";
    label: string;
    icon: typeof ShoppingCart;
    to: string;
    tone: "primary" | "secondary";
  }> = [];
  if (canNewSo) {
    actions.push({
      key: "so",
      label: "New Sales Order",
      icon: ShoppingCart,
      to: "/scm/sales-orders/new",
      tone: "primary",
    });
  }
  if (canNewCase) {
    actions.push({
      key: "case",
      label: "New Service Case",
      icon: Wrench,
      to: "/assr?view=cases&new=1",
      tone: "secondary",
    });
  }
  if (canNewProject) {
    actions.push({
      key: "project",
      label: "New Project",
      icon: FolderPlus,
      to: "/projects?new=1",
      tone: "secondary",
    });
  }

  if (actions.length === 0) return null;

  const onFabClick = () => {
    if (actions.length === 1) {
      // Preserve the old direct-open behaviour when there's only one
      // eligible action — no menu, one tap = one navigation.
      navigate(actions[0].to);
      return;
    }
    setOpen((o) => !o);
  };

  const node = (
    <>
      {/* Click-outside scrim — same z-index tier as the FAB so a tap
          anywhere outside the popover dismisses it. Transparent (not a
          dark overlay) because this isn't a modal — the underlying page
          should still be legible. */}
      {open && (
        <div
          className="fixed inset-0 z-30"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Action buttons stack UPWARD from just above the "+" FAB. Each
          animates in with a small stagger (fade + slide) so the group
          reads as one motion. Same right offset as the FAB so the labels
          align to the right edge. */}
      {open && (
        <div
          className={cn(
            "fixed z-40 flex flex-col items-end gap-2",
            // Sit directly above the "+" — its bottom + its height + 8 px.
            //   Mobile "+":  bottom-24 (96) + h-12 (48) + 8 = 152 px
            //   Desktop "+": bottom-5 (20) + h-14 (56) + 8 = 84 px
            "right-4 bottom-[calc(9.5rem+env(safe-area-inset-bottom))]",
            "lg:right-5 lg:bottom-[84px]",
          )}
        >
          {actions.map((a, i) => {
            const Icon = a.icon;
            return (
              <button
                key={a.key}
                onClick={() => {
                  setOpen(false);
                  navigate(a.to);
                }}
                className={cn(
                  "group flex items-center gap-2 rounded-full pl-3 pr-4 shadow-slab transition-all duration-200 hover:scale-[1.02] active:scale-95",
                  "h-10 lg:h-11",
                  a.tone === "primary"
                    ? "bg-primary text-white hover:bg-primary-ink"
                    : "bg-surface text-ink border border-border hover:border-primary/50",
                )}
                style={{
                  animation: `qa-fab-in 180ms ease-out ${i * 40}ms both`,
                }}
              >
                <span
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-full",
                    a.tone === "primary" ? "bg-white/15" : "bg-primary/10 text-primary",
                  )}
                >
                  <Icon size={14} strokeWidth={2} />
                </span>
                <span className="text-[13px] font-semibold tracking-tight whitespace-nowrap">
                  {a.label}
                </span>
              </button>
            );
          })}
          <style>{`
            @keyframes qa-fab-in {
              from { opacity: 0; transform: translateY(6px); }
              to   { opacity: 1; transform: translateY(0);   }
            }
          `}</style>
        </div>
      )}

      {/* The main "+" FAB — icon flips to X when the menu is open so
          the button doubles as the dismiss control. */}
      <button
        onClick={onFabClick}
        aria-label={
          actions.length === 1
            ? actions[0].label
            : open
              ? "Close quick actions"
              : "Quick actions"
        }
        title={
          actions.length === 1
            ? actions[0].label
            : open
              ? "Close"
              : "Quick actions"
        }
        aria-expanded={actions.length > 1 ? open : undefined}
        className={cn(
          "fixed right-4 z-40 inline-flex items-center justify-center rounded-full bg-primary text-white shadow-slab transition-all duration-200 hover:scale-105 hover:bg-primary-ink active:scale-95",
          "h-12 w-12 lg:h-14 lg:w-14 lg:right-5",
          "bottom-[calc(theme(spacing.24)+env(safe-area-inset-bottom))] lg:bottom-5",
          open && "rotate-45",
        )}
      >
        {open ? (
          <X size={22} strokeWidth={2.4} />
        ) : (
          <Plus size={22} strokeWidth={2.4} />
        )}
      </button>
    </>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
