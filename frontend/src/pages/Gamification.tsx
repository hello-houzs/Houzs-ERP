import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Trophy,
  Flame,
  Coins,
  Gift,
  Sparkles,
  ArrowDownRight,
  ArrowUpRight,
  ShoppingBag,
  Package,
  Wrench,
  CheckCircle2,
  Clock,
  XCircle,
  Truck,
  Crown,
  Medal,
  Award,
  Settings as SettingsIcon,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { DashboardGrid } from "../components/Dashboard";
import { StatCard } from "../components/StatCard";
import { SendPointsButton } from "../components/SendPointsButton";
import { StreakBoard } from "../components/StreakBoard";
import { AwardImage } from "../components/AwardImage";
import { EmptyState } from "../components/EmptyState";
import { ListSkeleton } from "../components/Skeleton";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { useQuery } from "../hooks/useQuery";
import { useAuth } from "../auth/AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";

type GamifyTab = "leaderboard" | "streak" | "shop" | "activity";

const GAMIFY_TAB_KEYS = ["sub", "scope", "period"] as const;

const TABS: readonly GamifyTab[] = ["leaderboard", "streak", "shop", "activity"];

interface MeSnapshot {
  id: number;
  name: string | null;
  email: string;
  department_id: number | null;
  points_balance: number;
  gifting_balance: number;
  current_streak: number;
  gifting_reset_at: string | null;
  earned_today: number;
  company_rank: number | null;
  leaderboard_size: number;
}

interface LeaderboardRow {
  user_id: number;
  name: string;
  email: string;
  department_id: number | null;
  department_name: string | null;
  points: number;
  current_streak: number;
  rank: number;
}

interface DepartmentRow {
  id: number;
  name: string;
  member_count: number;
}

interface StreakWeek {
  iso_week: string;
  upvotes_count: number;
  qualified: number;
}

interface TransactionRow {
  id: number;
  pool: "earned" | "gifting";
  delta: number;
  reason: string;
  ref_type: string | null;
  ref_id: number | null;
  counterparty_user_id: number | null;
  counterparty_name: string | null;
  note: string | null;
  created_at: string;
}

interface AwardRow {
  id: number;
  name: string;
  description: string | null;
  cost_points: number;
  stock: number | null;
  image_r2_key: string | null;
  active: number;
  sort_order: number;
}

