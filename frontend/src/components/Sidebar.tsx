import { NavLink, useLocation } from "react-router-dom";
import {
  ClipboardList,
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
  Activity,
  Boxes,
  Truck,
  PackageCheck,
  ReceiptText,
  Undo2,
  Warehouse,
  ArrowLeftRight,
  ClipboardCheck,
  ShoppingCart,
  Send,
  RotateCcw,
  Sofa,
  Layers,
  Calculator,
  Scissors,
  BookOpen,
  AlertCircle,
  Handshake,
  FileText,
  CornerUpLeft,
  HandCoins,
  PackageOpen,
  Reply,
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
  /** Page-access key required (default minLevel: partial). Use for tabs
   *  whose visibility should follow the new per-page matrix instead of
   *  legacy permission keys. */
  pageAccess?: string;
  /** Same as `pageAccess` but requires `full` access — for admin-only
   *  tabs (e.g. Project Maintenance). */
  pageAccessFull?: string;
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
  // ── Service — quality + ASSR ─────────────────────────────────
  {
    label: "Service",
    icon: Zap,
    groupId: "service",
    anyPerm: ["service_cases.read"],
    children: [
      {
        to: "/assr?view=cases",
        label: "Service Cases",
        icon: ClipboardList,
        perm: "service_cases.read",
        pageAccess: "service_cases.cases",
      },
      {
        to: "/assr?view=by_creditor",
        label: "By Creditor",
        icon: Package,
        perm: "service_cases.read",
        pageAccess: "service_cases.by_creditor",
      },
      {
        to: "/assr?view=metrics",
        label: "Quality Metrics",
        icon: ShieldCheck,
        perm: "service_cases.read",
        pageAccess: "service_cases.metrics",
      },
      {
        to: "/assr?view=pnl",
        label: "Finances",
        icon: DollarSign,
        perm: "service_cases.read",
        pageAccess: "service_cases.pnl",
      },
      {
        // Lead Time Portal merged into Service Maintenance as a tab.
        // Sidebar entry removed; reach it via Service Maintenance →
        // Lead Time tab. Old /assr?view=lead_time URL still works
        // (redirects in ServiceCases.tsx).
        to: "/assr?view=settings",
        label: "Service Maintenance",
        icon: Wrench,
        perm: "service_cases.manage",
      },
    ],
  },

  // ── Projects — exhibitions, solo events ──────────────────────
  // Gated on page-access (mig 073). Each sub-tab uses `pageAccess`
  // so a role with calendar-only access only sees the Calendar entry.
  {
    label: "Projects",
    icon: FolderKanban,
    groupId: "projects",
    pageAccess: "projects",
    children: [
      {
        to: "/projects?view=list",
        label: "Project List",
        icon: ClipboardList,
        pageAccess: "projects.list",
      },
      {
        to: "/projects?view=calendar",
        label: "Calendar",
        icon: Calendar,
        pageAccess: "projects.calendar",
      },
      {
        to: "/projects?view=finances",
        label: "Finances",
        icon: DollarSign,
        pageAccess: "projects.finances",
      },
      {
        to: "/projects?view=maintenance",
        label: "Project Maintenance",
        icon: Wrench,
        pageAccessFull: "projects.maintenance",
      },
    ],
  },

  // ── Supply Chain — ported 2990's furniture SCM (/api/scm) ────
  // Owner-gated (perm "*") while the port is in progress; the server gates
  // /api/scm/* with requirePermission("*"). New SCM modules get added here as
  // they're ported.
  {
    label: "Supply Chain",
    icon: Boxes,
    groupId: "scm",
    anyPerm: ["*"],
    children: [
      // Organised into sections (mirrors 2990's Procurement / Warehouse / etc.
      // sectioning) instead of one flat 26-item list. Sub-groups default open
      // (so every item still shows) but each is collapsible per-user.
      {
        label: "Procurement",
        icon: Package,
        groupId: "scm-procurement",
        anyPerm: ["*"],
        children: [
          { to: "/scm/suppliers", label: "Suppliers", icon: Truck, perm: "*" },
          { to: "/scm/purchase-orders", label: "Purchase Orders", icon: ClipboardList, perm: "*" },
          { to: "/scm/grns", label: "Goods Receipt", icon: PackageCheck, perm: "*" },
          { to: "/scm/purchase-invoices", label: "Purchase Invoices", icon: ReceiptText, perm: "*" },
          { to: "/scm/purchase-returns", label: "Purchase Returns", icon: Undo2, perm: "*" },
        ],
      },
      {
        label: "Inventory",
        icon: Warehouse,
        groupId: "scm-inventory",
        anyPerm: ["*"],
        children: [
          { to: "/scm/inventory", label: "Inventory", icon: Package, perm: "*" },
          { to: "/scm/warehouses", label: "Warehouses", icon: Warehouse, perm: "*" },
          { to: "/scm/stock-transfers", label: "Stock Transfers", icon: ArrowLeftRight, perm: "*" },
          { to: "/scm/stock-takes", label: "Stock Takes", icon: ClipboardCheck, perm: "*" },
        ],
      },
      {
        label: "Sales & Delivery",
        icon: ShoppingCart,
        groupId: "scm-sales",
        anyPerm: ["*"],
        children: [
          { to: "/scm/sales-orders", label: "Sales Orders", icon: ShoppingCart, perm: "*" },
          { to: "/scm/delivery-orders", label: "Delivery Orders", icon: Send, perm: "*" },
          { to: "/scm/delivery-returns", label: "Delivery Returns", icon: RotateCcw, perm: "*" },
        ],
      },
      {
        label: "Consignment",
        icon: Handshake,
        groupId: "scm-consignment",
        anyPerm: ["*"],
        children: [
          { to: "/scm/consignment-orders", label: "Consignment Orders", icon: Handshake, perm: "*" },
          { to: "/scm/consignment-notes", label: "Consignment Notes", icon: FileText, perm: "*" },
          { to: "/scm/consignment-returns", label: "Consignment Returns", icon: CornerUpLeft, perm: "*" },
          { to: "/scm/purchase-consignment-orders", label: "Purch. Consign. Orders", icon: HandCoins, perm: "*" },
          { to: "/scm/purchase-consignment-receives", label: "Purch. Consign. Receives", icon: PackageOpen, perm: "*" },
          { to: "/scm/purchase-consignment-returns", label: "Purch. Consign. Returns", icon: Reply, perm: "*" },
        ],
      },
      {
        label: "Catalog & Planning",
        icon: Layers,
        groupId: "scm-catalog",
        anyPerm: ["*"],
        children: [
          { to: "/scm/products", label: "Products", icon: Sofa, perm: "*" },
          { to: "/scm/product-models", label: "Product Models", icon: Layers, perm: "*" },
          { to: "/scm/fabric-tracking", label: "Fabric Tracking", icon: Scissors, perm: "*" },
          { to: "/scm/mrp", label: "MRP · Stock Status", icon: Calculator, perm: "*" },
          // Lead Times has no standalone vendored page — the capability moved into
          // the vendored MRP page's "Lead Times" dialog. Nav item removed in the
          // 2990-vendoring cutover; reach it via MRP · Stock Status → Lead Times.
        ],
      },
      {
        label: "Finance",
        icon: BookOpen,
        groupId: "scm-finance",
        anyPerm: ["*"],
        children: [
          { to: "/scm/accounting", label: "Accounting", icon: BookOpen, perm: "*" },
          { to: "/scm/outstanding", label: "Outstanding", icon: AlertCircle, perm: "*" },
        ],
      },
      { to: "/scm/maintenance", label: "Maintenance", icon: Wrench, perm: "*" },
    ],
  },

  // ── People — system health + user management ─────────────────
  {
    label: "People",
    icon: Users,
    groupId: "people",
    anyPerm: ["users.read", "roles.read"],
    children: [
      { to: "/system-health", label: "System Health", icon: Activity, perm: "*" },
      { to: "/team", label: "User Management", icon: Users, anyPerm: ["users.read", "roles.read"], pageAccess: "team" },
    ],
  },

  // ── System — pinned to the bottom ───────────────────────────
  { to: "/settings", label: "Settings", icon: SettingsIcon, perm: "settings.manage" },
];

