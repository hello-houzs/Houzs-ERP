import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import {
  LayoutDashboard,
  Truck,
  Headphones,
  CircleUser,
  Grid3x3,
  X,
  ClipboardList,
  Truck as TruckIcon,
  ShieldCheck,
  FolderKanban,
  Bell,
  Settings as SettingsIcon,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import { cn } from "../lib/utils";

/**
 * Mobile bottom navigation. Hidden on lg+. Five slots:
 *
 *   [ Home ] [ Logistic ] [ Menu* ] [ ASSR ] [ Profile ]
 *
 * The middle "Menu" tab is a raised brass circle that protrudes above
 * the rail and opens a bottom-sheet modal with every other
 * destination. Distinct visual so it reads as the "all-things"
 * affordance, not just another tab.
 *
 * Permission gates apply: a tab is hidden if the user lacks access.
 * The Menu modal does the same filter for its grid.
 */
interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: string;
  anyPerm?: string[];
  end?: boolean;
}

export function MobileTabBar() {
  const { can, user } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!user) return null;
  if (location.pathname.startsWith("/driver")) return null;

  const tabs: Tab[] = [
    { to: "/", label: "Home", icon: LayoutDashboard, end: true },
    {
      to: "/logistics",
      label: "Logistic",
      icon: Truck,
      anyPerm: ["trips.read.all", "fleet.read"],
    },
    {
      to: "/assr",
      label: "ASSR",
      icon: Headphones,
      perm: "service_cases.read",
    },
    { to: "/profile", label: "Profile", icon: CircleUser },
  ];

  const visible = tabs.filter((t) => {
    if (t.perm && !can(t.perm)) return false;
    if (t.anyPerm && !t.anyPerm.some((p) => can(p))) return false;
    return true;
  });

  // Split into halves around the centre so the raised Menu button
  // always sits in the middle, regardless of how many tabs are
  // permission-filtered out.
  const half = Math.ceil(visible.length / 2);
  const leftTabs = visible.slice(0, half);
  const rightTabs = visible.slice(half);

  return (
    <>
      <nav
        aria-label="Mobile navigation"
        className={cn(
          "fixed inset-x-0 bottom-0 z-30 lg:hidden",
          "border-t border-border bg-surface/95 backdrop-blur-md",
          "pb-[env(safe-area-inset-bottom)]"
        )}
      >
        {/* Brass hairline above the rail — echoes PageHeader eyebrow */}
        <div className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-accent/45 to-transparent" />
        <div className="relative flex h-14 items-stretch">
          {leftTabs.map((tab) => (
            <BottomTab key={tab.to} tab={tab} />
          ))}

          {/* Centre — raised brass disc that opens the Menu modal. */}
          <div className="flex flex-1 items-end justify-center">
            <button
              onClick={() => setMenuOpen(true)}
              aria-expanded={menuOpen}
              aria-label="Open menu"
              className={cn(
                "relative -translate-y-3 inline-flex h-14 w-14 items-center justify-center rounded-full",
                "border-2 border-surface bg-accent text-white shadow-slab transition-transform active:scale-95",
                "before:absolute before:inset-[-3px] before:-z-10 before:rounded-full before:bg-gradient-to-br before:from-accent/60 before:to-accent-hover/60 before:opacity-70 before:blur-sm"
              )}
            >
              <Grid3x3 size={22} strokeWidth={2.4} />
            </button>
          </div>

          {rightTabs.map((tab) => (
            <BottomTab key={tab.to} tab={tab} />
          ))}
        </div>
      </nav>

      {menuOpen && <MenuModal onClose={() => setMenuOpen(false)} />}
    </>
  );
}

// ── Single tab (non-centre) ──────────────────────────────────

function BottomTab({ tab }: { tab: Tab }) {
  return (
    <NavLink
      to={tab.to}
      end={tab.end}
      className={({ isActive }) =>
        cn(
          "relative flex flex-1 flex-col items-center justify-center gap-0.5 text-ink-muted transition-colors active:bg-bg/50",
          isActive && "text-accent"
        )
      }
      aria-label={tab.label}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="pointer-events-none absolute inset-x-5 top-0 h-[2px] rounded-b-full bg-accent" />
          )}
          <tab.icon
            size={19}
            strokeWidth={isActive ? 2.4 : 2}
            className={cn("transition-transform", isActive && "scale-105")}
          />
          <span
            className={cn(
              "font-mono text-[9px] font-semibold uppercase tracking-wider",
              isActive && "text-accent"
            )}
          >
            {tab.label}
          </span>
        </>
      )}
    </NavLink>
  );
}

