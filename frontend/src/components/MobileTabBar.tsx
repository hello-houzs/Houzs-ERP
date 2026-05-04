import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import {
  LayoutDashboard,
  Trophy,
  Grid3x3,
  X,
  ShieldCheck,
  Bell,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import { NAV_TABS, type NavTab } from "./Sidebar";
import { Avatar } from "./Avatar";
import { cn } from "../lib/utils";

/**
 * Mobile bottom navigation. Hidden on lg+. Five slots:
 *
 *   [ Home ] [ Points ] [ Menu* ] [ Inbox ] [ Profile ]
 *
 * The four side tabs are universal — accessible to every role — so the
 * rail never collapses to two slots for a restricted user. Anything
 * gated lives behind the centre Menu disc.
 *
 * The middle "Menu" tab is a raised brass circle that protrudes above
 * the rail and opens a bottom-sheet modal with every other
 * destination. Distinct visual so it reads as the "all-things"
 * affordance, not just another tab.
 *
 * The Profile tab renders the user's avatar instead of an icon so they
 * see themselves in the rail.
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
  const { user } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!user) return null;
  if (location.pathname.startsWith("/driver")) return null;

  const leftTabs: Tab[] = [
    { to: "/", label: "Home", icon: LayoutDashboard, end: true },
    { to: "/gamification", label: "Points", icon: Trophy },
  ];
  const rightTabs: Tab[] = [
    { to: "/notifications", label: "Inbox", icon: Bell },
    { to: "/profile", label: "Profile", icon: LayoutDashboard /* unused — Profile renders avatar */ },
  ];

  return (
    <>
      <nav
        aria-label="Mobile navigation"
        className={cn(
          "fixed left-3 right-3 z-30 lg:hidden",
          // Float the rail above the canvas with a small inset and shadow,
          // sitting just above iOS safe-area instead of sticking to the
          // device edge. Reads as a pill, matches the floating-FAB visual
          // language used elsewhere in the app.
          "bottom-[calc(env(safe-area-inset-bottom)+0.5rem)]",
          "rounded-2xl border border-border bg-surface/95 backdrop-blur-md shadow-slab"
        )}
      >
        <div className="relative flex h-14 items-stretch">
          {leftTabs.map((tab) => (
            <BottomTab key={tab.to} tab={tab} />
          ))}

          {/* Centre — raised brass disc that opens the Menu modal.
              48 px disc (h-12 w-12) protrudes 8 px above the floating
              pill — leaves room for the active-tab indicator on
              neighbours and avoids cramping at 320 px portrait. */}
          <div className="flex flex-1 items-end justify-center">
            <button
              onClick={() => setMenuOpen(true)}
              aria-expanded={menuOpen}
              aria-label="Open menu"
              className={cn(
                "relative -translate-y-2 inline-flex h-12 w-12 items-center justify-center rounded-full",
                "border-2 border-surface bg-accent text-white shadow-slab transition-transform active:scale-95",
                "before:absolute before:inset-[-3px] before:-z-10 before:rounded-full before:bg-gradient-to-br before:from-accent/60 before:to-accent-hover/60 before:opacity-70 before:blur-sm"
              )}
            >
              <Grid3x3 size={20} strokeWidth={2.4} />
            </button>
          </div>

          {rightTabs.map((tab) =>
            tab.to === "/profile" ? (
              <ProfileTab key={tab.to} />
            ) : (
              <BottomTab key={tab.to} tab={tab} />
            ),
          )}
        </div>
      </nav>

      {menuOpen && <MenuModal onClose={() => setMenuOpen(false)} />}
    </>
  );
}

// ── Profile tab — renders the user's avatar in place of an icon ────

