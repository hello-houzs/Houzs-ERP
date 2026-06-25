import { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import type { useToast } from "../hooks/useToast";
import { cn, relativeTime } from "../lib/utils";
import { Avatar } from "./Avatar";

// ── Types ────────────────────────────────────────────────────
// Mirrors the ActivityRow shape that /api/projects/:id/activity
// returns. Kept in this module so consumers (project detail aside,
// floating chat widget) don't need to import a project-page-local
// type.

export interface ActivityRow {
  id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  user_email?: string | null;
  user_profile_pic_r2_key?: string | null;
  created_at: string;
}

interface ProjectChatProps {
  projectId: number;
  /** Optional seed history. When omitted the component fetches the
   *  full activity once on mount. The project detail page passes the
   *  pre-loaded activity from its detail response so the chat renders
   *  instantly with no extra round-trip; the floating widget skips it
   *  and lets the component fetch its own. */
  activity?: ActivityRow[];
  canPost: boolean;
  /** Called after a successful send so the parent can reload its own
   *  data (e.g. detail panel rollups). Optional — no parent reload is
   *  needed in the floating widget. */
  onPosted?: () => void;
  toast: ReturnType<typeof useToast>;
  /** CSS height value applied to the outer container. Defaults to
   *  "440px" to match the original project-detail aside dimensions. */
  height?: string;
}

export function ProjectChat({
  projectId,
  activity,
  canPost,
  onPosted,
  toast,
  height = "440px",
}: ProjectChatProps) {
  const { user: me } = useAuth();
  const notifs = useNotifications();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live-merged message list. Starts from the parent-passed `activity`
  // (or empty when the parent didn't seed) and accrues new rows from
  // the 3s poller. Using a map keyed on activity.id so duplicates
  // (server refetch + poll colliding) don't render twice.
  const [liveById, setLiveById] = useState<Map<number, ActivityRow>>(
    () => new Map((activity ?? []).map((a) => [a.id, a]))
  );
  const [bootstrapped, setBootstrapped] = useState<boolean>(
    () => activity !== undefined
  );

  // Re-seed when the parent sends a fresh activity prop (e.g. after
  // a stage change triggers a full detail reload). New IDs get added;
  // existing ones replaced; nothing is dropped so locally-polled rows
  // that haven't made it into parent yet aren't lost.
  useEffect(() => {
    if (!activity) return;
    setLiveById((prev) => {
      const next = new Map(prev);
      for (const a of activity) next.set(a.id, a);
      return next;
    });
    setBootstrapped(true);
  }, [activity]);

  // Self-fetch path: when the parent didn't pass activity, pull the
  // full history once on mount. After that the polling effect takes
  // over with `since` to keep things minimal.
  useEffect(() => {
    if (activity !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{ data: ActivityRow[] }>(
          `/api/projects/${projectId}/activity`
        );
        if (cancelled) return;
        setLiveById(new Map((r.data ?? []).map((a) => [a.id, a])));
      } catch {
        // Silent — the poller will still try.
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // "N new ↓" chip state — count of messages that arrived while the
  // user was scrolled away from the bottom.
  const [newCount, setNewCount] = useState(0);
  const wasAtBottomRef = useRef(true);

  // Chat UIs read oldest-at-top; stable-sort by created_at then id.
  const messages = useMemo(() => {
    return Array.from(liveById.values()).sort((a, b) => {
      const t = a.created_at.localeCompare(b.created_at);
      return t !== 0 ? t : a.id - b.id;
    });
  }, [liveById]);

  // POST /read when the chat mounts — marks this project as caught up
  // so the notification bell clears its dot. Also ping the notifications
  // context to refetch immediately.
  useEffect(() => {
    (async () => {
      try {
        await api.post(`/api/projects/${projectId}/read`, {});
        notifs.reload();
      } catch {
        // Non-critical; a failed read just means the dot lingers.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Poll for new activity every 3s while the page is visible. Uses the
  // max known created_at as the cursor so we only pull truly-new rows.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (document.hidden) return;
      const maxTs = messages[messages.length - 1]?.created_at;
      if (!maxTs) return;
      try {
        const r = await api.get<{ data: ActivityRow[] }>(
          `/api/projects/${projectId}/activity?since=${encodeURIComponent(maxTs)}`
        );
        if (cancelled) return;
        const incoming = r.data ?? [];
        if (incoming.length === 0) return;
        const addedWhileScrolledUp = wasAtBottomRef.current ? 0 : incoming.length;
        setLiveById((prev) => {
          const next = new Map(prev);
          for (const a of incoming) next.set(a.id, a);
          return next;
        });
        if (addedWhileScrolledUp > 0) {
          setNewCount((c) => c + addedWhileScrolledUp);
        }
        notifs.reload();
      } catch {
        // Silent — the next tick will retry.
      }
    }
    const id = window.setInterval(tick, 3000);
    function onVis() {
      if (!document.hidden) tick();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, messages.length]);

  async function send() {
    const note = draft.trim();
    if (!note || sending) return;
    setSending(true);
    try {
      await api.post(`/api/projects/${projectId}/notes`, { note });
      setDraft("");
      onPosted?.();
      // Mark as read right away — our own send shouldn't light up our bell.
      api.post(`/api/projects/${projectId}/read`, {}).catch(() => {});
      // When self-fetching, refresh history so the new bubble appears
      // before the next 3s poll tick.
      if (activity === undefined) {
        try {
          const r = await api.get<{ data: ActivityRow[] }>(
            `/api/projects/${projectId}/activity`
          );
          setLiveById(new Map((r.data ?? []).map((a) => [a.id, a])));
        } catch {
          // The poller will catch up.
        }
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setNewCount(0);
  }

  // Auto-scroll to bottom on new messages, but only if the user was
  // already near the bottom. Keeps reading-history scroll position
  // intact when bubbles arrive.
  const lastCount = useRef(messages.length);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    wasAtBottomRef.current = atBottom;
    if (messages.length > lastCount.current && atBottom) {
      el.scrollTop = el.scrollHeight;
      setNewCount(0);
    } else if (lastCount.current === 0) {
      // First render — drop to the newest.
      el.scrollTop = el.scrollHeight;
    }
    lastCount.current = messages.length;
  }, [messages.length]);

  // Track scroll position so the poller's "N new" counter knows whether
  // the user is reading live or has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      wasAtBottomRef.current = atBottom;
      if (atBottom) setNewCount(0);
    }
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-md border border-border bg-bg/30"
      style={{ height }}
    >
      {newCount > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[10.5px] font-semibold text-white shadow-slab transition-all hover:bg-primary-ink"
        >
          {newCount} new message{newCount === 1 ? "" : "s"} ↓
        </button>
      )}
      <div
        ref={scrollRef}
        className="thin-scroll flex-1 space-y-2 overflow-y-auto px-3 py-3"
      >
        {!bootstrapped && (
          <div className="py-10 text-center text-[11px] text-ink-muted">
            Loading messages…
          </div>
        )}
        {bootstrapped && messages.length === 0 && (
          <div className="py-10 text-center text-[11px] text-ink-muted">
            No messages yet.
          </div>
        )}
        {messages.map((a, i) => {
          const prev = i > 0 ? messages[i - 1] : null;
          if (a.action !== "note") {
            return <ChatSystemRow key={a.id} a={a} />;
          }
          const isMine = !!me && a.user_id === me.id;
          const samePerson =
            prev && prev.action === "note" && prev.user_id === a.user_id;
          const withinWindow =
            prev &&
            Date.parse(a.created_at) - Date.parse(prev.created_at) <
              5 * 60 * 1000;
          const grouped = !!(samePerson && withinWindow);
          return (
            <ChatBubble key={a.id} a={a} isMine={isMine} grouped={grouped} />
          );
        })}
      </div>

      {canPost ? (
        <div className="flex items-end gap-2 border-t border-border bg-surface px-2.5 py-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message…"
            rows={1}
            className="min-h-[36px] max-h-[120px] flex-1 resize-none rounded-full border border-border bg-bg px-3.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <button
            onClick={send}
            disabled={sending || !draft.trim()}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-white shadow-stone transition-all hover:bg-primary-ink disabled:bg-surface-dim disabled:text-ink-muted disabled:shadow-none"
            title="Send (Enter) · Shift+Enter for new line"
          >
            <Send size={14} />
          </button>
        </div>
      ) : (
        <div className="border-t border-border bg-surface px-3 py-2 text-center text-[10.5px] text-ink-muted">
          Read-only
        </div>
      )}
    </div>
  );
}

// ── Chat row components ─────────────────────────────────────

function ChatSystemRow({ a }: { a: ActivityRow }) {
  return (
    <div className="my-3 flex justify-center">
      <div
        className="max-w-[80%] rounded-full bg-bg/80 px-3 py-1 text-center text-[10.5px] text-ink-muted ring-1 ring-border-subtle"
        title={a.created_at}
      >
        <span className="font-medium">{actionLabel(a.action)}</span>
        {a.from_value && a.to_value && a.from_value !== a.to_value && (
          <span className="ml-1">
            <span className="font-mono">{a.from_value}</span>
            <span className="mx-1 text-ink-muted/70">→</span>
            <span className="font-mono">{a.to_value}</span>
          </span>
        )}
        {a.to_value && !a.from_value && (
          <span className="ml-1 font-mono">{a.to_value}</span>
        )}
        {a.note && <span className="ml-1">· {a.note}</span>}
        {a.user_name && (
          <span className="ml-1 text-ink-muted/80">· {a.user_name}</span>
        )}
        <span className="ml-1.5 font-mono text-ink-muted/70">
          {relativeTime(a.created_at)}
        </span>
      </div>
    </div>
  );
}

function ChatBubble({
  a,
  isMine,
  grouped,
}: {
  a: ActivityRow;
  isMine: boolean;
  grouped: boolean;
}) {
  const name = a.user_name || "Unknown";
  return (
    <div
      className={cn(
        "flex w-full gap-2",
        isMine ? "justify-end" : "justify-start",
        grouped ? "mt-0.5" : "mt-2"
      )}
    >
      {!isMine && (
        <div className="w-8 shrink-0">
          {!grouped && (
            <Avatar
              userId={a.user_id}
              hasImage={a.user_profile_pic_r2_key}
              name={a.user_name}
              email={a.user_email}
              size={32}
            />
          )}
        </div>
      )}
      <div
        className={cn(
          "flex max-w-[75%] flex-col",
          isMine ? "items-end" : "items-start"
        )}
      >
        {!grouped && !isMine && (
          <span className="mb-0.5 px-0.5 text-[10.5px] font-semibold text-ink-secondary">
            {name}
          </span>
        )}
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[12.5px] leading-snug shadow-stone",
            isMine
              ? "rounded-br-sm bg-accent text-white"
              : "rounded-bl-sm bg-surface text-ink ring-1 ring-border-subtle"
          )}
        >
          {a.note}
        </div>
        <span
          className="mt-0.5 px-0.5 font-mono text-[9.5px] text-ink-muted"
          title={a.created_at}
        >
          {relativeTime(a.created_at)}
        </span>
      </div>
    </div>
  );
}

function actionLabel(action: string): string {
  switch (action) {
    case "created":
      return "Project created";
    case "stage_change":
      return "Stage changed";
    case "checklist_status":
      return "Checklist updated";
    case "document_upload":
      return "Document uploaded";
    case "checklist_add":
      return "Checklist item added";
    case "checklist_remove":
      return "Checklist item removed";
    case "finance_edit":
      return "Finance updated";
    case "archived":
      return "Archived";
    case "restored":
      return "Restored";
    case "note":
      return "Message";
    default:
      return action;
  }
}
