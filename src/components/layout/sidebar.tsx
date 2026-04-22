import { Link } from "react-router-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  Briefcase,
  Users,
  Wrench,
  KanbanSquare,
  Car,
  DollarSign,
  Calendar,
  Settings,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  FileText,
  Receipt,
  Package,
  Menu,
  ScrollText,
  SlidersHorizontal,
  UsersRound,
  ChevronDown,
  Search as SearchIcon,
  UserCog,
  LogOut,
  ArrowLeftFromLine,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrentUser, isAdmin, canViewFinance, useAuth, impersonate, stopImpersonate, logout } from "@/lib/auth-store";
import { usersApi, type UserRow } from "@/lib/auth-api";
import { MODULES_BY_PATH, hasAccess } from "@/lib/modules";

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navigationGroups: NavGroup[] = [
  {
    label: "PROJECT MANAGEMENT",
    items: [
      { name: "Calendar", href: "/calendar", icon: Calendar },
      { name: "Project Management Dashboard", href: "/", icon: LayoutDashboard },
      { name: "Project Financial Report", href: "/finance", icon: DollarSign },
      { name: "Project Details", href: "/pms", icon: KanbanSquare },
      { name: "Master Data", href: "/settings", icon: Settings },
    ],
  },
  {
    label: "SALES",
    items: [
      { name: "Sales Team", href: "/sales", icon: Users },
      { name: "Sales Order Details", href: "/sales/details", icon: FileText },
      { name: "Sales Order", href: "/sales/orders", icon: Receipt },
      { name: "SKU Costing", href: "/sales/sku-costing", icon: Package },
    ],
  },
  {
    label: "QMS",
    items: [
      { name: "After-Sales Cases", href: "/qms", icon: ShieldCheck },
    ],
  },
  {
    label: "DEPARTMENTS",
    items: [
      { name: "PM Department", href: "/bd", icon: Briefcase },
      { name: "Operation", href: "/operation", icon: Wrench },
      { name: "Driver", href: "/driver", icon: Car },
    ],
  },
];

// Admin section — only rendered for Sales Directors
const adminNavGroup: NavGroup = {
  label: "ADMIN",
  items: [
    { name: "Users", href: "/admin/users", icon: UsersRound },
    { name: "Audit Log", href: "/admin/audit-log", icon: ScrollText },
    { name: "Permissions", href: "/admin/permissions", icon: SlidersHorizontal },
  ],
};

// Mobile top bar — shown only on small screens (md:hidden via DashboardLayout)
export function MobileTopBar({ onOpen }: { onOpen: () => void }) {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-[#0A1F2E] flex items-center justify-between px-4 md:hidden">
      <Link to="/" className="flex items-center gap-2">
        <div className="h-8 w-8 rounded bg-gradient-to-br from-[#14B8A6] to-[#0F766E] flex items-center justify-center text-sm font-bold shrink-0 text-white">
          H
        </div>
        <span className="text-[18px] font-[800] tracking-[2px] text-white">HOUZS</span>
      </Link>
      <button
        type="button"
        onClick={onOpen}
        className="h-9 w-9 rounded-md flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>
    </header>
  );
}