interface RedemptionRow {
  id: number;
  award_id: number;
  award_name: string;
  award_image_r2_key: string | null;
  cost_points: number;
  status: "pending" | "shipped" | "delivered" | "cancelled";
  shipping_addr: string | null;
  admin_note: string | null;
  created_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

const REASON_LABEL: Record<string, string> = {
  gift_sent: "Sent gift",
  gift_received: "Received gift",
  monthly_reset: "Monthly allowance",
  innovation_shipped: "Innovation shipped",
  suggestion_approved: "Suggestion approved",
  upvote_received: "Upvote received",
  redeem: "Award redeemed",
  redeem_refund: "Award refunded",
  admin_adjust: "Admin adjustment",
};

function reasonText(r: string): string {
  return REASON_LABEL[r] ?? r;
}

export function Gamification() {
  const { user } = useAuth();
  const [params, setParams] = useStickyFilters("gamify", GAMIFY_TAB_KEYS);

  const rawTab = params.get("sub");
  const tab: GamifyTab = (TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as GamifyTab)
    : "leaderboard";
  const setTab = (v: GamifyTab) => {
    const next = new URLSearchParams(params);
    if (v === "leaderboard") next.delete("sub");
    else next.set("sub", v);
    setParams(next, { replace: true });
  };

  const scope = params.get("scope") || "company";
  const period = (params.get("period") || "week") as "week" | "month" | "all";
  const setScope = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === "company") next.delete("scope");
    else next.set("scope", v);
    setParams(next, { replace: true });
  };
  const setPeriod = (v: "week" | "month" | "all") => {
    const next = new URLSearchParams(params);
    if (v === "week") next.delete("period");
    else next.set("period", v);
    setParams(next, { replace: true });
  };

  // ── Personal snapshot — used in the header strip on every tab.
  const me = useQuery<MeSnapshot>(() => api.get("/api/gamify/me"));

  return (
    <div>
      <PageHeader
        eyebrow="Engagement"
        title="Houzs Points"
        description="Earn points for shipping ideas, getting upvotes, and recognising teammates. Spend them on prizes, send gifts to others."
        actions={
          <>
            {user?.permissions?.includes("*") && (
              <Link
                to="/gamification/admin"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
                title="Admin console"
              >
                <SettingsIcon size={12} /> Admin
              </Link>
            )}
            <SendPointsButton />
          </>
        }
      />

      <DashboardGrid cols={4}>
        <StatCard
          label="Your rank"
          value={
            me.data?.company_rank ? (
              <span>
                #{me.data.company_rank}{" "}
                <span className="text-[12px] font-medium text-ink-muted">
                  / {me.data.leaderboard_size}
                </span>
              </span>
            ) : (
              "—"
            )
          }
          subtitle="Company-wide all-time"
        />
        <StatCard
          label="Points balance"
          value={(me.data?.points_balance ?? 0).toLocaleString()}
          subtitle={
            me.data && me.data.earned_today > 0
              ? `+${me.data.earned_today} today`
              : "Earned via upvotes, gifts, awards"
          }
          tone="success"
        />
        <StatCard
          label="Gifting left"
          value={(me.data?.gifting_balance ?? 0).toLocaleString()}
          subtitle="Resets on the 1st"
        />
        <StatCard
          label="Current streak"
          value={
            <span>
              {me.data?.current_streak ?? 0}
              <span className="ml-1 text-[12px] font-medium text-ink-muted">
                wk{(me.data?.current_streak ?? 0) === 1 ? "" : "s"}
              </span>
            </span>
          }
          subtitle="Consecutive qualifying weeks"
        />
      </DashboardGrid>

      <TabStrip<GamifyTab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "leaderboard", label: "Leaderboard" },
          { value: "streak", label: "Streak" },
          { value: "shop", label: "Shop" },
          { value: "activity", label: "Activity" },
        ] as TabOption<GamifyTab>[]}
      />

      {tab === "leaderboard" && (
        <LeaderboardTab
          scope={scope}
          period={period}
          onScopeChange={setScope}
          onPeriodChange={setPeriod}
          ownUserId={user?.id ?? null}
        />
      )}
      {tab === "streak" && <StreakTab />}
      {tab === "shop" && <ShopTab />}
      {tab === "activity" && <ActivityTab />}
    </div>
  );
}

// ── Leaderboard tab ────────────────────────────────────────────

