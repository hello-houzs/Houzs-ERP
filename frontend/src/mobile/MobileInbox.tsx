import { useMemo, useState } from "react";
import { api } from "../api/client";
import { relativeTime, parseDate, todayInAppTz } from "../lib/utils";
import {
  useNotifications,
  type NotificationItem,
} from "../hooks/useNotifications";
import "./mobile.css";

/** One-line summary of an activity row. Mirrors the desktop Notifications
 *  page copy so the two surfaces read identically. */
function activityLine(a: NotificationItem): string {
  const who = a.user_name ? `${a.user_name} · ` : "";
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

/**
 * Mobile Inbox (notifications feed). Presentation ported VERBATIM from the
 * owner's mobile design prototype (`#inbox` section + `renderInbox`) using the
 * design system classes now in mobile.css (`.hdr` `.ey` `.card` `.scroll`),
 * wired to the shared NotificationsProvider — the same unread activity rows the
 * desktop bell popover and /notifications page show.
 *
 * "Mark all read" mirrors the desktop chat behaviour: there is no bulk
 * endpoint, so we POST /api/projects/:id/read for every project that still
 * carries an unread count (the same call ProjectChat makes on mount), then
 * reload the feed.
 */
export function MobileInbox({
  onOpen,
  onBack,
}: {
  onOpen?: (item: NotificationItem) => void;
  onBack?: () => void;
}) {
  const { feed, totalUnread, unreadByProject, reload } = useNotifications();
  const [marking, setMarking] = useState(false);

  const { today, earlier } = useMemo(() => {
    const t = todayInAppTz();
    const isToday = (iso: string) => {
      const d = parseDate(iso);
      if (!d) return false;
      return (
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kuala_Lumpur",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(d) === t
      );
    };
    const today: NotificationItem[] = [];
    const earlier: NotificationItem[] = [];
    for (const item of feed) (isToday(item.created_at) ? today : earlier).push(item);
    return { today, earlier };
  }, [feed]);

  const markAll = async () => {
    if (marking) return;
    const ids = Object.entries(unreadByProject)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([id]) => Number(id));
    if (!ids.length) return;
    setMarking(true);
    try {
      await Promise.all(
        ids.map((id) => api.post(`/api/projects/${id}/read`, {}).catch(() => {}))
      );
      await reload();
    } finally {
      setMarking(false);
    }
  };

  // Designer feed layout (#inbox): an "Activity / Inbox" header with a
  // "Mark all read" text action, then Today / Earlier groups where each row is
  // its own card — a leading unread dot, the title, a one-line body, and the
  // relative time. Wired to the shared notifications feed + bulk mark-read.
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        {onBack && (
          <button onClick={onBack} className="back" style={{ marginBottom: 7 }}>
            <span className="chev">{"‹"}</span> Menu
          </button>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="eyebrow">Activity</div>
            <div className="scr-title">Inbox</div>
          </div>
          <button
            onClick={markAll}
            disabled={marking || totalUnread === 0}
            style={{
              background: "none", border: "none", color: "#16695f", fontWeight: 600, fontSize: 12.5,
              cursor: marking || totalUnread === 0 ? "default" : "pointer",
              opacity: totalUnread === 0 ? 0.5 : 1,
            }}
          >
            {marking ? "Marking…" : "Mark all read"}
          </button>
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {feed.length === 0 ? (
          <div className="empty">
            <div className="empty-t">You're all caught up.</div>
            <div className="empty-s">New activity shows up here.</div>
          </div>
        ) : (
          <>
            {today.length > 0 && (
              <div>
                <div className="fld-l" style={{ marginBottom: 8 }}>Today</div>
                {today.map((item) => (
                  <Row key={item.id} item={item} unread={(unreadByProject[item.project_id] ?? 0) > 0} onOpen={onOpen} />
                ))}
              </div>
            )}
            {earlier.length > 0 && (
              <div>
                <div className="fld-l" style={{ marginBottom: 8 }}>Earlier</div>
                {earlier.map((item) => (
                  <Row key={item.id} item={item} unread={(unreadByProject[item.project_id] ?? 0) > 0} onOpen={onOpen} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  item, unread, onOpen,
}: {
  item: NotificationItem;
  unread: boolean;
  onOpen?: (item: NotificationItem) => void;
}) {
  const title = item.project_name || item.project_code || "Project";
  return (
    <div
      className="card"
      style={{ padding: "12px 13px", display: "flex", gap: 10, cursor: onOpen ? "pointer" : "default" }}
      onClick={() => onOpen?.(item)}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: unread ? "#b23a3a" : "transparent", flex: "none", marginTop: 5 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
          {item.brand && (
            <span className="money" style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 400, color: "#9aa093" }}>{item.brand}</span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: "#767b6e", marginTop: 2, lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {activityLine(item)}
        </div>
        <div className="money" style={{ fontSize: 10, color: "#9aa093", marginTop: 3 }} title={item.created_at}>
          {relativeTime(item.created_at)}
        </div>
      </div>
    </div>
  );
}
