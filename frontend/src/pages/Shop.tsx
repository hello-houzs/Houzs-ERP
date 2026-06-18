import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ShoppingBag,
  Coins,
  RefreshCw,
  Wrench,
  XCircle,
  PackageCheck,
  Truck,
  Hourglass,
  CircleSlash,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { AwardImage } from "../components/AwardImage";
import { EmptyState } from "../components/EmptyState";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useAuth } from "../auth/AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";

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

/**
 * Award shop — own page so it's visually and conceptually separate from
 * the points/leaderboard surfaces. Polls /api/awards every 60s so catalog
 * edits made in the admin console show up without a manual refresh.
 */
export function Shop() {
  const { user } = useAuth();
  const { pointsBalance, reload: reloadNotif } = useNotifications();
  const list = useQuery<{ rows: AwardRow[] }>(() => api.get("/api/awards"));
  const [picked, setPicked] = useState<AwardRow | null>(null);
  const isAdmin = !!user?.permissions?.includes("*");

  useEffect(() => {
    const t = window.setInterval(() => list.reload(), 60_000);
    return () => window.clearInterval(t);
  }, [list]);

  const rows = list.data?.rows ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Engagement"
        title="Award Shop"
        description="Spend Houzs Points on real prizes. New stock lands here as soon as HR adds it."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<RefreshCw size={13} className={list.loading ? "animate-spin" : ""} />}
              onClick={() => list.reload()}
              disabled={list.loading}
            >
              Refresh
            </Button>
            {isAdmin && (
              <Link
                to="/gamification/admin?tab=catalog"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-accent bg-accent px-4 text-[13px] font-semibold tracking-wide text-white shadow-brass transition-all duration-150 hover:bg-accent-hover"
              >
                <Wrench size={12} /> Manage catalog
              </Link>
            )}
          </div>
        }
      />

      {/* Balance strip */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-gradient-to-br from-accent-soft/40 via-surface to-surface px-4 py-3 shadow-stone">
        <Coins size={14} className="text-accent" />
        <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Your balance
        </span>
        <span className="font-mono text-[16px] font-extrabold text-accent">
          {pointsBalance.toLocaleString()}
        </span>
        <span className="text-[11px] text-ink-muted">points to spend</span>
      </div>

      <MyRedemptions />

      {list.loading && rows.length === 0 ? (
        <ListSkeleton rows={6} />
      ) : list.error ? (
        <EmptyState
          icon={<ShoppingBag size={20} />}
          message="Couldn't load the shop"
          description={list.error}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ShoppingBag size={20} />}
          message="The shop is empty"
          description={
            isAdmin
              ? "Add awards in the catalog admin to give the team something to redeem for."
              : "HR hasn't stocked the catalog yet — check back soon."
          }
        />
      ) : (
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
      )}

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
      await api.post<{ ok: boolean; new_balance: number }>(
        `/api/awards/${award.id}/redeem`,
        { shipping_addr: addr.trim() || undefined },
      );
      toast.success(`Redeemed ${award.name} — pending fulfilment`);
      onSuccess();
    } catch (e: any) {
      toast.error(e?.message || "Redeem failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} aria-label={`Redeem ${award.name}`}>
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
            <h2 className="mt-1 font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
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
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy || after < 0}
              onClick={handleRedeem}
              className="flex-1"
              icon={<ShoppingBag size={13} />}
            >
              {busy ? "Redeeming…" : "Confirm"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

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
        {rows.slice(0, 4).map((r) => (
          <RedemptionRowItem key={r.id} row={r} />
        ))}
      </div>
    </div>
  );
}

function RedemptionRowItem({ row }: { row: RedemptionRow }) {
  const StatusIcon =
    row.status === "delivered"
      ? PackageCheck
      : row.status === "shipped"
      ? Truck
      : row.status === "cancelled"
      ? CircleSlash
      : Hourglass;
  const statusColor =
    row.status === "delivered"
      ? "text-synced"
      : row.status === "shipped"
      ? "text-accent"
      : row.status === "cancelled"
      ? "text-err"
      : "text-warning-text";
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface p-2 text-[11.5px]">
      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-bg/40">
        <AwardImage
          awardId={row.award_id}
          hasImage={!!row.award_image_r2_key}
          alt={row.award_name}
          className="h-full w-full object-cover"
          iconSize={16}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-ink">{row.award_name}</div>
        <div className="text-[10px] text-ink-muted">{relativeTime(row.created_at)}</div>
      </div>
      <span className={cn("inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-brand", statusColor)}>
        <StatusIcon size={11} /> {row.status}
      </span>
    </div>
  );
}
