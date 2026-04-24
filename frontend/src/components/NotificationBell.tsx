import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { cn, relativeTime } from "../lib/utils";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications";

interface Props {
  collapsed: boolean;
  /** Where the popover should appear relative to the bell button.
   *  "down" anchors the popover below the button (top navbar usage);
   *  "up" anchors it above (sidebar usage, where the bell sits near
   *  the bottom of the screen). Defaults to "down". */
  direction?: "up" | "down";
  /** Horizontal edge the popover aligns to. "end" is the right side
   *  of the button (top-navbar — prevents overflow off the right edge
   *  of the viewport). Defaults to "start". */
  align?: "start" | "end";
}

/**
 * Notification bell + popover. Click opens a list of the latest
 * activity on the user's projects. Visible count is the per-project
 * unread aggregate, capped at 99+. Polls itself via the shared
 * NotificationsProvider — this component is display-only.
 */
export function NotificationBell({
  collapsed,
  direction = "down",
  align = "start",
}: Props) {
  const { feed, totalUnread } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const countLabel = totalUnread > 99 ? "99+" : String(totalUnread);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${totalUnread ? ` · ${countLabel} unread` : ""}`}
        title="Notifications"
        className={cn(
          "relative inline-flex items-center rounded-md text-sidebar-ink-muted transition-colors hover:bg-sidebar-hover hover:text-accent",
          collapsed ? "h-9 w-9 justify-center" : "h-9 w-full gap-2 px-3"
        )}
      >
        <Bell size={16} />
        {!collapsed && (
          <span className="flex-1 text-left text-[12px] font-medium">
            Notifications
          </span>
        )}
        {totalUnread > 0 && (
          <span
            className={cn(
              "flex items-center justify-center rounded-full bg-err font-mono text-[9px] font-bold text-white shadow-sm",
              collapsed
                ? "absolute right-1.5 top-1.5 h-4 min-w-[16px] px-1"
                : "h-4 min-w-[18px] px-1"
            )}
          >
            {countLabel}
          </span>
        )}
      </button>

      {open && (
        <BellPopover
          feed={feed}
          onNavigate={() => setOpen(false)}
          direction={direction}
          align={align}
        />
      )}
    </div>
  );
}

function BellPopover({
  feed,
  onNavigate,
  direction,
  align,
}: {
  feed: NotificationItem[];
  onNavigate: () => void;
  direction: "up" | "down";
  align: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "absolute z-40 w-[320px] overflow-hidden rounded-md border border-border bg-surface shadow-slab",
        "max-h-[70vh] flex flex-col",
        direction === "down" ? "top-full mt-2" : "bottom-full mb-2",
        align === "end" ? "right-0" : "left-0"
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
          Recent Activity
        </span>
        {feed.length > 0 && (
          <span className="font-mono text-[10px] text-ink-muted">
            {feed.length}
          </span>
        )}
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto">
        {feed.length === 0 ? (
          <div className="px-4 py-8 text-center text-[11px] text-ink-muted">
            Nothing new. You're caught up.
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {feed.map((item) => (
              <li key={item.id}>
                <Link
                  to={`/projects/${item.project_id}`}
                  onClick={onNavigate}
                  className="block px-3 py-2 transition-colors hover:bg-bg/50"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[11.5px] font-semibold text-ink">
                      {item.project_code || "Project"}
                      {item.brand && (
                        <span className="ml-1.5 font-mono text-[9.5px] font-normal text-ink-muted">
                          {item.brand}
                        </span>
                      )}
                    </span>
                    <span
                      className="shrink-0 font-mono text-[9.5px] text-ink-muted"
                      title={item.created_at}
                    >
                      {relativeTime(item.created_at)}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-secondary">
                    {renderActivityLine(item)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One-line summary of an activity row. Mirrors the chat system-row
 *  copy, just flattened for the bell. */
function renderActivityLine(a: NotificationItem): string {
  const who = a.user_name ? `${a.user_name}: ` : "";
  switch (a.action) {
    case "note":
      return `${who}${a.note || "…"}`;
    case "stage_change":
      return `${who}Stage ${a.from_value || "?"} → ${a.to_value || "?"}`;
    case "created":
      return `${who}Created the project`;
    case "checklist_status":
      return `${who}${a.note || "Updated checklist"}`;
    case "checklist_add":
      return `${who}Added a checklist item`;
    case "checklist_remove":
      return `${who}Removed a checklist item`;
    case "finance_edit":
      return `${who}Updated finance`;
    case "archived":
      return `${who}Archived the project`;
    case "restored":
      return `${who}Restored the project`;
    default:
      return `${who}${a.action}${a.note ? ` · ${a.note}` : ""}`;
  }
}
