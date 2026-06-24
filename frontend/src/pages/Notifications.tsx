import { Link } from "react-router-dom";
import { Bell, RotateCcw } from "lucide-react";
import { relativeTime } from "../lib/utils";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications";
import { Avatar } from "../components/Avatar";

/**
 * Notifications page. The mobile Inbox tab and the desktop bell's "view
 * all" both land here. Renders the shared NotificationsProvider feed (the
 * same activity rows the bell popover shows) as a full-screen list, so
 * tapping Inbox opens a real screen instead of a 404.
 *
 * Display-only — the feed polls itself via the provider. Each row links
 * to its project, mirroring the bell popover.
 */
export function Notifications() {
  const { feed, totalUnread, reload } = useNotifications();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-accent-soft/60 text-accent">
            <Bell size={17} strokeWidth={2.2} />
          </span>
          <div>
            <h1 className="font-display text-[18px] font-extrabold leading-tight text-ink">
              Notifications
            </h1>
            <p className="text-[11.5px] text-ink-muted">
              {totalUnread > 0
                ? `${totalUnread > 99 ? "99+" : totalUnread} unread`
                : "You're caught up"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => reload()}
          aria-label="Refresh notifications"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-ink-muted transition-colors hover:border-accent/40 hover:text-accent"
        >
          <RotateCcw size={15} />
        </button>
      </header>

      {feed.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-4 py-12 text-center text-[12px] text-ink-muted shadow-stone">
          Nothing new. You're caught up.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {feed.map((item) => (
            <li key={item.id}>
              <Link
                to={`/projects/${item.project_id}`}
                className="flex gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-stone transition-colors hover:border-accent/40 hover:bg-bg/40"
              >
                <Avatar
                  userId={item.user_id}
                  hasImage={item.user_profile_pic_r2_key}
                  name={item.user_name}
                  email={item.user_email}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12.5px] font-semibold text-ink">
                      {item.project_name || "Project"}
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
                  <div className="mt-0.5 text-[12px] text-ink-secondary">
                    {renderActivityLine(item)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One-line summary of an activity row. Mirrors the bell popover copy. */
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