function ProfileTab() {
  const { user } = useAuth();
  return (
    <NavLink
      to="/profile"
      className={({ isActive }) =>
        cn(
          "relative flex flex-1 flex-col items-center justify-center gap-0.5 px-1 text-ink-muted transition-colors active:bg-bg/50",
          isActive && "text-accent",
        )
      }
      aria-label="Profile"
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="pointer-events-none absolute inset-x-5 top-0 h-[2px] rounded-b-full bg-accent" />
          )}
          <Avatar
            userId={user?.id ?? null}
            hasImage={user?.profile_pic_r2_key}
            name={user?.name}
            email={user?.email}
            size={22}
            ring={isActive}
          />
          <span
            className={cn(
              "font-mono text-[10.5px] font-semibold uppercase tracking-wider",
              isActive && "text-accent",
            )}
          >
            Profile
          </span>
        </>
      )}
    </NavLink>
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
          "relative flex flex-1 flex-col items-center justify-center gap-0.5 px-1 text-ink-muted transition-colors active:bg-bg/50",
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
              "font-mono text-[10.5px] font-semibold uppercase tracking-wider",
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
// Bottom-sheet that mirrors the desktop Sidebar's full nav tree.
// Both render from the same NAV_TABS registry so they never drift —
// add a route in Sidebar.tsx and it appears here automatically.
// Permission-filtered. Click → navigate + close. Backdrop / X to
// dismiss.

function MenuModal({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const notifs = useNotifications();

  // Recursive permission filter — same shape as Sidebar.tsx's so the
  // two stay in lockstep.
  function filterTab(t: NavTab): NavTab | null {
    if (t.perm && !can(t.perm)) return null;
    if (t.anyPerm && !t.anyPerm.some((p) => can(p))) return null;
    if (t.hidePerm && can(t.hidePerm)) return null;
    if (t.children) {
      const kids = t.children
        .map(filterTab)
        .filter((x): x is NavTab => x !== null);
      if (kids.length === 0) return null;
      return { ...t, children: kids };
    }
    return t;
  }

  const visibleTabs = NAV_TABS.map(filterTab).filter(
    (t): t is NavTab => t !== null,
  );

  function go(to: string) {
    navigate(to);
    onClose();
  }

  function renderCard(t: NavTab, badge?: number) {
    if (!t.to) return null;
    const Icon = t.icon;
    return (
      <button
        key={t.to}
        onClick={() => go(t.to!)}
        className={cn(
          "group flex items-center gap-3 rounded-xl border border-border bg-bg/40 p-3 text-left transition-all",
          "hover:border-accent/40 hover:bg-accent-soft/30 active:scale-[0.98]",
        )}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-surface text-accent shadow-stone group-hover:bg-accent group-hover:text-white">
          <Icon size={17} strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-bold text-ink">
              {t.label}
            </span>
            {badge != null && badge > 0 && (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-err px-1 font-mono text-[9px] font-bold text-white">
                {badge > 9 ? "9+" : badge}
              </span>
            )}
          </div>
        </div>
      </button>
    );
  }

  function renderGroupHeader(label: string, Icon: LucideIcon) {
    return (
      <div className="col-span-2 mt-1 flex items-center gap-2 px-1 pt-2">
        <Icon size={11} className="text-accent" />
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-accent">
          {label}
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-accent/30 to-transparent" />
      </div>
    );
  }

  // Inbox is a fixed extra entry — surfaces unread notifications with
  // a live badge. Not in NAV_TABS because the sidebar exposes the bell
  // via NotificationBell instead. Skip when projects.read is denied
  // (same gate as before).
  const showInbox = can("projects.read");

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
          "relative mx-2 mb-2 max-h-[85vh] overflow-hidden rounded-2xl border border-border bg-surface shadow-slab",
          "pb-[env(safe-area-inset-bottom)]",
          "animate-rise flex flex-col",
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
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-muted transition-colors hover:border-accent/40 hover:text-accent"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable grid — taller nav trees overflow inside the sheet
            so the sheet itself never grows past 85vh. */}
        <div className="thin-scroll grid grid-cols-2 gap-2 overflow-y-auto px-3 pb-3">
          {showInbox &&
            renderCard(
              {
                to: "/notifications",
                label: "Inbox",
                icon: Bell,
              },
              notifs.totalUnread,
            )}

          {visibleTabs.map((t) => {
            // Group: spans the full row with a section header, then
            // its leaf children render as cards beneath.
            if (t.children && t.children.length > 0) {
              return (
                <div
                  key={t.groupId || t.label}
                  className="col-span-2 contents"
                >
                  {renderGroupHeader(t.label, t.icon)}
                  {t.children.map((k) => renderCard(k))}
                </div>
              );
            }
            // Leaf — single card.
            return renderCard(t);
          })}

          {visibleTabs.length === 0 && !showInbox && (
            <div className="col-span-2 px-3 py-8 text-center text-[11px] text-ink-muted">
              No destinations available for your role.
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
