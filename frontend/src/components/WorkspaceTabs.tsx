import { useEffect, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import {
  activateWorkspaceTab,
  closeWorkspaceTab,
  getWorkspaceTabsSnapshot,
  recordWorkspaceVisit,
  sectionKeyFor,
  subscribeWorkspaceTabs,
  workspaceTabLabel,
} from "../lib/workspaceTabs";

/**
 * Desktop-only workspace tab strip (owner ask 2026-07-23: run Sales Orders and
 * Service Cases side by side INSIDE one window). Sits sticky directly under
 * TopNavbar. Tabs behave like browser tabs: in-content navigation (hub cards,
 * table rows, back buttons) re-points the ACTIVE tab, and only a sidebar click
 * spawns/activates another tab (see lib/workspaceTabs.ts). ✕ or middle-click
 * closes.
 *
 * Tabs are react-router <Link>s, not buttons, so Ctrl/Cmd+click falls through
 * to the browser and opens a REAL new window — which then keeps its own
 * per-window company and its own strip (lib/activeCompany.ts).
 *
 * Height is h-9: PageHeader, DetailLayout and the two SCM V2 sticky bars park
 * at lg:top-[5.25rem] (navbar h-12 + this strip) — change one, change all.
 * Hidden below lg like TopNavbar; the mobile chrome is untouched.
 */
export function WorkspaceTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const { tabs, activeId } = useSyncExternalStore(
    subscribeWorkspaceTabs,
    getWorkspaceTabsSnapshot,
    getWorkspaceTabsSnapshot,
  );

  // Record AFTER render (an effect, not render-time) — recordWorkspaceVisit
  // emits, and emitting during render would schedule an update mid-render.
  useEffect(() => {
    recordWorkspaceVisit(location.pathname, location.search);
  }, [location.pathname, location.search]);

  function close(id: string) {
    const { navigateTo } = closeWorkspaceTab(id);
    if (navigateTo !== null) navigate(navigateTo);
  }

  return (
    <div
      role="tablist"
      aria-label="Open pages"
      className="thin-scroll sticky top-12 z-30 hidden h-9 items-end gap-1 overflow-x-auto overflow-y-hidden border-b border-border bg-surface/95 px-3 backdrop-blur-sm lg:flex"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const label = workspaceTabLabel(sectionKeyFor(tab.href));
        return (
          <div
            key={tab.id}
            className={cn(
              // -mb-px drops the active tab over the strip's bottom border so
              // it visually connects to the page below (bg-bg on bg-bg).
              "group -mb-px flex shrink-0 items-center rounded-t-md border border-b-0 transition-colors",
              isActive
                ? "border-border bg-bg"
                : "border-transparent hover:bg-bg/50",
            )}
          >
            <Link
              to={tab.href}
              role="tab"
              aria-selected={isActive}
              data-tab-id={tab.id}
              onClick={(e) => {
                // Plain left click: mark the clicked tab active BEFORE the
                // route changes, so the ensuing location effect re-points
                // nothing. Modified clicks open a real browser window — this
                // tab never navigates, so it must NOT change active either.
                if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                  activateWorkspaceTab(tab.id);
                }
              }}
              onAuxClick={(e) => {
                // Middle-click closes, like a browser tab. preventDefault
                // stops the browser's own middle-click-opens-window default.
                if (e.button === 1) {
                  e.preventDefault();
                  close(tab.id);
                }
              }}
              className={cn(
                "max-w-[13rem] truncate py-1.5 pl-3 pr-1 text-[11.5px] leading-none",
                isActive
                  ? "font-semibold text-primary"
                  : "font-medium text-ink-secondary hover:text-ink",
              )}
            >
              {label}
            </Link>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => close(tab.id)}
              title="Close tab"
              aria-label={`Close ${label}`}
              className={cn(
                "mr-1 rounded p-0.5 transition-colors hover:bg-border/60 hover:text-ink",
                isActive
                  ? "text-ink-muted"
                  : "text-transparent group-hover:text-ink-muted",
              )}
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
