import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { AnnAttachment, AnnMediaLayout } from "./AnnouncementMedia";

// ────────────────────────────────────────────────────────────────────────────
// useAnnouncementBanner — the pop-up notice LOGIC, shared by both shells.
//
// It used to live inside components/AnnouncementBanner.tsx, which is mounted
// only in the DESKTOP shell (App.tsx) — so a phone user got no pop-up and no
// alert of any kind for a new announcement (owner 2026-07-21). Rather than
// copy the fetch/ack/dismiss rules into the mobile shell (two divergent
// definitions of "have I seen this?"), everything that is not markup lives
// here and both surfaces render it their own way: desktop keeps its centred
// Tailwind card, mobile draws the .hz-m bottom sheet.
//
// Backend: GET /api/announcements/banner -> { data: Announcement[], ackedIds }
// Ack:     POST /api/announcements/:id/ack
// Neither is gated on announcements.read — ordinary sales staff lack that
// permission and must still receive their own notices.
// ────────────────────────────────────────────────────────────────────────────

export type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

// Machine translations of the notice, as stored on the row and returned by the
// banner endpoint. Spelled out here rather than imported from mobile/mobileI18n
// so this desktop-side module keeps no dependency on the phone shell; the shape
// is what localizeAnnouncement() consumes. Absent for pre-translation rows and
// for any row whose translate call failed — that helper falls back to the
// author's original words.
export type BannerTranslationPair = { title: string; body: string };
export type BannerTranslations = {
  en?: BannerTranslationPair | null;
  ms?: BannerTranslationPair | null;
  zh?: BannerTranslationPair | null;
  bn?: BannerTranslationPair | null;
} | null;

export type BannerAnnouncement = {
  id: string;
  title: string;
  body: string;
  createdAt: string | null;
  remindedAt: string | null;
  category?: AnnouncementCategory;
  attachments?: AnnAttachment[];
  mediaLayout?: AnnMediaLayout;
  translations?: BannerTranslations;
};

export type BannerResponse = {
  success?: boolean;
  data?: BannerAnnouncement[];
  ackedIds?: string[];
};

// Which slice of the feed a surface wants. The backend splits the SAME endpoint
// (routes/announcements.ts /banner): `human` = human-written posts, `system` =
// the actionable per-user scan / service-case notices, absent = both.
export type BannerScope = "all" | "human" | "system";

// ONE React Query key namespace for every /api/announcements/banner read, so
// the desktop pop-up, the mobile pop-up, the mobile Announcements list and the
// mobile unread badge share one cache entry PER SCOPE instead of each fetching
// its own copy. Invalidate the bare prefix to refresh every scope at once.
export const ANNOUNCEMENT_FEED_KEY = ["announcements-feed"] as const;
export function announcementFeedKey(scope: BannerScope): string[] {
  return [...ANNOUNCEMENT_FEED_KEY, scope];
}

const POLL_MS = 60_000;

// Local ack memo so the banner stays dismissed across reloads even before
// the next poll picks up the server's ackedIds.
const LOCAL_ACKS_KEY = "announcements:localAcks";

