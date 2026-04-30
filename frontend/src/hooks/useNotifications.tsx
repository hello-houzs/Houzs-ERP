import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";

// ── Types ────────────────────────────────────────────────────

export interface NotificationItem {
  id: number;
  project_id: number;
  project_code: string | null;
  project_name: string | null;
  brand: string | null;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  user_email: string | null;
  user_profile_pic_r2_key: string | null;
  created_at: string;
  /** Project's event start date — joined in by the notifications
   *  query so the floating chat list can show the event date next to
   *  the project code. ISO yyyy-mm-dd or null for unscheduled. */
  project_start_date: string | null;
  project_end_date: string | null;
}

export interface NotificationsPayload {
  feed: NotificationItem[];
  unread_by_project: Record<number, number>;
  total_unread: number;
  // Houzs Points (mig 055) snapshot — piggybacks the same poll
  // cadence so the topbar chip + gamification page header don't need
  // a second round-trip.
  points_balance?: number;
  gifting_balance?: number;
  current_streak?: number;
}

interface Ctx {
  feed: NotificationItem[];
  unreadByProject: Record<number, number>;
  totalUnread: number;
  reload: () => void;
  /** Event timestamp whenever a fresh payload lands; Profile uses this
   *  to detect new items for browser push firing. */
  lastTick: number;
  // Houzs Points — present once the first poll lands.
  pointsBalance: number;
  giftingBalance: number;
  currentStreak: number;
}

const NotificationsContext = createContext<Ctx>({
  feed: [],
  unreadByProject: {},
  totalUnread: 0,
  reload: () => {},
  lastTick: 0,
  pointsBalance: 0,
  giftingBalance: 0,
  currentStreak: 0,
});

// ── Provider ─────────────────────────────────────────────────
// One poller per app, driven by the signed-in user's session.
// Backs off when the tab is hidden (Page Visibility API) so
// background tabs don't burn requests. Polls every 30s by default.

const POLL_INTERVAL_MS = 30_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [feed, setFeed] = useState<NotificationItem[]>([]);
  const [unreadByProject, setUnread] = useState<Record<number, number>>({});
  const [totalUnread, setTotal] = useState(0);
  const [lastTick, setLastTick] = useState(0);
  const [pointsBalance, setPoints] = useState(0);
  const [giftingBalance, setGifting] = useState(0);
  const [currentStreak, setStreak] = useState(0);
  const timerRef = useRef<number | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!user?.id) return;
    try {
      // Bell shows unread-only. /notifications page fetches its own
      // unfiltered feed separately; the unread_by_project map returned
      // here is the same either way and still drives the list dots.
      const r = await api.get<NotificationsPayload>(
        "/api/notifications?unread=1&limit=20"
      );
      setFeed(r.feed);
      setUnread(r.unread_by_project);
      setTotal(r.total_unread);
      setLastTick(Date.now());
      if (typeof r.points_balance === "number") setPoints(r.points_balance);
      if (typeof r.gifting_balance === "number") setGifting(r.gifting_balance);
      if (typeof r.current_streak === "number") setStreak(r.current_streak);
    } catch {
      // Swallow — polling error shouldn't noise the UI. Next tick retries.
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setFeed([]);
      setUnread({});
      setTotal(0);
      return;
    }
    fetchOnce();
    function schedule() {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (document.hidden) return;
      timerRef.current = window.setTimeout(async () => {
        await fetchOnce();
        schedule();
      }, POLL_INTERVAL_MS);
    }
    schedule();
    function onVis() {
      if (!document.hidden) {
        fetchOnce();
      }
      schedule();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [user?.id, fetchOnce]);

  return (
    <NotificationsContext.Provider
      value={{
        feed,
        unreadByProject,
        totalUnread,
        reload: fetchOnce,
        lastTick,
        pointsBalance,
        giftingBalance,
        currentStreak,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): Ctx {
  return useContext(NotificationsContext);
}
