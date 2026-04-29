import { Fragment } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useBreadcrumbs } from "../hooks/useBreadcrumbs";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import { PresenceIndicator } from "./PresenceIndicator";
import { PointsChip } from "./PointsChip";
import { cn } from "../lib/utils";

/**
 * Desktop-only sticky top navbar. Hosts breadcrumb (left), search +
 * notifications + profile avatar (right). Hidden below lg; the mobile
 * top bar in Layout owns its own reduced chrome.
 *
 * Breadcrumb source of truth: BreadcrumbContext. DetailLayout pushes
 * its crumbs via useSetBreadcrumbs; for plain list pages we fall back
 * to a route-derived single crumb.
 */
export function TopNavbar() {
  const { user } = useAuth();
  const { crumbs } = useBreadcrumbs();
  const location = useLocation();

  // When the active page hasn't set its own breadcrumb, build a
  // single-crumb label from the current route so the navbar never
  // looks empty.
  const shown =
    crumbs.length > 0 ? crumbs : [{ label: labelForPath(location.pathname) }];

  return (
    <header className="sticky top-0 z-30 hidden h-12 items-center gap-3 border-b border-border bg-surface/95 px-5 backdrop-blur-sm lg:flex">
      {/* ── Breadcrumb ───────────────────────────────────────── */}
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[12px]"
      >
        {shown.map((item, i) => {
          const isLast = i === shown.length - 1;
          return (
            <Fragment key={`${item.label}-${i}`}>
              {i > 0 && (
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className="shrink-0 text-ink-muted/50"
                />
              )}
              {item.to && !isLast ? (
                <Link
                  to={item.to}
                  className="shrink-0 truncate rounded px-1 py-0.5 font-medium text-ink-secondary transition-colors hover:bg-bg/60 hover:text-accent"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className={cn(
                    "min-w-0 truncate px-1 py-0.5",
                    isLast ? "font-semibold text-ink" : "text-ink-secondary"
                  )}
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
            </Fragment>
          );
        })}
      </nav>

      {/* ── Right rail: search · online · bell · profile ───── */}
      <div className="flex shrink-0 items-center gap-2">
        <GlobalSearchTrigger collapsed={false} />
        {user && (
          <>
            <PointsChip />
            <div className="h-5 w-px bg-border-subtle" />
            <PresenceIndicator />
            <NotificationBell collapsed direction="down" align="end" />
            <NavLink
              to="/profile"
              className="group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-bg/60"
              title={`${user.name || user.email} — Profile`}
              aria-label="Profile"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft font-mono text-[10px] font-bold uppercase text-accent-ink group-hover:bg-accent group-hover:text-white">
                {(user.name || user.email).slice(0, 2).toUpperCase()}
              </span>
              <div className="hidden min-w-0 xl:block">
                <div className="truncate text-[11.5px] font-semibold text-ink group-hover:text-accent">
                  {user.name || user.email.split("@")[0]}
                </div>
                <div className="truncate text-[9.5px] text-ink-muted">
                  {user.role_name}
                </div>
              </div>
            </NavLink>
          </>
        )}
      </div>
    </header>
  );
}

// ── Route → label fallback ─────────────────────────────────
// Quick mapping for pages that don't push breadcrumbs themselves.
// Keeps the navbar from rendering as an empty strip.
const ROUTE_LABELS: Array<[RegExp, string]> = [
  [/^\/$/, "Overview"],
  [/^\/orders\/.+$/, "Sales Order"],
  [/^\/orders$/, "Sales Orders"],
  [/^\/delivery-orders$/, "Delivery Orders"],
  [/^\/delivery\/.+$/, "Delivery"],
  [/^\/logistics$/, "Logistics"],
  [/^\/trips\/.+$/, "Trip"],
  [/^\/lorries\/.+$/, "Lorry"],
  [/^\/staff\/.+$/, "Staff"],
  [/^\/po\/.+$/, "Purchase Order"],
  [/^\/po$/, "Purchase Orders"],
  [/^\/creditors\/.+$/, "Creditor"],
  [/^\/assr\/.+$/, "Service Case"],
  [/^\/assr$/, "Service Cases"],
  [/^\/projects\/.+$/, "Project"],
  [/^\/projects$/, "Projects"],
  [/^\/sales$/, "Sales"],
  [/^\/team$/, "Team"],
  [/^\/gamification$/, "Engagement"],
  [/^\/settings$/, "Settings"],
  [/^\/profile$/, "Profile"],
];

function labelForPath(pathname: string): string {
  for (const [re, label] of ROUTE_LABELS) {
    if (re.test(pathname)) return label;
  }
  // Generic fallback: capitalise the first segment.
  const seg = pathname.split("/").filter(Boolean)[0] || "";
  return seg ? seg[0].toUpperCase() + seg.slice(1) : "";
}
