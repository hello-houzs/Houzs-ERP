import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  MessageSquare,
  X,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api } from "../api/client";
import { ProjectChat } from "./ProjectChat";
import { cn, formatDate, relativeTime } from "../lib/utils";

/**
 * Bottom-right floating chat. Lets the user triage active project
 * chats and reply without leaving the page they're on. Driven entirely
 * by `useNotifications` — no extra fetches needed for the list view.
 *
 * Hidden on /projects/:id (the same chat is already in the detail
 * aside) and for users without `projects.read`. Driver-only users
 * never reach Layout, so this widget never renders for them.
 */
export function FloatingChatWidget() {
  const { can, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const notifs = useNotifications();
  const [open, setOpen] = useLocalStorage<boolean>("floating-chat:open", false);
  // Selected project id when in chat view; null = list view.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string>("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);

  // Reset to list view every time the panel opens.
  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setSelectedLabel("");
    }
  }, [open]);

  // The bell context fetches `?unread=1` only — useful for badges, but
  // it leaves the FAB list empty as soon as the user catches up. We
  // need the *full* recent feed here so projects with ongoing chat
  // still surface even when read. Cross-reference the bell's
  // `unreadByProject` for the per-row chip.
  const [recentFeed, setRecentFeed] = useState<NotificationItem[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const fetchRecent = useCallback(async () => {
    if (!user?.id) return;
    setFeedLoading(true);
    try {
      const r = await api.get<{ feed: NotificationItem[] }>(
        "/api/notifications?limit=50"
      );
      setRecentFeed(r.feed ?? []);
    } catch {
      // Silent — list will fall back to whatever's in unreadByProject.
    } finally {
      setFeedLoading(false);
    }
  }, [user?.id]);
  // Refetch when the panel opens and whenever the bell ticks (so a
  // newly-arrived message updates the list while the panel is open).
  useEffect(() => {
    if (!open) return;
    fetchRecent();
  }, [open, fetchRecent, notifs.lastTick]);

  // Close on Esc + click-outside.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (fabRef.current?.contains(target)) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open, setOpen]);

  // Build the active-chats list from the notifications context. Union
  // of (a) projects with unread + (b) projects appearing in the recent
  // feed. Sort: unread desc, then most-recent activity. Cap at 12.
  type Row = {
    project_id: number;
    project_code: string | null;
    project_name: string | null;
    project_start_date: string | null;
    project_end_date: string | null;
    last_action: string;
    last_note: string | null;
    last_user: string | null;
    last_at: string;
    unread: number;
  };
  const rows: Row[] = useMemo(() => {
    const byProject = new Map<number, Row>();
    // Primary source: the *full* recent feed (read or unread). This is
    // why the FAB list isn't empty just because the user caught up.
    for (const n of recentFeed) {
      const existing = byProject.get(n.project_id);
      if (!existing || n.created_at > existing.last_at) {
        byProject.set(n.project_id, {
          project_id: n.project_id,
          project_code: n.project_code,
          project_name: n.project_name,
          project_start_date: n.project_start_date,
          project_end_date: n.project_end_date,
          last_action: n.action,
          last_note: n.note,
          last_user: n.user_name,
          last_at: n.created_at,
          unread: notifs.unreadByProject[n.project_id] ?? 0,
        });
      }
    }
    // Anything in the bell's unread map that hasn't appeared in the
    // recent feed yet (edge case: user opened the panel before the
    // recent fetch returned). Keeps badges accurate.
    for (const [pidStr, count] of Object.entries(notifs.unreadByProject)) {
      const pid = parseInt(pidStr, 10);
      if (byProject.has(pid)) continue;
      byProject.set(pid, {
        project_id: pid,
        project_code: null,
        project_name: null,
        project_start_date: null,
        project_end_date: null,
        last_action: "",
        last_note: null,
        last_user: null,
        last_at: "",
        unread: count,
      });
    }
    const list = Array.from(byProject.values());
    list.sort(
      (a, b) =>
        b.unread - a.unread || (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0)
    );
    return list.slice(0, 15);
  }, [recentFeed, notifs.unreadByProject]);

  // ── Visibility gates ─────────────────────────────────────
  if (!user) return null;
  if (!can("projects.read")) return null;
  // The project detail page already mounts a chat in the aside;
  // duplicating it here would just be confusing chrome.
  if (/^\/projects\/[^/]+$/.test(location.pathname)) return null;

  function openChat(row: Row) {
    setSelectedId(row.project_id);
    setSelectedLabel(
      row.project_code
        ? `${row.project_code} · ${row.project_name ?? ""}`.trim()
        : row.project_name ?? `Project #${row.project_id}`
    );
  }

  function gotoProject(pid: number) {
    setOpen(false);
    navigate(`/projects/${pid}`);
  }

  const totalUnread = notifs.totalUnread;
  const unreadLabel = totalUnread > 9 ? "9+" : String(totalUnread);

  const node = (
    <>
      {/* Floating action button (bottom-right) */}
      <button
        ref={fabRef}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={
          totalUnread > 0
            ? `Active chats — ${totalUnread} unread`
            : "Active chats"
        }
        title={
          totalUnread > 0
            ? `${totalUnread} unread chat ${totalUnread === 1 ? "message" : "messages"}`
            : "Active chats"
        }
        className={cn(
          // On mobile the FAB lifts above the bottom tab rail (h-14)
          // plus iOS safe-area; on lg+ it sits at the standard
          // bottom-right corner since the rail is hidden.
          "fixed right-4 z-40 inline-flex items-center justify-center rounded-full bg-accent text-white shadow-slab transition-all hover:scale-105 hover:bg-accent-hover",
          "h-12 w-12 lg:h-14 lg:w-14 lg:right-5",
          "bottom-[calc(theme(spacing.20)+env(safe-area-inset-bottom))] lg:bottom-5",
          open && "scale-95"
        )}
      >
        <MessageSquare size={22} strokeWidth={2.2} />
        {totalUnread > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-err px-1 font-mono text-[10px] font-bold text-white shadow-sm ring-2 ring-bg">
            {unreadLabel}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          ref={panelRef}
          className="fixed z-40 flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-slab
                     bottom-24 right-5 h-[540px] w-[360px]
                     max-sm:inset-x-2 max-sm:top-16 max-sm:h-auto max-sm:w-auto
                     max-sm:bottom-[calc(theme(spacing.20)+env(safe-area-inset-bottom))]"
          role="dialog"
          aria-label="Active chats"
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border bg-bg/60 px-3 py-2.5">
            {selectedId !== null ? (
              <>
                <button
                  onClick={() => setSelectedId(null)}
                  className="rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
                  aria-label="Back to active chats"
                  title="Back"
                >
                  <ArrowLeft size={14} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-ink">
                    {selectedLabel || "Project chat"}
                  </div>
                </div>
                <button
                  onClick={() => gotoProject(selectedId)}
                  className="inline-flex items-center gap-0.5 rounded px-1.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent hover:bg-accent-soft"
                  title="Open project page"
                >
                  Open <ChevronRight size={11} />
                </button>
              </>
            ) : (
              <>
                <MessageSquare size={14} className="text-accent" />
                <div className="flex-1 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                  Active Chats
                </div>
                {totalUnread > 0 && (
                  <span className="rounded-full bg-err/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-err">
                    {totalUnread} unread
                  </span>
                )}
              </>
            )}
            <button
              onClick={() => setOpen(false)}
              className="rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
              aria-label="Close"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>

          {/* Body — list view or chat view */}
          {selectedId === null ? (
            <div className="thin-scroll flex-1 overflow-y-auto">
              {rows.length === 0 ? (
                <div className="px-4 py-10 text-center text-[11.5px] text-ink-muted">
                  <div>
                    {feedLoading
                      ? "Loading recent chats…"
                      : "No recent chat activity yet."}
                  </div>
                  <Link
                    to="/projects"
                    onClick={() => setOpen(false)}
                    className="mt-2 inline-block font-semibold text-accent hover:underline"
                  >
                    Browse projects →
                  </Link>
                </div>
              ) : (
                <ul className="divide-y divide-border-subtle">
                  {rows.map((r) => (
                    <li key={r.project_id}>
                      <button
                        onClick={() => openChat(r)}
                        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-bg/60"
                      >
                        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[10px] font-bold uppercase text-accent-ink">
                          {(r.project_code || r.project_name || "?")
                            .slice(0, 2)
                            .toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div
                              className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-secondary"
                              title={
                                r.project_start_date
                                  ? r.project_end_date &&
                                    r.project_end_date !== r.project_start_date
                                    ? `Event ${formatDate(r.project_start_date)} – ${formatDate(r.project_end_date)}`
                                    : `Event ${formatDate(r.project_start_date)}`
                                  : undefined
                              }
                            >
                              <span className="truncate">
                                {r.project_code || `#${r.project_id}`}
                              </span>
                              {r.project_start_date && (
                                <>
                                  <span className="text-ink-muted/50">—</span>
                                  <span className="shrink-0 text-ink-muted">
                                    {formatDate(r.project_start_date)}
                                  </span>
                                </>
                              )}
                            </div>
                            {r.last_at && (
                              <span className="shrink-0 font-mono text-[9px] text-ink-muted">
                                {relativeTime(r.last_at)}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-[12px] font-semibold text-ink">
                            {r.project_name || "(untitled)"}
                          </div>
                          {(r.last_note || r.last_user) && (
                            <div
                              className="mt-0.5 truncate text-[10.5px] text-ink-muted"
                              title={
                                r.last_note
                                  ? r.last_user
                                    ? `${r.last_user}: ${r.last_note}`
                                    : r.last_note
                                  : r.last_user || undefined
                              }
                            >
                              {r.last_user && (
                                <span className="font-medium text-ink-secondary">
                                  {r.last_user}
                                </span>
                              )}
                              {r.last_user && r.last_note && (
                                <span className="text-ink-muted/60"> · </span>
                              )}
                              {r.last_note && <span>{r.last_note}</span>}
                            </div>
                          )}
                        </div>
                        {r.unread > 0 && (
                          <span className="shrink-0 self-center rounded-full bg-err px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-white">
                            {r.unread}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-border-subtle bg-bg/40 px-3 py-2 text-center">
                <Link
                  to="/notifications"
                  onClick={() => setOpen(false)}
                  className="font-mono text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
                >
                  All notifications →
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-hidden p-2">
              <ProjectChat
                projectId={selectedId}
                canPost={can("projects.write") || can("projects.chat")}
                toast={toast}
                height="100%"
                onPosted={() => notifs.reload()}
              />
            </div>
          )}
        </div>
      )}
    </>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
