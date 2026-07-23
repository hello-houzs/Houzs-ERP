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
 * Workspace tab strip — rendered INLINE on the left of TopNavbar's single
 * 52px bar (top-chrome redesign 2b, owner handoff 2026-07-23: one row, no
 * second bar). Active tab = primary-ink text + a 2.5px petrol underline on
 * the bar's bottom edge; ✕ closes (hover-revealed on background tabs,
 * always visible on the active one); middle-click closes.
 *
 * Behaviour is unchanged from the shipped browser model
 * (lib/workspaceTabs.ts): in-content navigation re-points the ACTIVE tab,
 * only a sidebar click spawns/activates, and Ctrl/Cmd+click falls through
 * to a real browser window — which then keeps its own per-window company
 * and its own strip (lib/activeCompany.ts).
 *
 * This component still owns the recordWorkspaceVisit effect — TopNavbar is
 * mounted (CSS-hidden) below lg, so recording keeps working at every width
 * exactly as it did when the strip was its own bar.
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
      className="thin-scroll flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const label = workspaceTabLabel(sectionKeyFor(tab.href));
        return (
          <div
            key={tab.id}
            className={cn(
              "group relative flex shrink-0 items-center transition-colors",
              isActive ? "text-primary-ink" : "text-ink-secondary hover:text-ink",
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
                "flex max-w-[13rem] items-center self-center truncate py-2 pl-[15px] pr-0.5 text-[13px] leading-none",
                isActive ? "font-semibold" : "font-medium",
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
                "mr-1.5 flex h-[18px] w-[18px] items-center justify-center self-center rounded-[5px] transition-colors hover:bg-surface-2 hover:text-ink-secondary",
                isActive ? "text-ink-muted" : "text-transparent group-hover:text-ink-muted",
              )}
            >
              <X size={11} strokeWidth={2.5} />
            </button>
            {/* 2b active affordance: 2.5px petrol underline on the bar's
                bottom edge, inset 11px each side per the mock. */}
            {isActive && (
              <span className="absolute inset-x-[11px] bottom-0 h-[2.5px] rounded-[2px] bg-primary" />
            )}
          </div>
        );
      })}
    </div>
  );
}
