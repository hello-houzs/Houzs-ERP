import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ClipboardList,
  Truck,
  Route,
  Package,
  Zap,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  ChevronRight,
  Users,
  LogOut,
  Calendar,
  DollarSign,
  Wrench,
  FolderKanban,
  ShieldCheck,
  Trophy,
  Lightbulb,
  MessageCircle,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useAuth } from "../auth/AuthContext";
import { PresencePanel } from "./PresencePanel";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";

interface Props {
  /** Desktop-only collapsed state (lg+). */
  collapsed: boolean;
  /** Toggles the desktop collapsed state. */
  onToggle: () => void;
  /** Mobile-only drawer open state (below lg). */
  mobileOpen?: boolean;
  /** Closes the mobile drawer. Called when the backdrop is tapped. */
  onMobileClose?: () => void;
}

/**
 * Single source of truth for the app's nav tree. Used by the desktop
 * Sidebar and re-rendered as a grid in the mobile MenuModal so the
 * two never drift. Add a route here, it shows up in both places.
 */
export interface NavTab {
  /** Click target. Omit when this is a pure group header with `children`. */
  to?: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Permission key required to see/use this tab. Omit = always visible. */
  perm?: string;
  /** Show when the user has at least one of the listed permissions.
   *  Paired with `perm` it's `any` OR `perm` — rarely needed together. */
  anyPerm?: string[];
  /** If the user has this permission, the tab is hidden — used to suppress
   *  legacy entries when a richer replacement is available (e.g. hide the
   *  flat Delivery list from dispatchers who already have the Trips Queue
   *  tab). */
  hidePerm?: string;
  /** Optional sub-entries. When present, this tab renders as an
   *  expandable group header instead of a click target. */
  children?: NavTab[];
  /** Stable id used for the per-group expanded/collapsed memory. Only
   *  required when `children` is present. */
  groupId?: string;
}

/**
 * Sidebar tab registry — flat root list. Use `children` on a tab to
 * nest sub-entries under an expandable group header (see Project
 * Management). Tabs declare permission via `perm` / `anyPerm`; the
 * filter recurses so groups with no visible kids hide entirely.
 */
export const NAV_TABS: NavTab[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/orders", label: "Sales Orders", icon: ClipboardList, perm: "sales_orders.read" },
  // The rep-facing Sales log used to live here as its own tab. It was
  // moved into the Project detail page (each exhibition has its own
  // Sales section) so reps draft sales against the project they're
  // working on. The /sales route still resolves for managers who
  // bookmarked it, but it's intentionally hidden from the nav.
  // Members with delivery_orders.read but no trips.read.all still see
  // the flat Delivery list. Dispatchers with trips.read.all get the
  // richer Queue tab inside Trips, so this entry hides for them.
  {
    to: "/delivery-orders",
    label: "Delivery",
    icon: Truck,
    perm: "delivery_orders.read",
    hidePerm: "trips.read.all",
  },
  {
    to: "/logistics",
    label: "Logistics",
    icon: Route,
    anyPerm: ["trips.read.all", "fleet.read"],
  },
  { to: "/po", label: "Purchase Orders", icon: Package, perm: "purchase_orders.read" },
  {
    label: "Quality Management",
    icon: Zap,
    groupId: "quality-mgmt",
    anyPerm: ["service_cases.read"],
    children: [
      {
        to: "/assr?view=cases",
        label: "Service Cases",
        icon: ClipboardList,
        perm: "service_cases.read",
      },
      {
        to: "/assr?view=by_creditor",
        label: "By Creditor",
        icon: Package,
        perm: "service_cases.read",
      },
      {
        to: "/assr?view=metrics",
        label: "Quality Metrics",
        icon: ShieldCheck,
        perm: "service_cases.read",
      },
      {
        to: "/assr?view=pnl",
        label: "Finances",
        icon: DollarSign,
        perm: "service_cases.read",
      },
      {
        to: "/assr?view=settings",
        label: "Service Settings",
        icon: Wrench,
        perm: "service_cases.manage",
      },
    ],
  },
  {
    label: "Project Management",
    icon: FolderKanban,
    groupId: "project-mgmt",
    anyPerm: ["projects.read"],
    children: [
      {
        to: "/projects?view=list",
        label: "Project List",
        icon: ClipboardList,
        perm: "projects.read",
      },
      {
        to: "/projects?view=calendar",
        label: "Calendar",
        icon: Calendar,
        perm: "projects.read",
      },
      {
        to: "/projects?view=finances",
        label: "Finances",
        icon: DollarSign,
        perm: "projects.read",
      },
      {
        to: "/projects?view=maintenance",
        label: "Project Maintenance",
        icon: Wrench,
        perm: "projects.write",
      },
    ],
  },
  { to: "/team", label: "Team", icon: Users, anyPerm: ["users.read", "roles.read"] },
  {
    label: "Engagement",
    icon: Trophy,
    groupId: "engagement",
    children: [
      { to: "/gamification", label: "Houzs Points", icon: Trophy },
      { to: "/gamification?sub=shop", label: "Award Shop", icon: ShoppingBag },
      { to: "/innovations", label: "Innovations", icon: Lightbulb },
      { to: "/suggestions", label: "Suggestions", icon: MessageCircle },
      {
        to: "/gamification/admin",
        label: "Admin Console",
        icon: SettingsIcon,
        perm: "*",
      },
    ],
  },
  { to: "/settings", label: "Settings", icon: SettingsIcon, perm: "settings.manage" },
];