// Brand assets — drop the source files into frontend/public/. The paths
// below resolve to those files at runtime. If your files are .png instead
// of .svg, just rename them to match — these constants are the only place
// the extension is referenced.
const LOGO_MARK_SRC = "/logo-mark.png"; // 1:1 square — collapsed sidebar
const LOGO_WORDMARK_SRC = "/logo-wordmark.png"; // 1:4 horizontal — expanded sidebar

export function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }: Props) {
  const { user, can, pageAccess, logout } = useAuth();
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
    // Page-access (mig 073) — `pageAccess` requires ≥ partial; the
    // -Full variant requires "full". Wildcard short-circuits to full
    // inside `pageAccess(...)`.
    if (t.pageAccess && pageAccess(t.pageAccess) === "none") return null;
    if (t.pageAccessFull && pageAccess(t.pageAccessFull) !== "full") return null;
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
      // Recurse so a group (incl. the Supply Chain umbrella whose direct
      // children are sub-groups) stays tinted when any descendant is active.
      const hasActiveDescendant = (n: NavTab): boolean =>
        (n.to ? tabIsActive(n.to, n.end) : false) ||
        (n.children?.some(hasActiveDescendant) ?? false);
      const childActive = tab.children.some(hasActiveDescendant);
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
          {/* Group header. Click toggles only on lg+; on mobile the
              chevron is hidden and children are always visible below. */}
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
              <ChevronDown size={12} className="hidden text-sidebar-ink-muted lg:inline" />
            ) : (
              <ChevronRight size={12} className="hidden text-sidebar-ink-muted lg:inline" />
            )}
          </button>
          {/* Children: always visible on mobile (no per-group expand);
              on lg+ they obey the localStorage-backed `open` flag. */}
          <div
            className={cn(
              "ml-3 border-l border-sidebar-border pl-2",
              !open && "lg:hidden",
            )}
          >
            {tab.children.map((k) => renderTab(k, depth + 1))}
          </div>
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
          // Mobile: fixed drawer that slides in from the left. Width is
          // 88vw with a 280 px ceiling so a 320 px device retains a
          // ~38 px tap-out gutter. On `lg+` the explicit w-* below
          // overrides this entirely.
          "fixed inset-y-0 left-0 z-50 w-[88vw] max-w-[280px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop (lg+): static, takes part in flex layout, no transform.
          "lg:relative lg:max-w-none lg:translate-x-0 lg:transition-[width]",
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
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-sidebar-ink-muted transition-colors hover:text-sidebar-ink lg:hidden"
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
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-sidebar-ink-muted transition-colors hover:bg-sidebar-hover hover:text-accent"
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
