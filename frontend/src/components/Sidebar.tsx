import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  ClipboardList,
  Truck,
  Route,
  Package,
  Zap,
  CircleDollarSign,
  Clock,
  ScrollText,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Building2,
  ChevronDown,
  Users,
  Shield,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useAuth } from "../auth/AuthContext";
import { PresencePanel } from "./PresencePanel";

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

interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Permission key required to see/use this tab. Omit = always visible. */
  perm?: string;
  /** If the user has this permission, the tab is hidden — used to suppress
   *  legacy entries when a richer replacement is available (e.g. hide the
   *  flat Delivery list from dispatchers who already have the Trips Queue
   *  tab). */
  hidePerm?: string;
}

interface Workspace {
  id: string;
  label: string;
  /** A short uppercase code shown in collapsed mode and as a section badge. */
  code: string;
  icon: LucideIcon;
  tabs: Tab[];
}

/**
 * Workspace registry. Each entry is a sibling group of tabs under the
 * sidebar's two-tier hierarchy. Add a new company by appending another
 * Workspace here — the sidebar will render it as a separate collapsible
 * section automatically.
 *
 * Tabs declare their required permission via `perm`. The sidebar filters
 * them based on the current user's permissions, so members with limited
 * roles only see what they can actually use.
 */
const WORKSPACES: Workspace[] = [
  {
    id: "houzs",
    label: "Houzs Workspace",
    code: "HC",
    icon: Building2,
    tabs: [
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/orders", label: "Sales Orders", icon: ClipboardList, perm: "sales_orders.read" },
      // Members with delivery_orders.read but no trips.read.all still
      // see the flat Delivery list. Dispatchers with trips.read.all
      // get the richer Queue tab inside Trips, so this entry hides
      // for them to avoid the duplicate-page confusion.
      {
        to: "/delivery-orders",
        label: "Delivery",
        icon: Truck,
        perm: "delivery_orders.read",
        hidePerm: "trips.read.all",
      },
      { to: "/trips", label: "Trips", icon: Route, perm: "trips.read.all" },
      { to: "/po", label: "Purchase Orders", icon: Package, perm: "purchase_orders.read" },
      { to: "/assr", label: "Service", icon: Zap, perm: "service_cases.read" },
      { to: "/balance", label: "Balance", icon: CircleDollarSign, perm: "balance.read" },
      { to: "/overdue", label: "Overdue", icon: Clock, perm: "overdue.read" },
      { to: "/logs", label: "Activity Log", icon: ScrollText, perm: "logs.read" },
    ],
  },
  {
    id: "admin",
    label: "Administration",
    code: "AD",
    icon: Shield,
    tabs: [
      { to: "/team", label: "Team", icon: Users, perm: "users.read" },
      { to: "/roles", label: "Roles", icon: Shield, perm: "roles.read" },
      { to: "/settings", label: "Settings", icon: SettingsIcon, perm: "settings.manage" },
    ],
  },
];

// Brand assets — drop the source files into frontend/public/. The paths
// below resolve to those files at runtime. If your files are .png instead
// of .svg, just rename them to match — these constants are the only place
// the extension is referenced.
const LOGO_MARK_SRC = "/logo-mark.png"; // 1:1 square — collapsed sidebar
const LOGO_WORDMARK_SRC = "/logo-wordmark.png"; // 1:4 horizontal — expanded sidebar

