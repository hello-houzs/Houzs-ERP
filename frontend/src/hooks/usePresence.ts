import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { ActiveMember, PresenceResponse } from "../types";

const HEARTBEAT_MS = 30_000;

/**
 * Tracks who else is currently using the workspace via a 30-second heartbeat.
 * The browser pings POST /api/presence/heartbeat to mark itself "alive", and
 * polls GET /api/presence on the same cadence to fetch the current active list.
 * The heartbeat only fires while the tab is visible.
 *
 * SINGLETON: usePresence is mounted by more than one component at once
 * (PresenceIndicator in the top bar + PresencePanel in the sidebar). Previously
 * each mount ran its own poll, so every page fired 2+ GET /api/presence AND
 * 2+ POST heartbeat. This module-level singleton runs ONE poll + heartbeat and
 * fans the result out to all consumers, so N mounts cost one request per tick.
 */

let sharedMembers: ActiveMember[] = [];
let sharedLoading = true;
let poller: number | undefined;
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

async function fetchActive(): Promise<void> {
  try {
    const res = await api.get<PresenceResponse>("/api/presence");
    sharedMembers = res.active;
  } catch {
    // Network blip or 401 — keep the last known list, don't clear.
  } finally {
    sharedLoading = false;
    emit();
  }
}

async function beat(): Promise<void> {
  try {
    await api.post("/api/presence/heartbeat");
  } catch {
    // ignore — next interval will retry
  }
}

async function tick(): Promise<void> {
  // Only beat when the tab is visible — invisible tabs shouldn't count.
  if (document.visibilityState === "visible") await beat();
  await fetchActive();
}

function onVisibility(): void {
  // Re-tick the moment the tab becomes visible so a returning user re-appears
  // without waiting up to 30s.
  if (document.visibilityState === "visible") void tick();
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  void tick();
  poller = window.setInterval(() => void tick(), HEARTBEAT_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

function stopIfIdle(): void {
  if (listeners.size > 0) return;
  started = false;
  if (poller) window.clearInterval(poller);
  poller = undefined;
  document.removeEventListener("visibilitychange", onVisibility);
}

export function usePresence(): { members: ActiveMember[]; loading: boolean } {
  const { user } = useAuth();
  const [, force] = useState(0);

  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    if (user) ensureStarted();
    return () => {
      listeners.delete(l);
      stopIfIdle();
    };
  }, [user]);

  return { members: sharedMembers, loading: sharedLoading };
}
