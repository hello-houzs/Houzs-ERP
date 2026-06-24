import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/utils";

/**
 * Floating "+" FAB. Owner (2026-06-23): tapping it should open a new
 * Sales Order — the single most-common create action on mobile — rather
 * than opening a "create new …" speed dial. So the FAB now navigates
 * straight to /scm/sales-orders/new on click; no menu.
 *
 * The SO route is gated on `scm.access` (or a per-position SCM
 * sales-orders grant), so the FAB only shows for users who can actually
 * land on the New SO page — otherwise it would bounce them to Forbidden.
 */
export function QuickActionsFAB() {
  const { user, can, pageAccess } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Hide on the driver shell (separate layout) and when not authed.
  if (!user) return null;
  if (location.pathname.startsWith("/driver")) return null;

  // Mirror the New-SO route guard (ScmGuard area="scm.sales.orders"): pass
  // on the scm.access wildcard OR a per-position sales-orders page grant.
  const canNewSo = can("scm.access") || pageAccess("scm.sales.orders") !== "none";
  if (!canNewSo) return null;

  const node = (
    <button
      onClick={() => navigate("/scm/sales-orders/new")}
      aria-label="New Sales Order"
      title="New Sales Order"
      className={cn(
        "fixed right-4 z-40 inline-flex items-center justify-center rounded-full bg-accent text-white shadow-slab transition-all duration-200 hover:scale-105 hover:bg-accent-hover active:scale-95",
        "h-12 w-12 lg:h-14 lg:w-14 lg:right-5",
        "bottom-[calc(theme(spacing.24)+env(safe-area-inset-bottom))] lg:bottom-5",
      )}
    >
      <Plus size={22} strokeWidth={2.4} />
    </button>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