export function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }: Props) {
  const { user, can, logout } = useAuth();
  // On mobile the drawer is always full-width — collapsed state is
  // a desktop-only concept.
  const effectiveCollapsed = collapsed;

  // Track which workspaces are expanded. Default: every workspace open.
  const defaultExpanded: Record<string, boolean> = Object.fromEntries(
    WORKSPACES.map((w) => [w.id, true])
  );
  const [expanded, setExpanded] = useLocalStorage<Record<string, boolean>>(
    "sidebar:workspaces:expanded",
    defaultExpanded
  );

  function toggleWorkspace(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  // Filter tabs the current user can't access, plus tabs explicitly
  // suppressed by hidePerm (used to remove redundant entries when a
  // richer replacement is available). Whole workspaces with no visible
  // tabs collapse out of the sidebar entirely.
  const visibleWorkspaces = WORKSPACES.map((ws) => ({
    ...ws,
    tabs: ws.tabs.filter((t) => {
      if (t.perm && !can(t.perm)) return false;
      if (t.hidePerm && can(t.hidePerm)) return false;
      return true;
    }),
  })).filter((ws) => ws.tabs.length > 0);

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

      {/* ── Section label ────────────────────────────────────── */}
      {!collapsed && (
        <div className="flex items-center justify-between px-5 pb-2 pt-5">
          <span className="text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
            Workspaces
          </span>
          <span className="font-mono text-[10px] text-sidebar-ink-muted">
            {visibleWorkspaces.length}
          </span>
        </div>
      )}

      {/* ── Two-tier workspace nav ─────────────────────────── */}
      <nav className="no-scrollbar flex-1 overflow-y-auto px-2 pb-4">
        {visibleWorkspaces.map((ws) => {
          const isExpanded = expanded[ws.id] ?? true;
          const WsIcon = ws.icon;
          return (
            <div key={ws.id} className="mb-2">
              {/* Workspace header — clickable, collapses children */}
              {collapsed ? (
                // Collapsed sidebar: show the workspace icon as a divider,
                // then render the tabs flat below it.
                <div
                  className="mx-auto mb-1 mt-2 flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-active text-accent-ink"
                  title={ws.label}
                >
                  <WsIcon size={14} strokeWidth={2.2} />
                </div>
              ) : (
                <button
                  onClick={() => toggleWorkspace(ws.id)}
                  className="group flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-sidebar-hover"
                  aria-expanded={isExpanded}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sidebar-active text-accent-ink shadow-[inset_0_0_0_1px_rgba(161,106,46,0.2)]">
                    <WsIcon size={13} strokeWidth={2.4} />
                  </span>
                  <span className="flex-1 truncate text-[13px] font-bold text-sidebar-ink">
                    {ws.label}
                  </span>
                  <span className="rounded bg-sidebar-active px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider text-accent-ink">
                    {ws.code}
                  </span>
                  <ChevronDown
                    size={14}
                    className={cn(
                      "text-sidebar-ink-muted transition-transform duration-200",
                      isExpanded ? "rotate-0" : "-rotate-90"
                    )}
                  />
                </button>
              )}

              {/* Workspace tabs — second tier */}
              {(isExpanded || collapsed) && (
                <div
                  className={cn(
                    "mt-1",
                    !collapsed && "ml-3 border-l border-sidebar-border pl-2"
                  )}
                >
                  {ws.tabs.map(({ to, label, icon: Icon, end }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      className={({ isActive }) =>
                        cn(
                          "group relative my-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-[12.5px] font-medium transition-all duration-150",
                          isActive
                            ? "bg-sidebar-active text-accent-ink shadow-[inset_0_0_0_1px_rgba(161,106,46,0.2)]"
                            : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink",
                          collapsed && "mx-1 justify-center px-2"
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && !collapsed && (
                            <span className="absolute -left-[10px] top-2 bottom-2 w-[2px] rounded-r bg-accent" />
                          )}
                          <Icon
                            size={15}
                            strokeWidth={isActive ? 2.4 : 2}
                            className={isActive ? "text-accent" : ""}
                          />
                          {!collapsed && <span>{label}</span>}
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}

      </nav>

      {/* ── Active members (presence) ───────────────────────── */}
      {user && <PresencePanel collapsed={collapsed} />}

      {/* ── User identity + sign out ────────────────────────── */}
      {user && (
        <div className="border-t border-sidebar-border">
          {collapsed ? (
            <button
              onClick={() => logout()}
              className="flex h-12 w-full items-center justify-center text-sidebar-ink-muted transition-colors hover:bg-sidebar-hover hover:text-accent"
              aria-label="Sign out"
              title={`${user.name || user.email} · Sign out`}
            >
              <LogOut size={14} />
            </button>
          ) : (
            <div className="flex items-center gap-2.5 px-5 py-3.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-active text-[10px] font-bold uppercase text-accent-ink shadow-[inset_0_0_0_1px_rgba(161,106,46,0.25)]">
                {(user.name || user.email).slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-sidebar-ink">
                  {user.name || user.email.split("@")[0]}
                </div>
                <div className="truncate text-[10px] text-sidebar-ink-muted">
                  {user.role_name}
                </div>
              </div>
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
