import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowUp,
  Sparkles,
  CheckCircle2,
  Clock,
  Hourglass,
  Rocket,
  XCircle,
  ChevronDown,
  ChevronUp,
  Plus,
  Send,
  Trophy,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../hooks/useToast";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";
import { EmptyState } from "./EmptyState";
import { ListSkeleton } from "./Skeleton";
import { Avatar } from "./Avatar";
import { PullToRefresh } from "./PullToRefresh";

/**
 * Shared list + voting + status pipeline UI for the Innovation
 * (`target=innovation`) and Suggestion (`target=suggestion`) boxes.
 *
 * Both surfaces share:
 *   • Upvote toggle (POST/DELETE /api/{target}s/:id/vote)
 *   • Status filter chips
 *   • Submit form
 *   • Detail expansion with admin decision panel
 *
 * They differ in:
 *   • status enum (innovations have 5 stages, suggestions have 3)
 *   • body shape (innovations require body + tags; suggestions take title + optional one-liner)
 */

type Target = "innovation" | "suggestion";

export type InnovationStatus =
  | "review"
  | "accepted"
  | "in_progress"
  | "shipped"
  | "declined";
export type SuggestionStatus = "review" | "approved" | "declined";
export type AnyStatus = InnovationStatus | SuggestionStatus;

interface BaseRow {
  id: number;
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  user_profile_pic_r2_key: string | null;
  title: string;
  body: string | null;
  status: string;
  decided_by: number | null;
  decided_at: string | null;
  decline_reason: string | null;
  created_at: string;
  vote_count: number;
  has_voted: number;
}

interface InnovationRow extends BaseRow {
  tags: string | null;
}

interface Props<T extends BaseRow> {
  target: Target;
  /** Status order for filter chips + decision dropdown. */
  statuses: { value: AnyStatus; label: string }[];
  /** Pretty section title + intro shown over the form. */
  formIntro: ReactNode;
  /** Extra fields the submitter can fill (innovations need tags). */
  renderExtraFields?: (
    state: Record<string, string>,
    set: (k: string, v: string) => void,
  ) => ReactNode;
  /** Whether the body is required (innovations yes, suggestions no). */
  bodyRequired?: boolean;
  /** Award amount label for the eyebrow chip. */
  rewardLabel: string;
}

export function IdeaList<T extends BaseRow>({
  target,
  statuses,
  formIntro,
  renderExtraFields,
  bodyRequired,
  rewardLabel,
}: Props<T>) {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<AnyStatus | null>(null);
  const list = useQuery<{ rows: T[] }>(
    () =>
      api.get(
        `/api/${target}s${statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ""}`,
      ),
    [statusFilter, target],
  );
  const [openId, setOpenId] = useState<number | null>(null);

  const sorted = useMemo(() => {
    const rows = list.data?.rows ?? [];
    return [...rows].sort((a, b) => {
      // Active items rank above closed (declined / shipped / approved) for triage.
      const aClosed =
        a.status === "declined" ||
        a.status === "shipped" ||
        a.status === "approved";
      const bClosed =
        b.status === "declined" ||
        b.status === "shipped" ||
        b.status === "approved";
      if (aClosed !== bClosed) return aClosed ? 1 : -1;
      // Then by votes desc, then newest first
      if (b.vote_count !== a.vote_count) return b.vote_count - a.vote_count;
      return b.id - a.id;
    });
  }, [list.data]);

  return (
    <PullToRefresh onRefresh={() => list.reload()} className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Filter
          </span>
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-brand transition-colors",
              !statusFilter
                ? "bg-ink text-white"
                : "border border-border bg-surface text-ink-secondary hover:text-ink",
            )}
          >
            All
          </button>
          {statuses.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setStatusFilter(s.value)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-brand transition-colors",
                statusFilter === s.value
                  ? "bg-ink text-white"
                  : "border border-border bg-surface text-ink-secondary hover:text-ink",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {list.loading ? (
          <ListSkeleton rows={4} />
        ) : list.error ? (
          <EmptyState
            icon={<XCircle size={20} />}
            message="Couldn't load"
            description={list.error}
          />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={20} />}
            message="No posts yet"
            description={`Be the first to ${target === "innovation" ? "share an innovation" : "drop a suggestion"} — point your idea on the right.`}
          />
        ) : (
          <ul className="space-y-2">
            {sorted.map((row, i) => (
              <IdeaRow
                key={row.id}
                target={target}
                row={row}
                isOwner={row.user_id === user?.id}
                expanded={openId === row.id}
                onToggle={() =>
                  setOpenId((cur) => (cur === row.id ? null : row.id))
                }
                index={i}
              />
            ))}
          </ul>
        )}
      </div>

      <aside className="lg:sticky lg:top-16 lg:self-start">
        <SubmitCard
          target={target}
          formIntro={formIntro}
          renderExtraFields={renderExtraFields}
          bodyRequired={bodyRequired}
          rewardLabel={rewardLabel}
          onSubmitted={() => list.reload()}
        />
      </aside>
    </PullToRefresh>
  );
}

