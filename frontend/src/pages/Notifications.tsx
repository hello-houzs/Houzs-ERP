import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { ExpandableText } from "../components/ExpandableText";
import { ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";
import {
  useNotifications,
  type NotificationItem,
} from "../hooks/useNotifications";

type FilterMode = "all" | "unread";

interface FetchResponse {
  feed: NotificationItem[];
  unread_by_project: Record<number, number>;
  total_unread: number;
  has_more: boolean;
}

const PAGE_SIZE = 30;

export function Notifications() {
  const { totalUnread, reload: reloadBell } = useNotifications();
  const [mode, setMode] = useState<FilterMode>("unread");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (mode: FilterMode, nextOffset: number, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(nextOffset),
        });
        if (mode === "unread") qs.set("unread", "1");
        const r = await api.get<FetchResponse>(`/api/notifications?${qs}`);
        setItems((prev) => (replace ? r.feed : [...prev, ...r.feed]));
        setHasMore(r.has_more);
        setOffset(nextOffset + r.feed.length);
      } catch (e: any) {
        setError(e?.message || "Failed to load notifications");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Reload on mode change (also resets offset). Also refreshes the
  // shared bell count so it reflects what the user's looking at.
  useEffect(() => {
    setItems([]);
    setOffset(0);
    fetchPage(mode, 0, true);
    reloadBell();
  }, [mode, fetchPage, reloadBell]);

  function loadMore() {
    if (loading || !hasMore) return;
    fetchPage(mode, offset, false);
  }

  return (
    <div>
      <PageHeader
        eyebrow="Activity"
        title="Notifications"
        description="Everything that happened on the projects you can see. Unread is scoped per-project — opening a project's chat marks it read."
      />

      {/* ── Filter tabs ─────────────────────────────────── */}
      <div className="mb-5 flex items-center gap-1 rounded-md border border-border bg-surface p-1 w-fit">
        <FilterButton
          active={mode === "unread"}
          onClick={() => setMode("unread")}
        >
          Unread
          {totalUnread > 0 && (
            <span
              className={cn(
                "ml-2 inline-flex items-center justify-center rounded-full px-1.5 font-mono text-[9.5px] font-bold",
                mode === "unread"
                  ? "bg-white/30 text-white"
                  : "bg-err text-white"
              )}
            >
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
        </FilterButton>
        <FilterButton active={mode === "all"} onClick={() => setMode("all")}>
          All
        </FilterButton>
      </div>

      {/* ── Feed ────────────────────────────────────────── */}
      {error && (
        <div className="mb-4 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
          {error}
        </div>
      )}

      {items.length === 0 && !loading ? (
        <EmptyState
          message={
            mode === "unread"
              ? "Nothing unread. You're caught up."
              : "No activity yet on your projects."
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
          {items.map((a) => (
            <li
              key={a.id}
              className="border-b border-border-subtle last:border-b-0"
            >
              <Link
                to={`/projects/${a.project_id}`}
                className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-bg/40"
              >
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[10px] font-bold text-accent-ink">
                  {(a.user_name || a.project_name || "?").slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[12.5px] font-semibold text-ink">
                      {a.project_name || "Project"}
                    </span>
                    {a.brand && (
                      <span className="font-mono text-[9.5px] text-ink-muted">
                        {a.brand}
                      </span>
                    )}
                    <span
                      className="ml-auto shrink-0 font-mono text-[10px] text-ink-muted"
                      title={a.created_at}
                    >
                      {relativeTime(a.created_at)}
                    </span>
                  </div>
                  <ExpandableText
                    text={summarise(a)}
                    lines={2}
                    className="mt-0.5 text-[12px] text-ink-secondary"
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-4 py-2 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {loading && items.length === 0 && (
        <div className="mt-2">
          <ListSkeleton rows={5} />
        </div>
      )}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center rounded px-3 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-wider transition-colors",
        active
          ? "bg-accent text-white"
          : "text-ink-secondary hover:bg-bg/60 hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}

function summarise(a: NotificationItem): string {
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
