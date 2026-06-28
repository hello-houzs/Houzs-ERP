import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Megaphone,
  AlertTriangle,
  ShieldCheck,
  BookOpen,
  Check,
  X,
} from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/utils";

// ────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — top-of-app strip that surfaces the latest active
// announcement targeted at the current user, with a "Got it" ack button.
// Polls every 60s. Hidden when no announcement matches or when the user has
// already acknowledged it (and the office hasn't re-popped via Remind).
//
// Backend: GET /api/announcements/banner -> { data: Announcement[], ackedIds }
// Ack:     POST /api/announcements/:id/ack
// ────────────────────────────────────────────────────────────────────────────

type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

type Announcement = {
  id: string;
  title: string;
  body: string;
  createdAt: string | null;
  remindedAt: string | null;
  category?: AnnouncementCategory;
};

type BannerResponse = {
  success?: boolean;
  data?: Announcement[];
  ackedIds?: string[];
};

const POLL_MS = 60_000;

const CATEGORY_META: Record<
  AnnouncementCategory,
  { Icon: typeof Megaphone; bandCls: string; iconCls: string }
> = {
  GENERAL: {
    Icon: Megaphone,
    bandCls: "border-accent/40 bg-accent-soft/40",
    iconCls: "bg-accent/15 text-accent",
  },
  WARNING: {
    Icon: AlertTriangle,
    bandCls: "border-err/40 bg-err/5",
    iconCls: "bg-err/15 text-err",
  },
  SOP: {
    Icon: ShieldCheck,
    bandCls: "border-accent/40 bg-accent-soft/40",
    iconCls: "bg-accent/15 text-accent",
  },
  LEARNING: {
    Icon: BookOpen,
    bandCls: "border-primary/40 bg-primary/5",
    iconCls: "bg-primary/15 text-primary",
  },
};

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

export function AnnouncementBanner() {
  const { user } = useAuth();
  const [data, setData] = useState<Announcement[]>([]);
  const [serverAcked, setServerAcked] = useState<Set<string>>(new Set());
  const [localAcks, setLocalAcks] = useState<Record<string, number>>(() =>
    readLocalAcks(),
  );
  const [dismissedThisSession, setDismissedThisSession] = useState<
    Set<string>
  >(() => new Set());

  const reload = useCallback(async () => {
    if (!user || !user.id) return;
    try {
      const r = await api.get<BannerResponse>("/api/announcements/banner");
      setData(r.data ?? []);
      setServerAcked(new Set(r.ackedIds ?? []));
    } catch {
      // Silent — the banner is best-effort and must not bubble fetch errors.
    }
  }, [user]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  // Reconcile server ackedIds INTO the local map (additive). Never delete a
  // local entry — the server is the lagging side; a flaky ack POST must not
  // cause an endless re-pop loop.
  useEffect(() => {
    if (serverAcked.size === 0) return;
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
    for (const a of data) {
      if (dismissedThisSession.has(a.id)) continue;
      const localAt = localAcks[a.id];
      if (localAt == null) return a; // never acked here
      if (isRemindedSince(a.remindedAt, localAt)) return a; // re-pop
      // else: already acked — skip
    }
    return null;
  }, [data, dismissedThisSession, localAcks]);

  if (!current) return null;

  async function ack(a: Announcement) {
    const now = Date.now();
    setLocalAcks((prev) => {
      const next = { ...prev, [a.id]: now };
      writeLocalAcks(next);
      return next;
    });
    setDismissedThisSession((prev) => {
      const next = new Set(prev);
      next.add(a.id);
      return next;
    });
    try {
      await api.post(`/api/announcements/${a.id}/ack`);
    } catch {
      // Best-effort: the local stamp keeps the banner dismissed even if the
      // server didn't get the ack. The next reload will reconcile.
    }
  }

  const meta = CATEGORY_META[current.category ?? "GENERAL"];
  const Icon = meta.Icon;

  return (
    <div
      className={cn(
        "border-b px-3 py-2.5 text-ink",
        meta.bandCls,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex w-full max-w-6xl items-start gap-2.5">
        <div
          className={cn(
            "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full",
            meta.iconCls,
          )}
        >
          <Icon size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight text-ink">
            {current.title}
          </div>
          {current.body && (
            <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-secondary">
              {current.body}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void ack(current)}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2.5 text-[11.5px] font-semibold text-ink hover:border-accent/40 hover:text-accent"
        >
          <Check size={12} />
          Got it
        </button>
      </div>
    </div>
  );
}
