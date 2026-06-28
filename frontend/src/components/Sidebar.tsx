import { NavLink, useLocation } from "react-router-dom";
import {
  ClipboardList,
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
  Package,
  Truck,
  PackageCheck,
  ReceiptText,
  Undo2,
  Warehouse,
  ArrowLeftRight,
  SlidersHorizontal,
  ClipboardCheck,
  ShoppingCart,
  Send,
  RotateCcw,
  Sofa,
  Calculator,
  BookOpen,
  AlertCircle,
  Handshake,
  FileText,
  CornerUpLeft,
  HandCoins,
  PackageOpen,
  Reply,
  Mail,
  Network,
  Building2,
  LayoutDashboard,
  BarChart3,
  Map,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useAuth } from "../auth/AuthContext";
import { useBranding } from "../hooks/useBranding";
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
  /** Which sidebar section this TOP-LEVEL item sits in — drives the
   *  Workspace / Operations / System grouping. Defaults to "operations". */
  section?: "workspace" | "operations" | "system";
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
  /** ADDITIVE page-access OR-gate. Show when ANY listed page-access key
   *  resolves to !== 'none'. When combined with `anyPerm` on the same tab,
   *  the tab is shown if EITHER the permission OR a page-access key passes
   *  (OR semantics — used for the SCM nav so a position granted just one
   *  SCM area sees it without holding the broad `scm.access` permission).
   *  Wildcard `*` short-circuits inside `pageAccess(...)` to 'full'. */
  anyAccess?: string[];
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
  // ══ WORKSPACE ════════════════════════════════════════════════
  {
    section: "workspace",
    to: "/",
    label: "Overview",
    icon: LayoutDashboard,
    end: true,
  },
  // Sales Orders promoted to a top-level shortcut (also reachable under
  // Supply Chain → Sales Order).
  {
    section: "workspace",
    to: "/scm/sales-orders",
    label: "Sales Orders",
    icon: ShoppingCart,
    anyPerm: ["*", "scm.access"],
    anyAccess: ["scm.sales.orders"],
  },

  // ══ OPERATIONS ═══════════════════════════════════════════════
  // ── Service — quality + ASSR. Header links to the Cases page; the
  // chevron still expands the sub-menu (Quality Metrics / Maintenance).
  {
    section: "operations",
    label: "Service Cases",
    icon: Zap,
    groupId: "service",
    to: "/assr?view=hub",
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
        to: "/assr?view=metrics",
        label: "Quality Metrics",
        icon: ShieldCheck,
        perm: "service_cases.read",
        pageAccess: "service_cases.metrics",
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
    section: "operations",
    label: "Projects",
    icon: FolderKanban,
    groupId: "projects",
    to: "/projects?view=hub",
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
  // Header links to the /scm Hub; chevron expands the inline subtree.
  {
    section: "operations",
    label: "Supply Chain",
    icon: Boxes,
    groupId: "scm",
    // Points at the Hub landing page instead of expanding inline (the Hub
    // surfaces every module one click deep). The children stay here as the
    // single source of truth the Hub renders from + for visibility filtering.
    to: "/scm",
    anyPerm: ["*", "scm.access"],
    // Umbrella shows if ANY SCM area is granted per-position (additive). The
    // recursive filter also hides this group when no child survives, so this
    // list is belt-and-suspenders with the children's own anyAccess keys.
    anyAccess: [
      "scm",
      "scm.sales",
      "scm.procurement",
      "scm.consignment",
      "scm.transportation",
      "scm.warehouse",
      "scm.finance",
    ],
    children: [
      // 1:1 with 2990's backend Sidebar sectioning + order: Sales Order ->
      // Consignment -> Procurement -> Transportation -> Warehouse (then Finance,
      // which 2990 keeps top-level; Houzs nests it under Supply Chain). MRP +
      // Products & Maintenance live under Procurement exactly as in 2990.
      // Product Models + Fabric Tracking are tabs-in-Products in 2990 → NOT
      // separate nav items here either (reach them via Products & Maintenance /
      // their /scm/* routes). Consignment labels match 2990 verbatim: singular
      // "Consignment Order/Note/Return" + full "Purchase Consignment ...".
      // Each leaf carries its own L2 page-access key (additive — still ORed
      // with ["*","scm.access"]). The GROUP header keeps its L1 key AND lists
      // every child L2 key in `anyAccess`, so granting either the L1 area or
      // any single L2 child shows the group; the recursive filter then hides
      // any leaf whose own L2 key resolves to "none". Result: set scm.sales =
      // full → all four sales leaves show (inherit); override scm.sales.delivery
      // = none → just Delivery Orders disappears while the rest stay.
      {
        label: "Sales Order",
        icon: ShoppingCart,
        groupId: "scm-sales",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.sales", "scm.sales.orders", "scm.sales.delivery", "scm.sales.invoices", "scm.sales.returns"],
        children: [
          { to: "/scm/sales-orders", label: "Sales Orders", icon: ShoppingCart, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.orders"] },
          { to: "/scm/delivery-orders", label: "Delivery Orders", icon: Send, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.delivery"] },
          { to: "/scm/sales-invoices", label: "Sales Invoices", icon: FileText, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.invoices"] },
          { to: "/scm/delivery-returns", label: "Delivery Returns", icon: RotateCcw, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.returns"] },
        ],
      },
      {
        label: "Consignment",
        icon: Handshake,
        groupId: "scm-consignment",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.consignment", "scm.consignment.orders", "scm.consignment.notes", "scm.consignment.returns", "scm.consignment.po_orders", "scm.consignment.po_receives", "scm.consignment.po_returns"],
        children: [
          { to: "/scm/consignment-orders", label: "Consignment Order", icon: Handshake, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.orders"] },
          { to: "/scm/consignment-notes", label: "Consignment Note", icon: FileText, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.notes"] },
          { to: "/scm/consignment-returns", label: "Consignment Return", icon: CornerUpLeft, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.returns"] },
          { to: "/scm/purchase-consignment-orders", label: "Purchase Consignment Order", icon: HandCoins, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.po_orders"] },
          { to: "/scm/purchase-consignment-receives", label: "Purchase Consignment Receive", icon: PackageOpen, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.po_receives"] },
          { to: "/scm/purchase-consignment-returns", label: "Purchase Consignment Return", icon: Reply, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.po_returns"] },
        ],
      },
      {
        label: "Procurement",
        icon: Package,
        groupId: "scm-procurement",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.procurement", "scm.procurement.products", "scm.procurement.suppliers", "scm.procurement.mrp", "scm.procurement.po", "scm.procurement.grn", "scm.procurement.pi", "scm.procurement.pr"],
        children: [
          { to: "/scm/products", label: "Products & Maintenance", icon: Sofa, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.products"] },
          { to: "/scm/suppliers", label: "Suppliers", icon: Truck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.suppliers"] },
          { to: "/scm/mrp", label: "MRP · Stock Status", icon: Calculator, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.mrp"] },
          { to: "/scm/purchase-orders", label: "Purchase Orders", icon: ClipboardList, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.po"] },
          { to: "/scm/grns", label: "Goods Receipt", icon: PackageCheck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.grn"] },
          { to: "/scm/purchase-invoices", label: "Purchase Invoices", icon: ReceiptText, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.pi"] },
          { to: "/scm/purchase-returns", label: "Purchase Returns", icon: Undo2, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.pr"] },
        ],
      },
      {
        label: "Transportation",
        icon: Truck,
        groupId: "scm-transportation",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.transportation", "scm.transportation.drivers"],
        children: [
          { to: "/scm/delivery-planning", label: "Delivery Planning", icon: Send, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"] },
          { to: "/scm/fleet", label: "Fleet", icon: Truck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"] },
          { to: "/scm/lorry-capacity", label: "Lorry Capacity", icon: BarChart3, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"] },
          { to: "/scm/drivers", label: "Drivers", icon: Truck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"] },
          { to: "/scm/delivery-planning-regions", label: "Regions", icon: Map, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"] },
        ],
      },
      {
        label: "Warehouse",
        icon: Warehouse,
        groupId: "scm-warehouse",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.warehouse", "scm.warehouse.inventory", "scm.warehouse.adjustments", "scm.warehouse.transfers", "scm.warehouse.stock_take"],
        children: [
          // Warehouses master sits at the TOP of the group (2990 parity) — it's
          // the location registry every other warehouse doc binds against.
          { to: "/scm/warehouses", label: "Warehouses", icon: Warehouse, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.inventory"] },
          { to: "/scm/inventory", label: "Inventory", icon: Package, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.inventory"] },
          { to: "/scm/stock-adjustments", label: "Adjustments", icon: SlidersHorizontal, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.adjustments"] },
          { to: "/scm/stock-transfers", label: "Transfers", icon: ArrowLeftRight, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.transfers"] },
          { to: "/scm/stock-takes", label: "Stock Take", icon: ClipboardCheck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.stock_take"] },
        ],
      },
      {
        label: "Finance",
        icon: BookOpen,
        groupId: "scm-finance",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.finance", "scm.finance.accounting", "scm.finance.outstanding"],
        children: [
          { to: "/scm/accounting", label: "Accounting", icon: BookOpen, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.accounting"] },
          { to: "/scm/outstanding", label: "Outstanding", icon: AlertCircle, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.outstanding"] },
        ],
      },
    ],
  },

  // ── Mail Center — in-ERP shared inbox (ported from Hookka). Flat entry;
  // the page carries its own Inbox/Sent/folder rail.
  {
    section: "operations",
    to: "/mail-center",
    label: "Mail Center",
    icon: Mail,
    anyPerm: ["mail_center.read"],
  },

  // ══ SYSTEM ═══════════════════════════════════════════════════
  // ── Team — header links to the Team Hub; chevron expands the sub-pages
  // (which are tabs on the Team page). Mirrors the Supply Chain pattern.
  {
    section: "system",
    label: "Team",
    icon: Users,
    groupId: "team",
    to: "/team?tab=hub",
    anyPerm: ["users.read", "roles.read"],
    pageAccess: "team",
    children: [
      { to: "/team?tab=members", label: "Members", icon: Users, perm: "users.read", pageAccess: "team" },
      { to: "/team?tab=positions", label: "Positions", icon: ShieldCheck, perm: "users.manage", pageAccess: "team" },
      { to: "/team?tab=orgchart", label: "Org Chart", icon: Network, perm: "users.read", pageAccess: "team" },
      { to: "/team?tab=departments", label: "Departments", icon: Building2, perm: "users.read", pageAccess: "team" },
      { to: "/team?tab=mail", label: "Mailboxes", icon: Mail, perm: "mail_center.manage", pageAccess: "team" },
    ],
  },
  {
    section: "system",
    to: "/system-health",
    label: "System Health",
    icon: Activity,
    pageAccess: "system_health",
  },
  {
    section: "system",
    to: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    perm: "settings.manage",
  },
];

// Accordion sibling map — each expandable group's same-level peers. Opening a
// group collapses its siblings (top-level groups are mutually exclusive; so are
// the SCM sub-groups) so the rail never piles up. Built once from NAV_TABS.
const GROUP_SIBLINGS: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  const walk = (tabs: NavTab[]) => {
    const ids = tabs.filter((t) => t.children?.length && t.groupId).map((t) => t.groupId!);
    for (const t of tabs) {
      if (t.children?.length) {
        if (t.groupId) m[t.groupId] = ids.filter((g) => g !== t.groupId);
        walk(t.children);
      }
    }
  };
  walk(NAV_TABS);
  return m;
})();

// Section labels for the Workspace / Operations / System grouping.
const SECTION_LABELS: Record<NonNullable<NavTab["section"]>, string> = {
  workspace: "Workspace",
  operations: "Operations",
  system: "System",
};
const SECTION_ORDER = ["workspace", "operations", "system"] as const;

// Brand assets — drop the source files into frontend/public/. The paths
// below resolve to those files at runtime. If your files are .png instead
// of .svg, just rename them to match — these constants are the only place
// the extension is referenced.
const LOGO_MARK_SRC = "/logo-mark.png"; // 1:1 square — collapsed sidebar
const LOGO_WORDMARK_SRC = "/logo-wordmark.png"; // 1:4 horizontal — expanded sidebar

export function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }: Props) {
  const { user, can, pageAccess, logout } = useAuth();
  const branding = useBranding();
  const location = useLocation();
  // On mobile the drawer is always full-width — collapsed state is
  // a desktop-only concept.
  const effectiveCollapsed = collapsed;

  // Per-group expanded memory (accordion). undefined = auto (open iff the group
  // holds the current route); true/false = explicit after a click.
  const [groupExpanded, setGroupExpanded] = useLocalStorage<Record<string, boolean>>(
    "sidebar:groups:v2-accordion",
    {}
  );
  function isGroupOpen(id: string, active: boolean): boolean {
    const v = groupExpanded[id];
    return v === undefined ? active : v;
  }
  // Opening a group collapses its same-level siblings (accordion). `active`
  // resolves the auto/default state before flipping.
  function toggleGroup(id: string, active: boolean) {
    setGroupExpanded((prev) => {
      const cur = prev[id] === undefined ? active : prev[id];
      const willOpen = !cur;
      const next = { ...prev, [id]: willOpen };
      if (willOpen) for (const sib of GROUP_SIBLINGS[id] ?? []) next[sib] = false;
      return next;
    });
  }
  // Force a group open + collapse siblings — used when clicking a group's own
  // link (e.g. Supply Chain → Hub) so the tree settles to just that branch.
  function openGroup(id: string) {
    setGroupExpanded((prev) => {
      const next = { ...prev, [id]: true };
      for (const sib of GROUP_SIBLINGS[id] ?? []) next[sib] = false;
      return next;
    });
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
    // `anyPerm` + `anyAccess` are ORed: when both are present the tab shows
    // if EITHER a listed permission OR a listed page-access key passes. This
    // keeps the SCM nav ADDITIVE — `scm.access`/`*` still grant everything,
    // and a per-position SCM page-access grant ALSO unlocks its area.
    if (t.anyPerm || t.anyAccess) {
      const permOk = t.anyPerm ? t.anyPerm.some((p) => can(p)) : false;
      const accessOk = t.anyAccess
        ? t.anyAccess.some((k) => pageAccess(k) !== "none")
        : false;
      if (!permOk && !accessOk) return null;
    }
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

    // Group header (has children) — expandable section. A group that ALSO
    // carries its own `to` (Supply Chain → /scm Hub) makes its LABEL a link to
    // the Hub while the chevron still toggles the inline subtree — so the
    // sidebar keeps the submenu AND the Hub is one click away.
    if (tab.children && tab.children.length > 0) {
      const gid = tab.groupId || tab.label;
      const hasActiveDescendant = (n: NavTab): boolean =>
        (n.to ? tabIsActive(n.to, n.end) : false) ||
        (n.children?.some(hasActiveDescendant) ?? false);
      const selfActive = tab.to ? tabIsActive(tab.to, tab.end) : false;
      const headerActive = selfActive || tab.children.some(hasActiveDescendant);
      const open = isGroupOpen(gid, headerActive);
      if (collapsed) {
        // Collapsed: children render flat. A Hub-linked group leads with its
        // icon as a link to the Hub so it's still reachable.
        return (
          <div key={gid}>
            {tab.to && (
              <NavLink
                to={tab.to}
                title={tab.label}
                className={cn(
                  "group relative my-0.5 flex items-center justify-center rounded-md px-2 py-2 transition-all duration-150",
                  headerActive
                    ? "bg-sidebar-active text-sidebar-ink"
                    : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink",
                )}
              >
                <Icon size={15} strokeWidth={headerActive ? 2.4 : 2} className={headerActive ? "text-primary" : ""} />
              </NavLink>
            )}
            {tab.children.map((k) => renderTab(k, depth))}
          </div>
        );
      }
      const headerInner = (
        <>
          <Icon size={15} strokeWidth={headerActive ? 2.4 : 2} className={headerActive ? "text-primary" : ""} />
          <span className="flex-1">{tab.label}</span>
        </>
      );
      return (
        <div key={gid} className="my-0.5">
          {/* Header row: label = link (when `to`) or toggle; chevron always toggles. */}
          <div
            className={cn(
              "group relative flex w-full items-center gap-3 rounded-md pl-3 pr-1.5 text-left text-[12.5px] font-medium transition-all duration-150",
              headerActive
                ? "text-sidebar-ink"
                : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink",
              tab.to && selfActive && "bg-sidebar-active shadow-[inset_0_0_0_1px_rgba(231,234,228,0.12)]",
            )}
          >
            {tab.to && selfActive && (
              <span className="absolute -left-[10px] top-2 bottom-2 w-[2px] rounded-r bg-primary" />
            )}
            {tab.to ? (
              <NavLink
                to={tab.to}
                onClick={() => openGroup(gid)}
                className="flex min-w-0 flex-1 items-center gap-3 py-2"
              >
                {headerInner}
              </NavLink>
            ) : (
              <button
                onClick={() => toggleGroup(gid, headerActive)}
                className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
              >
                {headerInner}
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleGroup(gid, headerActive);
              }}
              className="hidden shrink-0 rounded p-1 text-sidebar-ink-muted transition-colors hover:text-sidebar-ink lg:inline-flex"
              aria-label={open ? "Collapse" : "Expand"}
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
          {/* Children: always visible on mobile; on lg+ obey the `open` flag. */}
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
              ? "bg-sidebar-active text-sidebar-ink shadow-[inset_0_0_0_1px_rgba(231,234,228,0.12)]"
              : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink",
            collapsed && "mx-1 justify-center px-2"
          )
        }
      >
        {active && !collapsed && (
          <span className="absolute -left-[10px] top-2 bottom-2 w-[2px] rounded-r bg-primary" />
        )}
        <Icon
          size={15}
          strokeWidth={active ? 2.4 : 2}
          className={active ? "text-primary" : ""}
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
            alt={branding.companyName}
            className="h-9 w-9 object-contain brightness-0 invert"
            draggable={false}
          />
        ) : (
          // Expanded: the horizontal wordmark fills the available width.
          // The 1:4 aspect ratio + h-10 yields a comfortable ~40×160 box.
          <img
            src={LOGO_WORDMARK_SRC}
            alt={branding.companyName}
            className="h-10 w-auto max-w-[160px] object-contain brightness-0 invert"
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
        {SECTION_ORDER.map((sec) => {
          const items = visibleTabs.filter((t) => (t.section ?? "operations") === sec);
          if (items.length === 0) return null;
          return (
            <div key={sec} className={collapsed ? "" : "mb-1"}>
              {!collapsed && (
                <div className="px-3 pb-1 pt-3 font-mono text-[9.5px] font-bold uppercase tracking-brand text-sidebar-ink-muted">
                  {SECTION_LABELS[sec]}
                </div>
              )}
              {items.map((tab) => renderTab(tab))}
            </div>
          );
        })}
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
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-sidebar-active text-[9px] font-bold uppercase text-accent-bright">
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
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-active text-[10px] font-bold uppercase text-accent-bright shadow-[inset_0_0_0_1px_rgba(161,106,46,0.25)] group-hover:bg-accent group-hover:text-white">
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