function initials(name: string): string {
  const parts = name
    .replace(/@.*/g, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function LeaderboardTab({
  scope,
  period,
  onScopeChange,
  onPeriodChange,
  ownUserId,
}: {
  scope: string;
  period: "week" | "month" | "all";
  onScopeChange: (v: string) => void;
  onPeriodChange: (v: "week" | "month" | "all") => void;
  ownUserId: number | null;
}) {
  const depts = useQuery<{ rows: DepartmentRow[] }>(() =>
    api.get("/api/gamify/departments"),
  );
  const board = useQuery<{ rows: LeaderboardRow[] }>(
    () =>
      api.get(
        `/api/gamify/leaderboard?scope=${encodeURIComponent(scope)}&period=${period}`,
      ),
    [scope, period],
  );

  const rows = board.data?.rows ?? [];
  const top3 = rows.slice(0, 3);
  const rest = rows.slice(3);

  return (
    <div>
      {/* ── Filter row ───────────────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <label className="flex w-full flex-col gap-0.5 sm:w-auto">
          <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
            Scope
          </span>
          <select
            value={scope}
            onChange={(e) => onScopeChange(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] sm:w-auto"
          >
            <option value="company">Company-wide</option>
            <option value="mine">My department</option>
            {(depts.data?.rows ?? []).map((d) => (
              <option key={d.id} value={`department:${d.id}`}>
                {d.name} ({d.member_count})
              </option>
            ))}
          </select>
        </label>

        <div className="inline-flex rounded-md border border-border bg-surface p-0.5 text-[11px] font-semibold">
          {(["week", "month", "all"] as const).map((p) => (
            <button
              key={p}
              onClick={() => onPeriodChange(p)}
              className={cn(
                "rounded px-3 py-1 transition-colors",
                period === p
                  ? "bg-accent text-white"
                  : "text-ink-secondary hover:text-ink",
              )}
            >
              {p === "week" ? "This week" : p === "month" ? "This month" : "All time"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Loading / error / empty ──────────────────────── */}
      {board.loading ? (
        <ListSkeleton rows={6} />
      ) : board.error ? (
        <EmptyState
          icon={<Trophy size={20} />}
          message="Couldn't load leaderboard"
          description={board.error}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Trophy size={20} />}
          message="No qualifying activity yet"
          description="Gift someone, ship an idea, or wait for upvotes — the board fills as the team racks up points."
        />
      ) : (
        <>
          {/* ── Podium ──────────────────────────────────── */}
          {top3.length > 0 && <Podium rows={top3} ownUserId={ownUserId} />}

          {/* ── Ranks 4+ ────────────────────────────────── */}
          {rest.length > 0 && (
            <div className="mt-6 overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
              <div className="border-b border-border bg-bg/40 px-4 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  The pack
                </span>
              </div>
              <ul>
                {rest.map((r, i) => (
                  <RankRow
                    key={r.user_id}
                    row={r}
                    isYou={ownUserId === r.user_id}
                    index={i}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Podium for top 3 ──────────────────────────────────────────

function Podium({
  rows,
  ownUserId,
}: {
  rows: LeaderboardRow[];
  ownUserId: number | null;
}) {
  // Render order: 2nd · 1st · 3rd. Visual height: 1st > 2nd > 3rd.
  const slots: Array<LeaderboardRow | null> = [
    rows[1] ?? null,
    rows[0] ?? null,
    rows[2] ?? null,
  ];
  const cfg = [
    { rank: 2, height: "sm:h-32 h-24", Icon: Medal, ring: "ring-accent/40", bar: "from-accent/60 to-accent/30" },
    { rank: 1, height: "sm:h-44 h-32", Icon: Crown, ring: "ring-accent shadow-brass", bar: "from-accent to-accent/60" },
    { rank: 3, height: "sm:h-24 h-20", Icon: Award, ring: "ring-accent/25", bar: "from-accent/30 to-accent/15" },
  ];

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-accent-soft/50 via-surface to-surface p-4 shadow-stone sm:p-6">
      {/* Decorative laurel band */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-accent to-transparent opacity-60" />

      <div className="grid grid-cols-3 items-end gap-2 sm:gap-4">
        {slots.map((r, i) => {
          const c = cfg[i];
          if (!r) {
            return (
              <div key={`empty-${i}`} className="flex flex-col items-center">
                <div className="mb-2 grid h-16 w-16 place-items-center rounded-full border-2 border-dashed border-border/60 sm:h-20 sm:w-20">
                  <span className="font-display text-[16px] font-extrabold text-ink-muted/50">
                    —
                  </span>
                </div>
                <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Slot {c.rank}
                </div>
                <div
                  className={cn(
                    "mt-2 w-full rounded-t-md border border-b-0 border-border bg-bg/40",
                    c.height,
                  )}
                />
              </div>
            );
          }
          const isYou = ownUserId === r.user_id;
          return (
            <div
              key={r.user_id}
              className="flex flex-col items-center animate-rise"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              {/* Avatar with crown */}
              <div className="relative">
                {c.rank === 1 && (
                  <Crown
                    size={20}
                    className="absolute -top-4 left-1/2 -translate-x-1/2 rotate-[-10deg] fill-accent/30 text-accent drop-shadow-[0_2px_4px_rgba(161,106,46,0.4)]"
                  />
                )}
                <div
                  className={cn(
                    "grid place-items-center rounded-full bg-gradient-to-br ring-4 ring-offset-2 ring-offset-surface transition-transform hover:scale-105",
                    "h-16 w-16 sm:h-20 sm:w-20",
                    c.bar,
                    c.ring,
                  )}
                >
                  <span className="font-display text-[18px] font-extrabold text-white sm:text-[22px]">
                    {initials(r.name)}
                  </span>
                </div>
              </div>

              {/* Name + dept */}
              <div className="mt-2 max-w-full px-1 text-center">
                <div className="truncate font-display text-[12.5px] font-extrabold tracking-tight text-ink sm:text-[13.5px]">
                  {r.name}
                  {isYou && (
                    <span className="ml-1 font-mono text-[8.5px] uppercase tracking-brand text-accent">
                      you
                    </span>
                  )}
                </div>
                {r.department_name && (
                  <div className="truncate text-[9.5px] uppercase tracking-brand text-ink-muted">
                    {r.department_name}
                  </div>
                )}
              </div>

              {/* Points */}
              <div className="mt-1 inline-flex items-center gap-1 font-mono text-[14px] font-bold text-accent sm:text-[16px]">
                <Coins size={13} />
                {r.points.toLocaleString()}
              </div>

              {/* Streak chip */}
              {r.current_streak > 0 && (
                <div className="mt-1 inline-flex items-center gap-0.5 rounded-full bg-warning-bg/80 px-1.5 py-0.5 text-[9.5px] font-bold text-warning-text">
                  <Flame size={10} className="fill-warning-text/30" />
                  {r.current_streak}w
                </div>
              )}

              {/* Pillar with rank number */}
              <div
                className={cn(
                  "relative mt-3 flex w-full items-start justify-center overflow-hidden rounded-t-md border border-b-0 border-accent/30 bg-gradient-to-b shadow-inner",
                  c.bar,
                  c.height,
                )}
              >
                <span className="mt-2 font-display text-[28px] font-extrabold text-white drop-shadow-[0_2px_4px_rgba(17,24,16,0.25)] sm:text-[36px]">
                  {c.rank}
                </span>
                <c.Icon
                  size={14}
                  className="absolute bottom-2 left-1/2 -translate-x-1/2 text-white/70"
                />
                {/* Send-points action — only on top-3 of others */}
                {ownUserId && !isYou && (
                  <div
                    className="absolute right-1 top-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <SendPointsButton
                      prefill={{ id: r.user_id, name: r.name }}
                      compact
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RankRow({
  row,
  isYou,
  index,
}: {
  row: LeaderboardRow;
  isYou: boolean;
  index: number;
}) {
  return (
    <li
      className={cn(
        "group flex items-center gap-3 border-b border-border-subtle px-4 py-2.5 transition-colors last:border-b-0 hover:bg-bg/40 animate-rise",
        isYou && "bg-accent-soft/30 hover:bg-accent-soft/40",
      )}
      style={{ animationDelay: `${Math.min(index * 25, 600)}ms` }}
    >
      {/* Rank number */}
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-bg/60 font-mono text-[11px] font-bold text-ink-secondary">
        {row.rank}
      </span>

      {/* Avatar */}
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[10px] font-bold uppercase text-accent-ink"
        aria-hidden="true"
      >
        {initials(row.name)}
      </span>

      {/* Name + dept */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold text-ink">{row.name}</span>
          {isYou && (
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-brand text-accent">
              you
            </span>
          )}
        </div>
        {row.department_name && (
          <div className="truncate text-[10.5px] text-ink-muted">
            {row.department_name}
          </div>
        )}
      </div>

      {/* Streak (hidden on very narrow) */}
      {row.current_streak > 0 && (
        <span className="hidden items-center gap-0.5 rounded-full bg-warning-bg/60 px-1.5 py-0.5 text-[9.5px] font-bold text-warning-text sm:inline-flex">
          <Flame size={10} className="fill-warning-text/30" />
          {row.current_streak}w
        </span>
      )}

      {/* Points */}
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[13px] font-bold text-accent">
        <Coins size={11} />
        {row.points.toLocaleString()}
      </span>

      {/* Send button (others only) */}
      {!isYou && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 sm:opacity-60"
        >
          <SendPointsButton prefill={{ id: row.user_id, name: row.name }} compact />
        </div>
      )}
    </li>
  );
}

// ── Streak tab ─────────────────────────────────────────────────

function StreakTab() {
  const streak = useQuery<{ weeks: StreakWeek[] }>(() =>
    api.get("/api/gamify/streak"),
  );
  const settings = useQuery<{ settings: Record<string, string> }>(() =>
    api.get("/api/gamify/settings"),
  );
  const me = useQuery<MeSnapshot>(() => api.get("/api/gamify/me"));

  const threshold = useMemo(() => {
    const raw = settings.data?.settings.streak_weekly_threshold;
    const n = parseInt(raw ?? "5", 10);
    return Number.isFinite(n) ? n : 5;
  }, [settings.data]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <StreakBoard
          weeks={streak.data?.weeks ?? []}
          threshold={threshold}
          currentStreak={me.data?.current_streak ?? 0}
          loading={streak.loading || me.loading}
        />
      </div>
      <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          How streaks work
        </div>
        <div className="mt-3 space-y-3 text-[12px] text-ink-secondary">
          <p>
            Each week (Mon–Sun) counts as <strong className="text-ink">qualifying</strong> when you receive at least <strong className="text-ink">{threshold}</strong> upvotes or gifts.
          </p>
          <p>
            Your <Flame size={11} className="inline text-accent" /> current streak is the longest consecutive run of qualifying weeks ending this week. One quiet week resets it.
          </p>
          <p>
            The threshold is admin-tunable — ask HR if it feels off for your role.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Activity tab ───────────────────────────────────────────────

function ActivityTab() {
  const tx = useQuery<{ rows: TransactionRow[] }>(() =>
    api.get("/api/gamify/transactions?limit=100"),
  );

  if (tx.loading) return <ListSkeleton rows={8} />;
  if (tx.error) {
    return (
      <EmptyState
        icon={<Sparkles size={20} />}
        message="Couldn't load activity"
        description={tx.error}
      />
    );
  }
  const rows = tx.data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Coins size={20} />}
        message="Nothing yet"
        description="Earn points by shipping ideas, getting upvotes, or receiving gifts. Send some gifts to start."
      />
    );
  }

  return (
    <div className="space-y-2">
      <MyRedemptions />
      {rows.map((r, i) => {
        const positive = r.delta > 0;
        const Icon =
          r.reason === "gift_received"
            ? ArrowDownRight
            : r.reason === "gift_sent"
              ? ArrowUpRight
              : r.reason === "monthly_reset"
                ? Gift
                : r.reason === "redeem"
                  ? ShoppingBag
                  : positive
                    ? Trophy
                    : Coins;
        return (
          <div
            key={r.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-stone transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-slab animate-rise"
            style={{ animationDelay: `${Math.min(i * 30, 600)}ms` }}
          >
            <span
              className={cn(
                "grid h-8 w-8 shrink-0 place-items-center rounded-md",
                positive ? "bg-accent-soft/60 text-accent" : "bg-bg/60 text-ink-muted",
              )}
            >
              <Icon size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-ink">
                  {reasonText(r.reason)}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[12px] font-bold",
                    positive ? "text-accent" : "text-ink-muted",
                  )}
                >
                  {positive ? "+" : ""}
                  {r.delta} pts
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                {r.counterparty_name && (
                  <span className="truncate">
                    {r.delta > 0 ? "from" : "to"} {r.counterparty_name}
                  </span>
                )}
                {r.note && (
                  <span className="truncate italic">"{r.note}"</span>
                )}
                <span className="ml-auto shrink-0 font-mono">
                  {relativeTime(r.created_at)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Shop tab ───────────────────────────────────────────────────

function ShopTab() {
  const { user } = useAuth();
  const { pointsBalance, reload: reloadNotif } = useNotifications();
  const list = useQuery<{ rows: AwardRow[] }>(() => api.get("/api/awards"));
  const [picked, setPicked] = useState<AwardRow | null>(null);
  const isAdmin = !!user?.permissions?.includes("*");

  if (list.loading) return <ListSkeleton rows={6} />;
  if (list.error) {
    return (
      <EmptyState
        icon={<ShoppingBag size={20} />}
        message="Couldn't load the shop"
        description={list.error}
      />
    );
  }
  const rows = list.data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag size={20} />}
        message="The shop is empty"
        description={
          isAdmin
            ? "Add awards in the catalog admin to give the team something to redeem for."
            : "HR hasn't stocked the catalog yet — check back soon."
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex items-center justify-between rounded-md border border-dashed border-accent/40 bg-accent-soft/20 px-3 py-2 text-[11px] text-ink-secondary">
          <span>You can edit the catalog and process redemptions.</span>
          <Link
            to="/gamification/admin"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white hover:bg-accent/90"
          >
            <Wrench size={11} /> Catalog admin
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {rows.map((a, i) => {
          const affordable = pointsBalance >= a.cost_points;
          const outOfStock = a.stock !== null && a.stock !== undefined && a.stock <= 0;
          return (
            <button
              key={a.id}
              type="button"
              disabled={!affordable || outOfStock}
              onClick={() => !outOfStock && affordable && setPicked(a)}
              className={cn(
                "group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface text-left shadow-stone transition-all duration-300 animate-rise",
                "hover:-translate-y-1 hover:border-accent/60 hover:shadow-slab",
                "focus:outline-none focus:ring-2 focus:ring-accent",
                (!affordable || outOfStock) &&
                  "cursor-not-allowed opacity-60 hover:translate-y-0 hover:border-border hover:shadow-stone",
              )}
              style={{ animationDelay: `${Math.min(i * 50, 600)}ms` }}
            >
              <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-accent-soft/40 via-bg/40 to-accent-soft/20">
                <AwardImage
                  awardId={a.id}
                  hasImage={!!a.image_r2_key}
                  alt={a.name}
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
                  iconSize={32}
                />
                {outOfStock && (
                  <span className="absolute right-2 top-2 rounded-full bg-ink/80 px-2 py-0.5 text-[9px] font-bold uppercase tracking-brand text-white backdrop-blur-sm">
                    Out of stock
                  </span>
                )}
                {!outOfStock && a.stock !== null && a.stock !== undefined && a.stock <= 5 && (
                  <span className="absolute right-2 top-2 rounded-full bg-warning-bg/95 px-2 py-0.5 font-mono text-[9px] font-bold text-warning-text backdrop-blur-sm">
                    {a.stock} left
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-1.5 p-3">
                <div className="font-display text-[14px] font-extrabold leading-tight tracking-tight text-ink line-clamp-2">
                  {a.name}
                </div>
                {a.description && (
                  <div className="text-[11px] leading-relaxed text-ink-secondary line-clamp-2">
                    {a.description}
                  </div>
                )}
                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className="inline-flex items-center gap-1 font-mono text-[14px] font-bold text-accent">
                    <Coins size={13} />
                    {a.cost_points.toLocaleString()}
                  </span>
                  <span
                    className={cn(
                      "rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-brand transition-colors",
                      affordable && !outOfStock
                        ? "bg-accent text-white group-hover:bg-accent/90"
                        : "bg-bg/60 text-ink-muted",
                    )}
                  >
                    {outOfStock ? "Sold out" : affordable ? "Redeem" : "Locked"}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {picked && (
        <RedeemModal
          award={picked}
          balance={pointsBalance}
          onClose={() => setPicked(null)}
          onSuccess={() => {
            setPicked(null);
            reloadNotif();
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function RedeemModal({
  award,
  balance,
  onClose,
  onSuccess,
}: {
  award: AwardRow;
  balance: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const after = balance - award.cost_points;

  async function handleRedeem() {
    setBusy(true);
    try {
      const r = await api.post<{
        ok: boolean;
        redemption: RedemptionRow;
        new_balance: number;
      }>(`/api/awards/${award.id}/redeem`, {
        shipping_addr: addr.trim() || undefined,
      });
      toast.success(`Redeemed ${award.name} — pending fulfilment`);
      onSuccess();
      void r;
    } catch (e: any) {
      toast.error(e?.message || "Redeem failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Redeem ${award.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface shadow-slab animate-rise"
      >
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-accent-soft/40 via-bg/40 to-accent-soft/20">
          <AwardImage
            awardId={award.id}
            hasImage={!!award.image_r2_key}
            alt={award.name}
            className="h-full w-full object-cover"
            iconSize={48}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-ink/60 text-white backdrop-blur-sm transition-colors hover:bg-ink/80"
          >
            <XCircle size={16} />
          </button>
        </div>
        <div className="space-y-3 p-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Confirm redemption
            </div>
            <h2 className="mt-1 font-display text-[20px] font-extrabold leading-tight tracking-tight text-ink">
              {award.name}
            </h2>
            {award.description && (
              <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                {award.description}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-border bg-bg/40 p-3 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">Cost</span>
              <span className="font-mono font-bold text-accent">
                {award.cost_points.toLocaleString()} pts
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-ink-muted">Your balance</span>
              <span className="font-mono">{balance.toLocaleString()} pts</span>
            </div>
            <div className="mt-1 flex items-center justify-between border-t border-border pt-1">
              <span className="text-ink-muted">After redemption</span>
              <span
                className={cn(
                  "font-mono font-bold",
                  after >= 0 ? "text-ink" : "text-err",
                )}
              >
                {after.toLocaleString()} pts
              </span>
            </div>
          </div>

          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Shipping address (optional)
            </span>
            <textarea
              value={addr}
              onChange={(e) => setAddr(e.target.value.slice(0, 500))}
              rows={2}
              placeholder="Where should we send it? Skip for digital prizes."
              className="thin-scroll mt-1 w-full resize-none rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
            />
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-border bg-surface py-2 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || after < 0}
              onClick={handleRedeem}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-all",
                "hover:bg-accent/90 active:scale-95",
                (busy || after < 0) && "cursor-not-allowed opacity-50 hover:bg-accent active:scale-100",
              )}
            >
              <ShoppingBag size={13} /> {busy ? "Redeeming…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── My redemptions panel (rendered atop Activity tab) ──────────

function MyRedemptions() {
  const list = useQuery<{ rows: RedemptionRow[] }>(() =>
    api.get("/api/awards/redemptions/mine"),
  );
  const rows = list.data?.rows ?? [];
  if (list.loading || rows.length === 0) return null;

  return (
    <div className="mb-4 rounded-xl border border-border bg-gradient-to-br from-accent-soft/30 via-surface to-surface p-4 shadow-stone">
      <div className="mb-2 flex items-center gap-2">
        <ShoppingBag size={13} className="text-accent" />
        <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Your redemptions
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.slice(0, 6).map((r) => {
          const StatusIcon =
            r.status === "delivered"
              ? CheckCircle2
              : r.status === "shipped"
                ? Truck
                : r.status === "cancelled"
                  ? XCircle
                  : Clock;
          const tone =
            r.status === "delivered"
              ? "text-synced"
              : r.status === "cancelled"
                ? "text-err"
                : r.status === "shipped"
                  ? "text-accent"
                  : "text-ink-muted";
          return (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-md border border-border bg-surface p-2.5"
            >
              <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-bg/60">
                <AwardImage
                  awardId={r.award_id}
                  hasImage={!!r.award_image_r2_key}
                  alt={r.award_name}
                  className="h-full w-full object-cover"
                  iconSize={16}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-ink">
                  {r.award_name}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-ink-muted">
                  <StatusIcon size={11} className={tone} />
                  <span className={cn("font-semibold uppercase tracking-brand", tone)}>
                    {r.status}
                  </span>
                  <span className="ml-auto font-mono">
                    {relativeTime(r.created_at)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
