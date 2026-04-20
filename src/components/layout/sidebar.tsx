"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";
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
  ChevronDown,
  Check,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

// ---------- users ----------
interface AppUser {
  name: string;
  role: string;
}

const APP_USERS: AppUser[] = [
  { name: "Ummu", role: "Director" },
  { name: "Nico", role: "Director" },
];

const USER_STORAGE_KEY = "houzs-current-user";

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [currentUser, setCurrentUser] = useState<AppUser>(APP_USERS[0]);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Load saved user from localStorage on mount (client only)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(USER_STORAGE_KEY);
    if (stored) {
      const match = APP_USERS.find((u) => u.name === stored);
      if (match) setCurrentUser(match);
    }
  }, []);

  // Close user menu when clicking outside
  useEffect(() => {
    if (!userMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [userMenuOpen]);

  const selectUser = (u: AppUser) => {
    setCurrentUser(u);
    setUserMenuOpen(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(USER_STORAGE_KEY, u.name);
    }
  };

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 h-screen bg-[#0A1F2E] text-white transition-all duration-300 flex flex-col",
        collapsed ? "w-14" : "w-60"
      )}
    >
      {/* Brand */}
      <div className="flex h-14 items-center justify-between px-3 border-b border-white/10 shrink-0">
        {!collapsed ? (
          <Link href="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded bg-gradient-to-br from-[#14B8A6] to-[#0F766E] flex items-center justify-center text-sm font-bold shrink-0">
              H
            </div>
            <span className="text-[18px] font-[800] tracking-[2px]">HOUZS</span>
          </Link>
        ) : (
          <Link href="/" className="mx-auto">
            <div className="h-8 w-8 rounded bg-gradient-to-br from-[#14B8A6] to-[#0F766E] flex items-center justify-center text-sm font-bold">
              H
            </div>
          </Link>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-3 scrollbar-thin">
        {navigationGroups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none">
                {group.label}
              </div>
            )}
            {collapsed && <div className="my-1 mx-2 border-t border-white/10" />}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-md text-sm font-medium transition-colors",
                      "h-9 px-3",
                      active
                        ? "bg-[rgba(15,118,110,.22)] text-white border-l-[3px] border-[#0F766E]"
                        : "text-gray-400 hover:bg-white/5 hover:text-gray-300 border-l-[3px] border-transparent",
                      collapsed && "justify-center px-0"
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

      {/* User */}
      <div className="border-t border-white/10 px-2 py-2 shrink-0 relative" ref={userMenuRef}>
        {collapsed ? (
          <button
            type="button"
            onClick={() => setUserMenuOpen((o) => !o)}
            className="flex w-full items-center justify-center hover:opacity-80 transition"
            title={`${currentUser.name} — ${currentUser.role}`}
          >
            <div className="h-8 w-8 rounded-full bg-[#0F766E]/40 flex items-center justify-center text-xs font-semibold text-white">
              {currentUser.name[0]}
            </div>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setUserMenuOpen((o) => !o)}
            className="flex w-full items-center gap-2.5 px-1 py-0.5 rounded hover:bg-white/5 transition text-left"
          >
            <div className="h-8 w-8 rounded-full bg-[#0F766E]/40 flex items-center justify-center text-xs font-semibold text-white shrink-0">
              {currentUser.name[0]}
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-[13px] font-semibold text-white truncate">{currentUser.name}</span>
              <span className="inline-flex items-center self-start rounded-full bg-[#0F766E]/30 text-[10px] text-gray-300 px-2 py-[2px]">
                {currentUser.role}
              </span>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-gray-400 shrink-0 transition-transform",
                userMenuOpen && "rotate-180"
              )}
              strokeWidth={2}
            />
          </button>
        )}

        {userMenuOpen && (
          <div
            className={cn(
              "absolute bottom-full mb-2 bg-[#122C3D] border border-white/10 rounded-md shadow-lg overflow-hidden z-50",
              collapsed ? "left-1 w-40" : "left-2 right-2"
            )}
          >
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-b border-white/5">
              Switch user
            </div>
            {APP_USERS.map((u) => {
              const selected = u.name === currentUser.name;
              return (
                <button
                  key={u.name}
                  type="button"
                  onClick={() => selectUser(u)}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 w-full text-left transition",
                    selected ? "bg-[#0F766E]/20" : "hover:bg-white/5"
                  )}
                >
                  <div className="h-6 w-6 rounded-full bg-[#0F766E]/40 flex items-center justify-center text-[10px] font-semibold text-white shrink-0">
                    {u.name[0]}
                  </div>
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="text-[12px] font-semibold text-white truncate">{u.name}</span>
                    <span className="text-[10px] text-gray-400 truncate">{u.role}</span>
                  </div>
                  {selected && <Check className="h-3.5 w-3.5 text-[#14B8A6] shrink-0" strokeWidth={3} />}
                </button>
              );
            })}
          </div>
        )}
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
  );
}
