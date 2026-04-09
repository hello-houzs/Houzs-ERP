import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { ActiveMember, PresenceResponse } from "../types";

const HEARTBEAT_MS = 30_000;

/**
 * Tracks who else is currently using the workspace via a 30-second
 * heartbeat. The browser pings POST /api/presence/heartbeat to mark
 * itself "alive", and polls GET /api/presence on the same cadence to
 * fetch the current active list.
 *
 * The heartbeat only fires while the tab is visible — minimized
 * tabs and background windows stop pinging, which means inactive
 * users naturally roll off after the 2-minute server window.
 */
export function usePresence(): { members: ActiveMember[]; loading: boolean } {
  const { user } = useAuth();
  const [members, setMembers] = useState<ActiveMember[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchActive = useCallback(async () => {
    try {
      const res = await api.get<PresenceResponse>("/api/presence");
      setMembers(res.active);
    } catch {
      // Network blip or 401 — keep the last known list, don't clear.
    } finally {
      setLoading(false);
    }
  }, []);

  const beat = useCallback(async () => {
    try {
      await api.post("/api/presence/heartbeat");
    } catch {
      // ignore — next interval will retry
    }
  }, []);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      if (cancelled) return;
      // Only beat when the tab is visible — invisible tabs shouldn't
      // count toward presence.
      if (document.visibilityState === "visible") {
        await beat();
      }
      await fetchActive();
    }

    // Kick off immediately on mount, then on a fixed interval.
    tick();
    timer = window.setInterval(tick, HEARTBEAT_MS);

    // Re-tick the moment the tab becomes visible again, so a user
    // who switches back doesn't have to wait up to 30s to re-appear.
    function onVisibility() {
      if (document.visibilityState === "visible") tick();
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user, beat, fetchActive]);

  return { members, loading };
}
