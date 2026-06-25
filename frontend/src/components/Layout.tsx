import { useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { TopNavbar } from "./TopNavbar";
import { MobileTabBar } from "./MobileTabBar";
import { PullToRefresh, PullToRefreshGuardProvider } from "./PullToRefresh";
import { RowActionsMenu, type MenuItem } from "./RowActionsMenu";
import { useQuery } from "../hooks/useQuery";
import { useBranding } from "../hooks/useBranding";
import { api } from "../api/client";
import type { SyncStatusResponse } from "../types";

interface Props {
  children: ReactNode;
}

const LOGO_MARK_SRC = "/logo-mark.png";
const LOGO_WORDMARK_SRC = "/logo-wordmark.png";

export function Layout({ children }: Props) {
  // Desktop collapse — only used at lg+. Mobile no longer has a
  // drawer-opening hamburger; the bottom rail's centre Menu disc
  // covers nav, so the top bar is just brand + chrome.
  const [collapsed, setCollapsed] = useState(false);

  // Fetch the company identity once here (Layout wraps every authed page). This
  // primes the module-level branding cache that the pure jspdf PDF libs read,
  // so any document generated from inside the app carries the live letterhead.
  useBranding();

  // One global poll of /api/sync/status — used to surface the
  // AutoCount-writes-disabled kill switch as a persistent banner.
  const status = useQuery<SyncStatusResponse>(() =>
    api.get("/api/sync/status")
  );
  const writesDisabled = status.data?.autocount_writes_disabled === true;

  return (
    <div className="flex h-dvh min-h-dvh w-screen overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={false}
      />

      <main className="paper-grain thin-scroll flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
        {/* Mobile top bar — brand + topbar chrome only. Hidden on lg+. */}
        <MobileTopBar />

        {/* Desktop top navbar — breadcrumb + search + bell + profile. */}
        <TopNavbar />

        {writesDisabled && <ReadOnlyBanner />}

        {/* Bottom padding clears the mobile tab rail (h-14 + safe area)
            AND the floating chat FAB which sits above the rail at
            bottom-20 + safe area + h-12. Total clearance: 160 + safe
            area for mobile/sm, normal for lg+ where the rail is hidden
            and the FAB tucks into the corner.
            The Guard provider wraps both PullToRefresh and children so
            pages with unsaved Panel state can call
            `usePullToRefreshBlock(true)` to block accidental F5. */}
        <PullToRefreshGuardProvider>
          <PullToRefresh className="w-full px-4 pt-6 pb-[calc(10rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-8 lg:px-10 lg:py-10 xl:px-12 2xl:px-16 animate-rise">
            {children}
          </PullToRefresh>
        </PullToRefreshGuardProvider>
      </main>

      {/* Mobile bottom tab rail — visible below lg, sits above the
          Floating Chat FAB which auto-clears it on mobile. The centre
          "Menu" tab opens its own bottom-sheet modal (no longer
          delegates to the Sidebar drawer), so onOpenDrawer is gone. */}
      <MobileTabBar />
    </div>
  );
}

/**
 * Mobile-only top bar. Brand mark on the left + PointsChip + collapsed
 * search on the right. Hidden on lg+. Navigation is handled exclusively
 * by the bottom rail's centre Menu disc — no hamburger here.
 */
function MobileTopBar() {
  const branding = useBranding();
  return (
    <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm lg:hidden">
      <img
        src={LOGO_WORDMARK_SRC}
        alt={branding.companyName}
        // Phone: shrink the wordmark so the top bar reads as chrome, not a
        // brochure header (owner: logo too big on phone). Steps back up to the
        // original size at sm+ (tablet). h-5≈20px → h-7≈28px.
        className="h-5 w-auto max-w-[104px] object-contain sm:h-7 sm:max-w-[140px]"
        draggable={false}
      />
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
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
      <div className="flex w-full items-start gap-3 px-4 py-2.5 sm:px-6 lg:px-10 xl:px-12 2xl:px-16">
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
  /** Always-rendered ReactNode (status pill, filter strip, bespoke chrome).
   *  Same shape as before — pages that don't opt into the new split keep working. */
  actions?: ReactNode;
  /** Primary CTA — always visible. Sits at the right edge of the action row.
   *  On mobile this is the only inline action besides the optional kebab. */
  primaryAction?: ReactNode;
  /** Secondary actions. On `sm+` they render as a row of compact buttons.
   *  On `<sm` they collapse into a single kebab so the header stays one-row. */
  secondaryActions?: MenuItem[];
  /** Optional small label rendered above the title — e.g. section name. */
  eyebrow?: string;
  /** Tightens the header's bottom margin/padding for dense pages (e.g. the
   *  Calendar, where the grid should sit high). Default keeps the roomy
   *  spacing every other page uses. */
  dense?: boolean;
}

export function PageHeader({
  title,
  description,
  actions,
  primaryAction,
  secondaryActions,
  eyebrow,
  dense,
}: PageHeaderProps) {
  const secondary = secondaryActions ?? [];
  const hasSecondary = secondary.length > 0;
  const hasActions = !!actions || !!primaryAction || hasSecondary;

  return (
    <div
      className={
        dense
          ? "mb-3 flex flex-col gap-2 border-b border-border pb-2 sm:mb-4 sm:pb-3 md:flex-row md:items-end md:justify-between"
          : "mb-4 flex flex-col gap-3 border-b border-border pb-3 sm:mb-8 sm:gap-3 sm:pb-6 md:flex-row md:items-end md:justify-between"
      }
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1.5 flex items-center gap-2 sm:mb-2">
            <span className="h-px w-5 bg-accent sm:w-6" />
            <span className="text-[10.5px] font-semibold uppercase tracking-brand text-accent sm:text-[10px]">
              {eyebrow}
            </span>
          </div>
        )}
        <h1 className="font-display text-[19px] font-extrabold leading-tight tracking-tight text-ink max-[359px]:text-[17px] sm:text-[26px] lg:text-[28px]">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-secondary sm:mt-1.5 sm:text-sm">
            {description}
          </p>
        )}
      </div>
      {hasActions && (
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 md:shrink-0">
          {actions}
          {/* Desktop (sm+): secondary actions render as inline buttons */}
          {hasSecondary && (
            <div className="hidden items-center gap-1.5 sm:flex sm:gap-2">
              {secondary.map((it, i) => {
                const Icon = it.icon;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={it.onClick}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                  >
                    <Icon size={13} />
                    {it.label}
                  </button>
                );
              })}
            </div>
          )}
          {primaryAction}
          {/* Mobile (<sm): secondary actions collapse into a kebab so the
              header stays one row. Trigger sized to the 44 px touch floor. */}
          {hasSecondary && (
            <div className="sm:hidden">
              <RowActionsMenu items={secondary} title="More actions" size={44} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