export function Sidebar({ mobileOpen, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  const currentUser = useCurrentUser();
  const userIsAdmin = isAdmin(currentUser);
  const userCanViewFinance = canViewFinance(currentUser);

  // Account switcher state (admin only) — click avatar at bottom to impersonate
  const auth = useAuth();
  const { isImpersonating, impersonatedBy } = auth;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const [switcherUsers, setSwitcherUsers] = useState<UserRow[] | null>(null);
  const [switcherBusy, setSwitcherBusy] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) setSwitcherOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Lazy-load users list first time the switcher opens
  useEffect(() => {
    if (!switcherOpen || switcherUsers || !userIsAdmin) return;
    usersApi.list().then((r) => { if (r.ok) setSwitcherUsers(r.data); });
  }, [switcherOpen, switcherUsers, userIsAdmin]);

  async function handleImpersonate(userId: string) {
    setSwitcherBusy(true);
    await impersonate(userId);
    setSwitcherBusy(false);
    setSwitcherOpen(false);
    nav("/", { replace: true });
  }
  async function handleStopImpersonate() {
    setSwitcherBusy(true);
    await stopImpersonate();
    setSwitcherBusy(false);
    setSwitcherOpen(false);
  }
  async function handleLogout() {
    await logout();
    nav("/login", { replace: true });
  }

  const filteredSwitcherUsers = (switcherUsers ?? []).filter((u) => {
    if (u.id === currentUser?.id) return false;          // can't impersonate self
    if (u.status !== "ACTIVE") return false;
    // Only users with a password (can actually be signed in as). NOT_INVITED
    // rows are hidden. Pending (must_change_password = true, never logged in)
    // are also hidden to keep the list clean.
    if (!u.hasPassword) return false;
    if (u.mustChangePassword && !u.lastLogin) return false;
    const q = switcherQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      u.position.toLowerCase().includes(q) ||
      u.department.toLowerCase().includes(q)
    );
  });

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    // exact match first; for "/sales" don't highlight when on sub-routes like /sales/details
    if (pathname === href) return true;
    // only extend to sub-paths for routes that own a sub-tree (not the leaf SALES items)
    const leafRoutes = [
      "/sales/details", "/sales/orders", "/sales/sku-costing", "/sales",
    ];
    if (leafRoutes.includes(href)) return pathname === href;
    return pathname.startsWith(href + "/");
  };

  const avatarLetter = (currentUser?.name ?? "?")[0].toUpperCase();
  const displayName = currentUser
    ? currentUser.name.charAt(0) + currentUser.name.slice(1).toLowerCase()
    : "Guest";

  function handleNavClick() {
    if (onMobileClose) onMobileClose();
  }

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onMobileClose}
        />
      )}
    <aside
      className={cn(
        "fixed left-0 top-0 z-50 h-screen bg-[#0A1F2E] text-white transition-all duration-300 flex flex-col",
        // Desktop: always visible, collapsible
        "hidden md:flex",
        collapsed ? "w-14" : "w-60",
        // Mobile: slide in from left when open
        mobileOpen && "!flex w-60"
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Brand */}
      <div className="flex h-14 items-center justify-between px-3 border-b border-white/10 shrink-0">
        {!collapsed ? (
          <Link to="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded bg-gradient-to-br from-[#14B8A6] to-[#0F766E] flex items-center justify-center text-sm font-bold shrink-0">
              H
            </div>
            <span className="text-[18px] font-[800] tracking-[2px]">HOUZS</span>
          </Link>
        ) : (
          <Link to="/" className="mx-auto">
            <div className="h-8 w-8 rounded bg-gradient-to-br from-[#14B8A6] to-[#0F766E] flex items-center justify-center text-sm font-bold">
              H
            </div>
          </Link>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-3 scrollbar-thin">
        {[...navigationGroups, adminNavGroup]
          .map((group) => {
            // Phase 2: filter items by role_permissions matrix. An item is
            // visible if its mapped module has level >= VIEW. A group is
            // rendered only if at least one of its items passes.
            const visibleItems = group.items.filter((item) => {
              const mod = MODULES_BY_PATH[item.href];
              // Items without a module mapping (legacy routes) fall back to
              // admin-only so we don't accidentally expose them.
              if (!mod) return userIsAdmin;
              const level = auth.user?.permissions?.[mod.key];
              return hasAccess(level, "VIEW");
            });
            return { ...group, items: visibleItems };
          })
          .filter((group) => group.items.length > 0)
          .map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none">
                {group.label}
              </div>
            )}
            {collapsed && <div className="my-1 mx-2 border-t border-white/10" />}
            <div className="space-y-0.5">
              {group.items
                .filter(() => true)
                .map((item) => {
                const active = isActive(item.href);
                // Hide PM Dashboard + Financial Report on mobile (tables too wide to be useful)
                const hideOnMobile = item.href === "/" || item.href === "/finance";
                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    onClick={handleNavClick}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-md text-sm font-medium transition-colors",
                      "h-9 px-3",
                      active
                        ? "bg-[rgba(15,118,110,.22)] text-white border-l-[3px] border-[#0F766E]"
                        : "text-gray-400 hover:bg-white/5 hover:text-gray-300 border-l-[3px] border-transparent",
                      collapsed && "justify-center px-0",
                      hideOnMobile && "hidden md:flex"
                    )}
                    title={collapsed ? item.name : undefined}
                  >
                    <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
                    {!collapsed && <span className="truncate">{item.name}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Org badge */}
      <div className="border-t border-white/10 px-2 py-2 shrink-0">
        {collapsed ? (
          <div className="flex items-center justify-center">
            <div className="h-6 w-6 rounded bg-[#0F766E]/40 flex items-center justify-center text-[9px] font-bold text-gray-300">
              HZ
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="h-6 w-6 rounded bg-[#0F766E]/40 flex items-center justify-center text-[9px] font-bold text-gray-300 shrink-0">
              HZ
            </div>
            <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 truncate">
              HOUZS OPERATIONS
            </span>
          </div>
        )}
      </div>

      {/* Current user + admin account switcher. Clicking (admin only) opens a
           popover above with search + list of other users to impersonate.
           Non-admins just see their name display-only. */}
      <div className="border-t border-white/10 px-2 py-2 shrink-0 relative" ref={switcherRef}>
        {/* Dropdown — rendered above the trigger */}
        {switcherOpen && userIsAdmin && !collapsed && (
          <div className="absolute bottom-full left-2 right-2 mb-1 rounded-lg border border-white/10 bg-[#0E2D40] shadow-xl z-50 overflow-hidden">
            {/* Impersonation banner */}
            {isImpersonating && impersonatedBy && (
              <button
                type="button"
                onClick={handleStopImpersonate}
                disabled={switcherBusy}
                className="w-full flex items-center gap-2 px-3 py-2 text-amber-300 hover:bg-amber-500/10 border-b border-white/10 text-[11px]"
              >
                <ArrowLeftFromLine className="h-3.5 w-3.5 shrink-0" />
                Return to {impersonatedBy.name}
              </button>
            )}
            {/* Search */}
            <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
              <SearchIcon className="h-3 w-3 text-gray-500 shrink-0" />
              <input
                type="text"
                value={switcherQuery}
                onChange={(e) => setSwitcherQuery(e.target.value)}
                placeholder="Switch to user…"
                autoFocus
                className="w-full h-5 bg-transparent text-[11px] text-white placeholder:text-gray-500 outline-none"
              />
            </div>
            {/* Member list */}
            <div className="max-h-[260px] overflow-y-auto">
              {switcherUsers === null && (
                <div className="px-3 py-3 text-[11px] text-gray-500 text-center">Loading…</div>
              )}
              {switcherUsers !== null && filteredSwitcherUsers.length === 0 && (
                <div className="px-3 py-3 text-[11px] text-gray-500 text-center">
                  {switcherUsers.length === 0 ? "No users" : "No matches. Only ACTIVE users with a password can be impersonated."}
                </div>
              )}
              {filteredSwitcherUsers.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => handleImpersonate(u.id)}
                  disabled={switcherBusy}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
                >
                  <div className="h-6 w-6 rounded-full bg-[#0F766E]/40 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                    {u.name[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-semibold truncate">{u.name}</div>
                    <div className="text-[9px] text-gray-500 truncate">{u.position} · {u.department}</div>
                  </div>
                  <UserCog className="h-3 w-3 text-gray-500 shrink-0" />
                </button>
              ))}
            </div>
            {/* Sign out */}
            <div className="border-t border-white/10">
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors text-[11px] font-medium"
              >
                <LogOut className="h-3.5 w-3.5 shrink-0" />
                Sign out
              </button>
            </div>
          </div>
        )}

        {/* Trigger */}
        <button
          type="button"
          onClick={() => userIsAdmin && setSwitcherOpen((o) => !o)}
          disabled={!userIsAdmin}
          className={cn(
            "w-full rounded-md transition-colors",
            collapsed ? "flex items-center justify-center p-1" : "flex items-center gap-2.5 px-1 py-1.5",
            userIsAdmin && "hover:bg-white/5 cursor-pointer",
            !userIsAdmin && "cursor-default",
          )}
          title={collapsed ? (currentUser?.name ?? "") : (userIsAdmin ? "Switch account" : undefined)}
        >
          <div className="h-8 w-8 rounded-full bg-[#0F766E]/40 flex items-center justify-center text-xs font-semibold text-white shrink-0">
            {avatarLetter}
          </div>
          {!collapsed && (
            <>
              <div className="flex flex-col min-w-0 flex-1 text-left">
                <span className="text-[13px] font-semibold text-white truncate">{displayName}</span>
                <span className={cn(
                  "inline-flex items-center self-start rounded-full text-[10px] px-2 py-[2px] mt-0.5",
                  userIsAdmin
                    ? "bg-[#0F766E]/30 text-[#5EEAD4]"
                    : "bg-amber-500/20 text-amber-300"
                )}>
                  {userIsAdmin ? "Admin" : (currentUser?.position ?? "Guest")}
                </span>
              </div>
              {userIsAdmin && (
                <ChevronDown className={cn(
                  "h-3 w-3 text-gray-500 transition-transform shrink-0",
                  switcherOpen && "rotate-180"
                )} />
              )}
            </>
          )}
        </button>
      </div>

      {/* Collapse toggle */}
      <div className="border-t border-white/10 p-2 shrink-0">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center justify-center rounded-md p-1.5 text-gray-500 hover:bg-white/10 hover:text-white transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>
    </aside>
    </>
  );
}