// ── Menu modal ────────────────────────────────────────────────
// Bottom-sheet of every nav destination not already on the rail.
// Permission-filtered. Click → navigate + close. Click backdrop / X
// to dismiss.

interface MenuItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: string;
  anyPerm?: string[];
  badge?: number;
  description?: string;
}

function MenuModal({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const notifs = useNotifications();

  const items: MenuItem[] = [
    {
      to: "/projects",
      label: "Projects",
      icon: FolderKanban,
      perm: "projects.read",
      description: "Exhibitions and events",
    },
    {
      to: "/orders",
      label: "Sales Orders",
      icon: ClipboardList,
      perm: "sales_orders.read",
    },
    {
      to: "/delivery-orders",
      label: "Delivery",
      icon: TruckIcon,
      perm: "delivery_orders.read",
    },
    {
      to: "/po",
      label: "Purchase Orders",
      icon: ClipboardList,
      perm: "purchase_orders.read",
    },
    {
      to: "/notifications",
      label: "Inbox",
      icon: Bell,
      perm: "projects.read",
      badge: notifs.totalUnread,
    },
    {
      to: "/team",
      label: "Team",
      icon: Users,
      anyPerm: ["users.read", "roles.read"],
    },
    {
      to: "/settings",
      label: "Settings",
      icon: SettingsIcon,
      perm: "settings.manage",
    },
  ];

  const visible = items.filter((it) => {
    if (it.perm && !can(it.perm)) return false;
    if (it.anyPerm && !it.anyPerm.some((p) => can(p))) return false;
    return true;
  });

  function go(to: string) {
    navigate(to);
    onClose();
  }

  const node = (
    <div className="fixed inset-0 z-50 flex flex-col justify-end lg:hidden">
      {/* Backdrop */}
      <button
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-fade-in"
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-label="Menu"
        className={cn(
          "relative mx-2 mb-2 overflow-hidden rounded-2xl border border-border bg-surface shadow-slab",
          "pb-[env(safe-area-inset-bottom)]",
          "animate-rise"
        )}
      >
        {/* Drag handle */}
        <div className="pointer-events-none flex justify-center pt-2">
          <span className="h-1 w-10 rounded-full bg-border-strong/60" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 pt-2 pb-3">
          <div>
            <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-accent">
              Menu
            </div>
            <div className="font-display text-[16px] font-extrabold text-ink">
              Where to next?
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-md border border-border bg-surface p-1.5 text-ink-muted transition-colors hover:border-accent/40 hover:text-accent"
          >
            <X size={14} />
          </button>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-2 gap-2 px-3 pb-3">
          {visible.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.to}
                onClick={() => go(it.to)}
                className={cn(
                  "group flex items-center gap-3 rounded-xl border border-border bg-bg/40 p-3 text-left transition-all",
                  "hover:border-accent/40 hover:bg-accent-soft/30 active:scale-[0.98]"
                )}
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-surface text-accent shadow-stone group-hover:bg-accent group-hover:text-white">
                  <Icon size={17} strokeWidth={2.2} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-bold text-ink">
                      {it.label}
                    </span>
                    {it.badge != null && it.badge > 0 && (
                      <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-err px-1 font-mono text-[9px] font-bold text-white">
                        {it.badge > 9 ? "9+" : it.badge}
                      </span>
                    )}
                  </div>
                  {it.description && (
                    <div className="truncate text-[10.5px] text-ink-muted">
                      {it.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
          {visible.length === 0 && (
            <div className="col-span-2 px-3 py-8 text-center text-[11px] text-ink-muted">
              No additional destinations available for your role.
            </div>
          )}
        </div>

        {/* Compliance footer with brand line */}
        <div className="flex items-center gap-2 border-t border-border bg-bg/40 px-4 py-2.5">
          <ShieldCheck size={11} className="text-accent" />
          <span className="font-mono text-[9.5px] uppercase tracking-brand text-ink-muted">
            Houzs ERP
          </span>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
