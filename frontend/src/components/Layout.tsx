import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ShieldAlert, Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import type { SyncStatusResponse } from "../types";

interface Props {
  children: ReactNode;
}

const LOGO_MARK_SRC = "/logo-mark.png";
const LOGO_WORDMARK_SRC = "/logo-wordmark.png";

export function Layout({ children }: Props) {
  // Desktop collapse — only used at lg+
  const [collapsed, setCollapsed] = useState(false);
  // Mobile drawer — only used below lg
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Auto-close the mobile drawer whenever the route changes — otherwise
  // tapping a nav item leaves the drawer covering the page they wanted.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Lock body scroll when the mobile drawer is open so the page
  // underneath doesn't scroll behind it.
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [mobileOpen]);

  // One global poll of /api/sync/status — used to surface the
  // AutoCount-writes-disabled kill switch as a persistent banner.
  const status = useQuery<SyncStatusResponse>(() =>
    api.get("/api/sync/status")
  );
  const writesDisabled = status.data?.autocount_writes_disabled === true;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <main className="paper-grain thin-scroll flex-1 overflow-y-auto">
        {/* Mobile top bar — hamburger + brand mark. Hidden on lg+. */}
        <MobileTopBar onOpenDrawer={() => setMobileOpen(true)} />

        {writesDisabled && <ReadOnlyBanner />}

        <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10 animate-rise">
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * Mobile-only top bar. Provides the hamburger that opens the sidebar
 * drawer plus a small brand mark so users know which workspace they're
 * in. Hidden on lg+ where the sidebar is always visible.
 */
function MobileTopBar({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  return (
    <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm lg:hidden">
      <button
        onClick={onOpenDrawer}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
        aria-label="Open menu"
      >
        <Menu size={18} />
      </button>
      <img
        src={LOGO_WORDMARK_SRC}
        alt="Houzs Century"
        className="h-7 w-auto max-w-[140px] object-contain"
        draggable={false}
      />
      <div className="ml-auto flex items-center gap-1">
        <GlobalSearchTrigger collapsed />
      </div>
    </div>
  );
}

/**
 * Persistent banner shown whenever the worker reports that outbound
 * writes to AutoCount are disabled. Sticky at the top of the main
 * scroll area so it's always visible no matter which tab the user is
 * on.
 */
function ReadOnlyBanner() {
  return (
    <div className="sticky top-14 z-10 border-b border-warning-text/30 bg-warning-bg/95 backdrop-blur-sm lg:top-0">
      <div className="mx-auto flex w-full max-w-[1400px] items-start gap-3 px-4 py-2.5 sm:px-6 lg:px-10">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning-text/15 text-warning-text">
          <ShieldAlert size={13} strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-warning-text">
            Read-Only Mode
          </div>
          <div className="text-[12px] font-medium leading-snug text-warning-text/90">
            AutoCount writes are halted. Edits are saved locally but{" "}
            <span className="font-semibold">not pushed to AutoCount</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Optional small label rendered above the title — e.g. section name. */
  eyebrow?: string;
}

export function PageHeader({ title, description, actions, eyebrow }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-border pb-5 sm:mb-8 sm:gap-3 sm:pb-6 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 flex items-center gap-2">
            <span className="h-px w-6 bg-accent" />
            <span className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              {eyebrow}
            </span>
          </div>
        )}
        <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink sm:text-[26px] lg:text-[28px]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-ink-secondary sm:text-sm">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 md:shrink-0">{actions}</div>
      )}
    </div>
  );
}
