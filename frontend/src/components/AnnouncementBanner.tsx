import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Megaphone,
  AlertTriangle,
  ShieldCheck,
  BookOpen,
  Check,
  Play,
  Clock,
  BellOff,
  ArrowRight,
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

const CATEGORY_LABEL: Record<AnnouncementCategory, string> = {
  GENERAL: "Notice",
  WARNING: "Warning",
  SOP: "SOP",
  LEARNING: "Learning",
};

// One colour per category (2026-07-09 redesign — GENERAL and SOP used to
// share brass): GENERAL=petrol, WARNING=red, SOP=brass, LEARNING=trend blue.
// All classes are static literals — Tailwind's content scan can't see
// runtime-composed names like `text-${accent}`, so never build them.
const CATEGORY_META: Record<
  AnnouncementCategory,
  {
    Icon: typeof Megaphone;
    bandCls: string;
    iconCls: string;
    labelCls: string; // category eyebrow above the title
    railCls: string; // 3px colour rail on the left edge
    primaryCls: string; // solid primary button
    primaryLabel: string;
    PrimaryIcon: typeof Check;
    secondaryLabel: string;
    SecondaryIcon: typeof Clock;
  }
> = {
  GENERAL: {
    Icon: Megaphone,
    bandCls: "border-primary/40 bg-primary/5",
    iconCls: "bg-primary/15 text-primary",
    labelCls: "text-primary",
    railCls: "bg-primary",
    primaryCls: "bg-primary text-white hover:bg-primary/90",
    primaryLabel: "Got it",
    PrimaryIcon: Check,
    secondaryLabel: "Remind later",
    SecondaryIcon: Clock,
  },
  WARNING: {
    Icon: AlertTriangle,
    bandCls: "border-err/40 bg-err/5",
    iconCls: "bg-err/15 text-err",
    labelCls: "text-err",
    railCls: "bg-err",
    primaryCls: "bg-err text-white hover:bg-err/90",
    primaryLabel: "Got it",
    PrimaryIcon: Check,
    secondaryLabel: "View details",
    SecondaryIcon: ArrowRight,
  },
  SOP: {
    Icon: ShieldCheck,
    bandCls: "border-accent/40 bg-accent-soft/40",
    iconCls: "bg-accent/15 text-accent",
    labelCls: "text-accent",
    railCls: "bg-accent",
    primaryCls: "bg-accent text-white hover:bg-accent/90",
    primaryLabel: "Acknowledge",
    PrimaryIcon: Check,
    secondaryLabel: "Read SOP",
    SecondaryIcon: ArrowRight,
  },
  LEARNING: {
    Icon: BookOpen,
    bandCls: "border-learning/40 bg-learning/5",
    iconCls: "bg-learning/15 text-learning",
    labelCls: "text-learning",
    railCls: "bg-learning",
    primaryCls: "bg-learning text-white hover:bg-learning/90",
    primaryLabel: "Watch",
    PrimaryIcon: Play,
    secondaryLabel: "Later",
    SecondaryIcon: BellOff,
  },
};

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-MY");
}

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

  // Secondary action per category: WARNING "View details" / SOP "Read SOP"
  // jump to the announcements page; GENERAL "Remind later" / LEARNING "Later"
  // hide the notice for this session only (no ack recorded, so it re-surfaces
  // on the next visit). Plain location.assign, not useNavigate — the banner
  // also renders router-less in design-sync previews.
  function secondary(a: Announcement) {
    const cat = a.category ?? "GENERAL";
    if (cat === "WARNING" || cat === "SOP") {
      window.location.assign("/announcements");
      return;
    }
    setDismissedThisSession((prev) => {
      const next = new Set(prev);
      next.add(a.id);
      return next;
    });
  }

  const category = current.category ?? "GENERAL";
  const meta = CATEGORY_META[category];
  const Icon = meta.Icon;
  const { PrimaryIcon, SecondaryIcon } = meta;

  return (
    <div
      className={cn(
        "relative overflow-hidden border-b px-3 py-2.5 text-ink",
        meta.bandCls,
      )}
      role="status"
      aria-live="polite"
    >
      {/* 3px colour rail on the left edge */}
      <span
        className={cn("absolute left-0 top-0 h-full w-[3px]", meta.railCls)}
      />
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
          {/* category eyebrow · relative time */}
          <div className="mb-0.5 flex items-center gap-2">
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-wide",
                meta.labelCls,
              )}
            >
              {CATEGORY_LABEL[category]}
            </span>
            {current.createdAt && (
              <>
                <span className="h-[3px] w-[3px] rounded-full bg-border" />
                <span className="font-mono text-[11px] text-ink-secondary">
                  {relativeTime(current.createdAt)}
                </span>
              </>
            )}
          </div>
          <div className="text-[13px] font-semibold leading-tight text-ink">
            {current.title}
          </div>
          {current.body && (
            <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-secondary">
              {current.body}
            </p>
          )}
        </div>
        {/* secondary + primary buttons */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => secondary(current)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2.5 text-[11.5px] font-semibold text-ink-secondary hover:text-ink"
          >
            <SecondaryIcon size={12} />
            {meta.secondaryLabel}
          </button>
          <button
            type="button"
            onClick={() => void ack(current)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11.5px] font-semibold",
              meta.primaryCls,
            )}
          >
            <PrimaryIcon size={12} />
            {meta.primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