// Brand assets — drop the source files into frontend/public/. The paths
// below resolve to those files at runtime. If your files are .png instead
// of .svg, just rename them to match — these constants are the only place
// the extension is referenced.
const LOGO_MARK_SRC = "/logo-mark.png"; // 1:1 square — collapsed sidebar
const LOGO_WORDMARK_SRC = "/logo-wordmark.png"; // 1:4 horizontal — expanded sidebar

export function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }: Props) {
  const { user, can, logout } = useAuth();
  const location = useLocation();
  // On mobile the drawer is always full-width — collapsed state is
  // a desktop-only concept.
  const effectiveCollapsed = collapsed;

  // Per-group (nested) collapsed memory. Defaults open.
  const [groupExpanded, setGroupExpanded] = useLocalStorage<Record<string, boolean>>(
    "sidebar:groups:expanded",
    {}
  );
  function toggleGroup(id: string) {
    setGroupExpanded((prev) => ({ ...prev, [id]: prev[id] === false ? true : false }));
  }
  function isGroupOpen(id: string): boolean {
    return groupExpanded[id] !== false;
  }

  /** True when a tab's `to` matches the current pathname + relevant query
   *  params. NavLink doesn't compare query strings on its own, so for
   *  entries like /projects?view=calendar we have to match manually. */
  function tabIsActive(to: string, end?: boolean): boolean {
    const [path, search] = to.split("?");
    if (end ? location.pathname !== path : !location.pathname.startsWith(path)) {
      // For non-end matches, allow startsWith for nested routes (e.g.
      // /projects/123 still highlights /projects).
      if (location.pathname !== path) return false;
    }
    if (!search) return true;
    const wanted = new URLSearchParams(search);
    const have = new URLSearchParams(location.search);
    for (const [k, v] of wanted.entries()) {
      if (have.get(k) !== v) return false;
    }
    return true;
  }

  // Filter tabs the current user can't access, plus tabs explicitly
  // suppressed by hidePerm (used to remove redundant entries when a
  // richer replacement is available). Recursive — a group with no
  // visible children is itself hidden.
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

  // Recursive renderer for tabs — handles plain links and nested groups.
  function renderTab(tab: NavTab, depth = 0): React.ReactNode {
    const Icon = tab.icon;

    // Group header (has children) — render as expandable section.
    if (tab.children && tab.children.length > 0) {
      const open = isGroupOpen(tab.groupId || tab.label);
      // Group is "active" if any child is active — keep the brass tint
      // on the parent so the user knows where they are.
      const childActive = tab.children.some(
        (k) => k.to && tabIsActive(k.to, k.end)
      );
      if (collapsed) {
        // In collapsed mode, render children flat with no group header.
        return (
          <div key={tab.groupId || tab.label}>
            {tab.children.map((k) => renderTab(k, depth))}
          </div>
        );
      }
      return (
        <div key={tab.groupId || tab.label} className="my-0.5">
          <button
            onClick={() => toggleGroup(tab.groupId || tab.label)}
            className={cn(
              "group relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[12.5px] font-medium transition-all duration-150",
              childActive
                ? "text-sidebar-ink"
                : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink"
            )}
          >
            <Icon
              size={15}
              strokeWidth={childActive ? 2.4 : 2}
              className={childActive ? "text-accent" : ""}
            />
            <span className="flex-1">{tab.label}</span>
            {open ? (
              <ChevronDown size={12} className="text-sidebar-ink-muted" />
            ) : (
              <ChevronRight size={12} className="text-sidebar-ink-muted" />
            )}
          </button>
          {open && (
            <div className="ml-3 border-l border-sidebar-border pl-2">
              {tab.children.map((k) => renderTab(k, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    // Leaf — needs `to`. (filterTab + types ensure it.)
    if (!tab.to) return null;
    const to = tab.to;
    const active = tabIsActive(to, tab.end);
    return (
      <NavLink
        key={to}
        to={to}
        end={tab.end}
        // We compute active state ourselves so query strings match.
        className={() =>
          cn(
            "group relative my-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-[12.5px] font-medium transition-all duration-150",
            active
              ? "bg-sidebar-active text-accent-ink shadow-[inset_0_0_0_1px_rgba(161,106,46,0.2)]"
              : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink",
            collapsed && "mx-1 justify-center px-2"
          )
        }
      >
        {active && !collapsed && (
          <span className="absolute -left-[10px] top-2 bottom-2 w-[2px] rounded-r bg-accent" />
        )}
        <Icon
          size={15}
          strokeWidth={active ? 2.4 : 2}
          className={active ? "text-accent" : ""}
        />
        {!collapsed && <span>{tab.label}</span>}
      </NavLink>
    );
  }

  return (
    <>
      {/* Mobile backdrop — only rendered when the drawer is open. */}
      {mobileOpen && (
        <button
          onClick={onMobileClose}
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm lg:hidden animate-fade-in"
        />
      )}

      <aside
        className={cn(
          "flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-ink transition-transform duration-200",
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-50 w-[260px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop (lg+): static, takes part in flex layout, no transform.
          "lg:relative lg:translate-x-0 lg:transition-[width]",
          effectiveCollapsed ? "lg:w-16" : "lg:w-[232px]"
        )}
      >
      {/* Brass hairline along the right edge — refined separator on top of the border */}
      <div className="pointer-events-none absolute right-0 top-0 h-full w-px bg-gradient-to-b from-transparent via-accent/35 to-transparent" />

      {/* ── Brand header ────────────────────────────────────── */}
      <div
        className={cn(
          "relative flex h-20 items-center border-b border-sidebar-border",
          collapsed ? "justify-center" : "justify-between px-5"
        )}
      >
        {collapsed ? (
          // Collapsed: just the square mark
          <img
            src={LOGO_MARK_SRC}
            alt="Houzs Century"
            className="h-9 w-9 object-contain"
            draggable={false}
          />
        ) : (
          // Expanded: the horizontal wordmark fills the available width.
          // The 1:4 aspect ratio + h-10 yields a comfortable ~40×160 box.
          <img
            src={LOGO_WORDMARK_SRC}
            alt="Houzs Century"
            className="h-10 w-auto max-w-[160px] object-contain"
            draggable={false}
          />
        )}
        {!collapsed && (
          <button
            onClick={onToggle}
            className="hidden text-sidebar-ink-muted transition-colors hover:text-sidebar-ink lg:block"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        )}
        {/* Mobile drawer close button — only visible below lg */}
        {onMobileClose && (
          <button
            onClick={onMobileClose}
            className="text-sidebar-ink-muted transition-colors hover:text-sidebar-ink lg:hidden"
            aria-label="Close menu"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {!collapsed && (
        <button
          onClick={onToggle}
          className="absolute right-3 top-3 hidden text-sidebar-ink-muted hover:text-sidebar-ink"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose size={14} />
        </button>
      )}
      {collapsed && (
        <button
          onClick={onToggle}
          className="absolute right-2 top-2 hidden text-sidebar-ink-muted hover:text-sidebar-ink lg:block"
          aria-label="Expand sidebar"
        >
          <PanelLeftOpen size={14} />
        </button>
      )}

      {/* ── Global search trigger (mobile drawer only; desktop nav bar owns it) */}
      <div
        className={cn(
          "border-b border-sidebar-border lg:hidden",
          collapsed ? "px-2 py-3" : "px-3 py-3"
        )}
      >
        <GlobalSearchTrigger collapsed={collapsed} />
      </div>

      {/* ── Flat root nav ─────────────────────────────────────── */}
      <nav className="no-scrollbar flex-1 overflow-y-auto px-2 pb-4 pt-3">
        {visibleTabs.map((tab) => renderTab(tab))}
      </nav>

      {/* ── Notification bell (mobile drawer only; desktop nav bar owns it) */}
      {user && (
        <div
          className={cn(
            "border-t border-sidebar-border lg:hidden",
            collapsed ? "flex justify-center px-2 py-2" : "px-2 py-2"
          )}
        >
          <NotificationBell collapsed={collapsed} direction="up" align="start" />
        </div>
      )}

      {/* ── Active members (mobile drawer only; desktop nav bar owns it) */}
      {user && (
        <div className="lg:hidden">
          <PresencePanel collapsed={collapsed} />
        </div>
      )}

      {/* ── User identity + sign out (mobile drawer only; desktop nav bar owns the avatar) */}
      {user && (
        <div className="border-t border-sidebar-border lg:hidden">
          {collapsed ? (
            <NavLink
              to="/profile"
              className="flex h-12 w-full items-center justify-center text-sidebar-ink-muted transition-colors hover:bg-sidebar-hover hover:text-accent"
              aria-label="Profile"
              title={`${user.name || user.email} · Profile`}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-sidebar-active text-[9px] font-bold uppercase text-accent-ink">
                {(user.name || user.email).slice(0, 2).toUpperCase()}
              </span>
            </NavLink>
          ) : (
            <div className="flex items-center gap-2.5 px-5 py-3.5">
              <NavLink
                to="/profile"
                className="group flex min-w-0 flex-1 items-center gap-2.5"
                title="Open profile"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-active text-[10px] font-bold uppercase text-accent-ink shadow-[inset_0_0_0_1px_rgba(161,106,46,0.25)] group-hover:bg-accent group-hover:text-white">
                  {(user.name || user.email).slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-sidebar-ink group-hover:text-accent">
                    {user.name || user.email.split("@")[0]}
                  </div>
                  <div className="truncate text-[10px] text-sidebar-ink-muted">
                    {user.role_name}
                  </div>
                </div>
              </NavLink>
              <button
                onClick={() => logout()}
                className="rounded p-1.5 text-sidebar-ink-muted transition-colors hover:bg-sidebar-hover hover:text-accent"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut size={14} />
              </button>
            </div>
          )}
        </div>
      )}
      </aside>
    </>
  );
}