function IdeaRow<T extends BaseRow>({
  target,
  row,
  isOwner,
  expanded,
  onToggle,
  index,
}: {
  target: Target;
  row: T;
  isOwner: boolean;
  expanded: boolean;
  onToggle: () => void;
  index: number;
}) {
  const toast = useToast();
  const [voting, setVoting] = useState(false);
  const [voteCount, setVoteCount] = useState(row.vote_count);
  const [hasVoted, setHasVoted] = useState(!!row.has_voted);

  const tags = (row as unknown as InnovationRow).tags;

  async function toggleVote(e: React.MouseEvent) {
    e.stopPropagation();
    if (isOwner) {
      toast.error("You can't vote on your own post");
      return;
    }
    setVoting(true);
    try {
      if (hasVoted) {
        await api.del(`/api/${target}s/${row.id}/vote`);
        setVoteCount((c) => c - 1);
        setHasVoted(false);
      } else {
        await api.post(`/api/${target}s/${row.id}/vote`);
        setVoteCount((c) => c + 1);
        setHasVoted(true);
      }
    } catch (err: any) {
      toast.error(err?.message || "Vote failed");
    } finally {
      setVoting(false);
    }
  }

  return (
    <li
      className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone transition-all duration-200 hover:border-accent/40 hover:shadow-slab animate-rise"
      style={{ animationDelay: `${Math.min(index * 30, 600)}ms` }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-3 text-left"
      >
        <button
          type="button"
          onClick={toggleVote}
          disabled={voting || isOwner}
          aria-pressed={hasVoted}
          aria-label={hasVoted ? "Remove upvote" : "Upvote"}
          className={cn(
            "flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-lg border-2 px-2 py-2 transition-all duration-200",
            "active:scale-95",
            hasVoted
              ? "border-accent bg-accent text-white"
              : "border-border bg-bg/40 text-ink-secondary hover:border-accent/60 hover:text-accent",
            isOwner && "cursor-not-allowed opacity-50 hover:border-border hover:text-ink-secondary",
          )}
        >
          <ArrowUp
            size={16}
            strokeWidth={2.5}
            className={cn(hasVoted && "fill-white")}
          />
          <span className="font-mono text-[12px] font-bold leading-none">
            {voteCount}
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-display text-[15px] font-extrabold leading-tight tracking-tight text-ink">
              {row.title}
            </h3>
            <StatusBadge status={row.status} />
          </div>
          {row.body && !expanded && (
            <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-secondary">
              {row.body}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <Avatar
                userId={row.user_id}
                hasImage={row.user_profile_pic_r2_key}
                name={row.user_name}
                email={row.user_email}
                size={18}
              />
              <span className="font-semibold text-ink-secondary">
                {row.user_name || `User #${row.user_id}`}
              </span>
            </span>
            <span className="font-mono">{relativeTime(row.created_at)}</span>
            {tags && (
              <span className="inline-flex items-center gap-1">
                {tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4).map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-accent-soft/40 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-brand text-accent-ink"
                  >
                    {t}
                  </span>
                ))}
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-0.5 text-ink-muted">
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border bg-bg/20 p-4">
          {row.body && (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
              {row.body}
            </p>
          )}
          {row.decline_reason && (
            <div className="mt-3 rounded-md border border-err/30 bg-err-bg/40 p-2 text-[11.5px] text-err">
              <span className="font-semibold uppercase tracking-brand">Declined: </span>
              {row.decline_reason}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function SubmitCard({
  target,
  formIntro,
  renderExtraFields,
  bodyRequired,
  rewardLabel,
  onSubmitted,
}: {
  target: Target;
  formIntro: ReactNode;
  renderExtraFields?: (
    state: Record<string, string>,
    set: (k: string, v: string) => void,
  ) => ReactNode;
  bodyRequired?: boolean;
  rewardLabel: string;
  onSubmitted: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (bodyRequired && !body.trim()) {
      toast.error("Add some details");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/${target}s`, {
        title: title.trim(),
        body: body.trim() || undefined,
        ...extra,
      });
      toast.success(target === "innovation" ? "Innovation posted" : "Suggestion submitted");
      setTitle("");
      setBody("");
      setExtra({});
      onSubmitted();
    } catch (err: any) {
      toast.error(err?.message || "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone"
    >
      <div className="bg-gradient-to-br from-accent-soft/40 via-surface to-surface p-4">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-white shadow-sm">
            {target === "innovation" ? <Rocket size={14} /> : <Plus size={14} />}
          </span>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              {target === "innovation" ? "Innovation box" : "Suggestion box"}
            </div>
            <div className="font-display text-[15px] font-extrabold leading-tight tracking-tight text-ink">
              {target === "innovation" ? "Pitch a big idea" : "Drop a suggestion"}
            </div>
          </div>
        </div>
        <div className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
          {formIntro}
        </div>
        <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-accent text-white px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-brand">
          <Trophy size={10} /> {rewardLabel}
        </div>
      </div>

      <div className="space-y-2 p-4">
        <label className="block">
          <span className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            Title
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, 120))}
            placeholder={
              target === "innovation"
                ? "What if we…"
                : "Quick fix that would help…"
            }
            className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[13px] font-semibold"
          />
        </label>
        <label className="block">
          <span className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            {bodyRequired ? "Details" : "Details (optional)"}
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, 2000))}
            rows={target === "innovation" ? 5 : 2}
            placeholder={
              target === "innovation"
                ? "Why does it matter? Who benefits? Rough shape of the build?"
                : "One-liner is fine."
            }
            className="thin-scroll mt-0.5 w-full resize-none rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
          />
        </label>
        {renderExtraFields?.(extra, (k, v) => setExtra((s) => ({ ...s, [k]: v })))}
        <button
          type="submit"
          disabled={busy}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-md bg-accent py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-all",
            "hover:bg-accent/90 active:scale-95",
            busy && "opacity-50",
          )}
        >
          <Send size={13} /> {busy ? "Posting…" : "Post"}
        </button>
      </div>
    </form>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = statusToTone(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-brand",
        tone.badge,
      )}
    >
      <tone.Icon size={10} />
      {prettyStatus(status)}
    </span>
  );
}

function prettyStatus(s: string): string {
  return s.replace(/_/g, " ");
}

function statusToTone(status: string): {
  badge: string;
  button: string;
  Icon: any;
} {
  switch (status) {
    case "review":
      return {
        badge: "bg-bg/60 text-ink-secondary",
        button: "bg-bg/60 text-ink-secondary hover:bg-bg/80",
        Icon: Clock,
      };
    case "accepted":
      return {
        badge: "bg-accent-soft/60 text-accent-ink",
        button: "bg-accent-soft/60 text-accent-ink hover:bg-accent-soft",
        Icon: CheckCircle2,
      };
    case "in_progress":
      return {
        badge: "bg-warning-bg/70 text-warning-text",
        button: "bg-warning-bg/70 text-warning-text hover:bg-warning-bg",
        Icon: Hourglass,
      };
    case "shipped":
    case "approved":
      return {
        badge: "bg-synced-bg/70 text-synced",
        button: "bg-synced-bg/70 text-synced hover:bg-synced-bg",
        Icon: Rocket,
      };
    case "declined":
      return {
        badge: "bg-err-bg/60 text-err",
        button: "bg-err-bg/60 text-err hover:bg-err-bg",
        Icon: XCircle,
      };
    default:
      return {
        badge: "bg-bg/60 text-ink-secondary",
        button: "bg-bg/60 text-ink-secondary hover:bg-bg/80",
        Icon: Clock,
      };
  }
}
