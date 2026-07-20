import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";

// App-wide un-acked SYSTEM-notice count (scan / service-case per-user notices —
// the actionable ones the Announcements list excludes after B1). Drives the
// GLOBAL unread badge on the Announcements entry (the Profile bottom tab + the
// Profile > Announcements row) so a phone user sees a new service case without
// opening the screen. Shares the `scope=system` query KEY with the
// MobileAnnouncements bell, so React Query fetches it ONCE; polls 30s (the
// notifications cadence) so the badge stays live app-wide. Fail-soft: any
// hiccup just yields 0 (no badge).
export function useSystemNoticeUnread(): number {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ["mobile-announcements", "system"],
    queryFn: () =>
      api.get<{ data?: { id: string }[]; ackedIds?: string[] }>(
        "/api/announcements/banner?scope=system",
      ),
    staleTime: 30_000,
    refetchInterval: 30_000,
    enabled: !!user?.id,
  });
  const acked = new Set(data?.ackedIds ?? []);
  return (data?.data ?? []).filter((a) => !acked.has(a.id)).length;
}