function readLocalAcks(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LOCAL_ACKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

function writeLocalAcks(next: Record<string, number>) {
  try {
    localStorage.setItem(LOCAL_ACKS_KEY, JSON.stringify(next));
  } catch {
    // non-fatal
  }
}

// "Waved away for now" ids. MODULE-level, not component state: the phone
// unmounts its pop-up whenever the shell navigates, and a notice the user has
// just dismissed must not spring straight back on the next mount. Page-lifetime
// only — nothing is persisted, so it re-surfaces on the next visit exactly as
// the desktop banner always has.
const dismissedThisSession = new Set<string>();

// True when the office reminded the notice AFTER the local ack — i.e. the
// banner should re-surface even though we have a local ack stamp.
function isRemindedSince(
  remindedAt: string | null | undefined,
  ackedAtMs: number | undefined,
): boolean {
  if (!remindedAt || !ackedAtMs) return false;
  const r = Date.parse(remindedAt);
  if (Number.isNaN(r)) return false;
  return r > ackedAtMs;
}

// What the SECONDARY button means for a category. Only the meaning is shared —
// "view" navigates to the announcements surface, which is a different journey
// on each shell (a desktop route vs. pushing the mobile screen), so each
// surface performs it itself.
export function bannerSecondaryKind(
  category: AnnouncementCategory,
): "view" | "dismiss" {
  return category === "WARNING" || category === "SOP" ? "view" : "dismiss";
}

export type UseAnnouncementBanner = {
  /** The notice to pop right now, or null when there is nothing to show. */
  current: BannerAnnouncement | null;
  /** Record the acknowledgement (server + local memo) and hide the notice. */
  ack: (a: BannerAnnouncement) => Promise<void>;
  /** Hide for THIS session only — no ack, so it re-surfaces on the next visit. */
  dismissSession: (a: BannerAnnouncement) => void;
};

export function useAnnouncementBanner(options?: {
  /** Feed slice to pop. Default `all` = exactly what the desktop has always shown. */
  scope?: BannerScope;
  /** Poll cadence. Default 60s (the desktop banner's original interval). */
  pollMs?: number;
}): UseAnnouncementBanner {
  const scope = options?.scope ?? "all";
  const pollMs = options?.pollMs ?? POLL_MS;
  const { user } = useAuth();
  const qc = useQueryClient();
  const [localAcks, setLocalAcks] = useState<Record<string, number>>(() =>
    readLocalAcks(),
  );
  // Render-visible mirror of the module-level dismiss set, SEEDED from it so a
  // remount (the phone unmounting its pop-up on navigation) doesn't forget what
  // the user already waved away.
  const [dismissed, setDismissed] = useState<Set<string>>(
    () => new Set(dismissedThisSession),
  );

  // Silent by design — the banner is best-effort and must never bubble a fetch
  // error into the page (it is mounted at the app root). Any hiccup simply
  // leaves `data` undefined, i.e. no pop-up.
  const { data } = useQuery({
    queryKey: announcementFeedKey(scope),
    queryFn: () =>
      api.get<BannerResponse>(
        scope === "all"
          ? "/api/announcements/banner"
          : `/api/announcements/banner?scope=${scope}`,
      ),
    staleTime: pollMs,
    refetchInterval: pollMs,
    // The desktop banner polled with a plain setInterval, which kept ticking
    // while the tab was hidden; React Query pauses its interval on a hidden tab
    // unless told otherwise. Keeping it on preserves the old behaviour exactly
    // (an operator who leaves the ERP tab open all day still gets the notice).
    refetchIntervalInBackground: true,
    enabled: !!user?.id,
  });

  const rows = useMemo(() => data?.data ?? [], [data]);
  const serverAcked = useMemo(() => data?.ackedIds ?? [], [data]);

  // Reconcile server ackedIds INTO the local map (additive). Never delete a
  // local entry — the server is the lagging side; a flaky ack POST must not
  // cause an endless re-pop loop.
  useEffect(() => {
    if (serverAcked.length === 0) return;
    setLocalAcks((prev) => {
      let changed = false;
      const next = { ...prev };
      const now = Date.now();
      for (const id of serverAcked) {
        if (next[id] == null) {
          next[id] = now;
          changed = true;
        }
      }
      if (changed) writeLocalAcks(next);
      return changed ? next : prev;
    });
  }, [serverAcked]);

  // The current banner = the newest active notice that this device hasn't
  // acked (or that the office has reminded since the local ack). Newest first
  // per the server response.
  const current = useMemo(() => {
    for (const a of rows) {
      if (dismissed.has(a.id)) continue;
      const localAt = localAcks[a.id];
      if (localAt == null) return a; // never acked here
      if (isRemindedSince(a.remindedAt, localAt)) return a; // re-pop
      // else: already acked — skip
    }
    return null;
  }, [rows, dismissed, localAcks]);

  const dismissSession = useCallback((a: BannerAnnouncement) => {
    dismissedThisSession.add(a.id);
    setDismissed(new Set(dismissedThisSession));
  }, []);

  const ack = useCallback(
    async (a: BannerAnnouncement) => {
      const now = Date.now();
      setLocalAcks((prev) => {
        const next = { ...prev, [a.id]: now };
        writeLocalAcks(next);
        return next;
      });
      dismissSession(a);
      try {
        await api.post(`/api/announcements/${a.id}/ack`);
      } catch {
        // Best-effort: the local stamp keeps the banner dismissed even if the
        // server didn't get the ack. The next reload will reconcile.
      }
      // Every scope's ackedIds just changed, so refresh the whole namespace —
      // that is what drops the mobile unread badge immediately instead of
      // leaving a stale count up for a whole poll interval.
      void qc.invalidateQueries({ queryKey: ANNOUNCEMENT_FEED_KEY });
    },
    [dismissSession, qc],
  );

  return { current, ack, dismissSession };
}
