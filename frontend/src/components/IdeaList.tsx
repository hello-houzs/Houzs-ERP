import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
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
  Paperclip,
  Trash2,
  FileText,
  Download,
  Pencil,
  Heart,
  MessageCircle,
  X,
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../hooks/useToast";
import { useQuery } from "../hooks/useQuery";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";
import { EmptyState } from "./EmptyState";
import { ListSkeleton } from "./Skeleton";
import { Avatar } from "./Avatar";
import { Panel } from "./Panel";
import { usePullToRefreshBlock } from "./PullToRefresh";

/**
 * Shared list + voting + status pipeline UI for the Innovation
 * (`target=innovation`) and Suggestion (`target=suggestion`) boxes.
 *
 * The submit form lives inside a side panel triggered by a "Post"
 * button at the top of the list. The same panel doubles as the
 * edit surface for the current user's own (still-under-review)
 * posts, with attachment upload available in both modes.
 */

export type Target = "innovation" | "suggestion";

export type InnovationStatus =
  | "review"
  | "accepted"
  | "in_progress"
  | "shipped"
  | "declined";
export type SuggestionStatus = "review" | "approved" | "declined";
export type AnyStatus = InnovationStatus | SuggestionStatus;

export interface BaseRow {
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
  comment_count: number;
  /** First non-archived attachment id — surfaced as the post's cover
   *  image. Mandatory at submission time; older posts may have null. */
  cover_attachment_id: number | null;
}

interface InnovationRow extends BaseRow {
  tags: string | null;
}

interface ExtraField {
  key: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
}

interface Props<T extends BaseRow> {
  target: Target;
  /** Status order for filter chips + decision dropdown. */
  statuses: { value: AnyStatus; label: string }[];
  /** Pretty section title + intro shown over the form. */
  formIntro: ReactNode;
  /** Extra fields the submitter can fill (innovations need tags). */
  extraFields?: ExtraField[];
  /** Whether the body is required (innovations yes, suggestions no). */
  bodyRequired?: boolean;
  /** Award amount label for the eyebrow chip. */
  rewardLabel: string;
  /**
   * On mount, the list calls this with a function that opens the
   * Post panel in create mode. The page can stash the callback and
   * wire a button in `PageHeader actions` to it.
   */
  registerPostTrigger?: (open: () => void) => void;
}


export function IdeaList<T extends BaseRow>({
  target,
  statuses,
  formIntro,
  extraFields,
  bodyRequired,
  rewardLabel,
  registerPostTrigger,
}: Props<T>) {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<AnyStatus | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const list = useQuery<{ rows: T[] }>(
    () =>
      api.get(
        `/api/${target}s${statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ""}`,
      ),
    [statusFilter, target],
  );
  // Edit moved to the detail page; the list-side panel is create-only.
  const [panelOpen, setPanelOpen] = useState(false);

  const sorted = useMemo(() => {
    const all = list.data?.rows ?? [];
    const filtered = mineOnly && user
      ? all.filter((r) => r.user_id === user.id)
      : all;
    return [...filtered].sort((a, b) => {
      const aClosed =
        a.status === "declined" ||
        a.status === "shipped" ||
        a.status === "approved";
      const bClosed =
        b.status === "declined" ||
        b.status === "shipped" ||
        b.status === "approved";
      if (aClosed !== bClosed) return aClosed ? 1 : -1;
      if (b.vote_count !== a.vote_count) return b.vote_count - a.vote_count;
      return b.id - a.id;
    });
  }, [list.data, mineOnly, user]);

  const myCount = useMemo(() => {
    if (!user) return 0;
    return (list.data?.rows ?? []).filter((r) => r.user_id === user.id).length;
  }, [list.data, user]);

  function openCreate() {
    setPanelOpen(true);
  }

  // Hand the page a trigger so the Post button can live in PageHeader.
  useEffect(() => {
    registerPostTrigger?.(openCreate);
  }, [registerPostTrigger]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setMineOnly(false)}
          className={cn(
            "rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-brand transition-colors",
            !mineOnly
              ? "bg-ink text-white"
              : "border border-border bg-surface text-ink-secondary hover:text-ink",
          )}
        >
          All posts
        </button>
        <button
          type="button"
          onClick={() => setMineOnly(true)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-brand transition-colors",
            mineOnly
              ? "bg-accent text-white"
              : "border border-border bg-surface text-ink-secondary hover:text-ink",
          )}
        >
          <UserIcon size={11} /> My posts
          {myCount > 0 && (
            <span
              className={cn(
                "rounded-full px-1.5 font-mono text-[9.5px]",
                mineOnly ? "bg-white/20 text-white" : "bg-bg/60 text-ink-secondary",
              )}
            >
              {myCount}
            </span>
          )}
        </button>
        <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />
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
          Any status
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
          message={mineOnly ? "You haven't posted yet" : "No posts yet"}
          description={
            mineOnly
              ? `Tap Post to ${target === "innovation" ? "share an innovation" : "drop a suggestion"}.`
              : `Be the first to ${target === "innovation" ? "share an innovation" : "drop a suggestion"} — tap Post to start.`
          }
          cta={{ label: "Post", onClick: openCreate }}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((row, i) => {
            const isOwner = row.user_id === user?.id;
            return (
              <IdeaRow
                key={row.id}
                target={target}
                row={row}
                isOwner={isOwner}
                index={i}
              />
            );
          })}
        </ul>
      )}

      <SubmitPanel
        target={target}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        mode="create"
        existing={null}
        formIntro={formIntro}
        extraFields={extraFields}
        bodyRequired={bodyRequired}
        rewardLabel={rewardLabel}
        onDone={() => {
          setPanelOpen(false);
          list.reload();
        }}
      />
    </>
  );
}

function IdeaRow<T extends BaseRow>({
  target,
  row,
  isOwner,
  index,
}: {
  target: Target;
  row: T;
  isOwner: boolean;
  index: number;
}) {
  const tags = (row as unknown as InnovationRow).tags;
  const detailHref = `/${target}s/${row.id}`;

  // X-style hierarchy: avatar + name → title → image → tags → actions.
  // Whole hero (header through tags) links to the detail page; action
  // rail sits outside the link so taps on Like / Comments don't navigate
  // away. Body and full comments thread live on the detail page.
  return (
    <li
      className={cn(
        "overflow-hidden rounded-2xl border bg-surface shadow-stone transition-all duration-200 animate-rise",
        isOwner
          ? "border-accent/40 ring-1 ring-accent/20 hover:border-accent/60 hover:shadow-slab"
          : "border-border hover:border-accent/40 hover:shadow-slab",
      )}
      style={{ animationDelay: `${Math.min(index * 30, 600)}ms` }}
    >
      <Link
        to={detailHref}
        aria-label={`Open: ${row.title}`}
        className="block outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {/* Header: author + timestamp + status */}
        <div className="flex items-center gap-3 px-4 pt-3.5">
          <Avatar
            userId={row.user_id}
            hasImage={row.user_profile_pic_r2_key}
            name={row.user_name}
            email={row.user_email}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate font-semibold text-[13px] text-ink">
                {row.user_name || row.user_email || `User #${row.user_id}`}
              </span>
              {isOwner && (
                <span className="rounded-full bg-accent-soft/60 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-brand text-accent-ink">
                  You
                </span>
              )}
            </div>
            <div className="font-mono text-[10px] text-ink-muted">
              {relativeTime(row.created_at)}
            </div>
          </div>
          <StatusBadge status={row.status} />
        </div>

        {/* Title (bold headline) */}
        <h3 className="px-4 pt-2 font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
          {row.title}
        </h3>

        {/* Body — always visible on the card, line-clamp-3 to keep
            cards skimmable. Full body lives on the detail page. */}
        {row.body && (
          <p className="line-clamp-3 px-4 pt-1.5 text-[12.5px] leading-relaxed text-ink-secondary">
            {row.body}
          </p>
        )}

        {/* Tags */}
        {tags && (
          <div className="flex flex-wrap items-center gap-1 px-4 pt-2.5">
            {tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .slice(0, 6)
              .map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-accent-soft/40 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-brand text-accent-ink"
                >
                  #{t}
                </span>
              ))}
          </div>
        )}

        {/* Cover image (optional) — full-bleed inside the card */}
        {row.cover_attachment_id != null && (
          <IdeaCover attachmentId={row.cover_attachment_id} className="mt-2.5" />
        )}

        {/* Stats row — informational summary above the action bar. */}
        <div className="flex items-center gap-3 px-4 pt-2.5 pb-2 font-mono text-[10.5px] text-ink-muted">
          <span>
            <span className="font-bold text-ink">{row.vote_count}</span>{" "}
            {row.vote_count === 1 ? "Like" : "Likes"}
          </span>
          <span aria-hidden>·</span>
          <span>
            <span className="font-bold text-ink">{row.comment_count ?? 0}</span>{" "}
            {(row.comment_count ?? 0) === 1 ? "Comment" : "Comments"}
          </span>
        </div>
      </Link>

      {/* Action rail: like + comment + view. Outside the Link so taps
          don't navigate (Like is inline; Comment + View do navigate). */}
      <div className="flex items-center gap-1.5 border-t border-border-subtle bg-bg/30 px-2 py-1.5">
        <UpvoteButton
          target={target}
          targetId={row.id}
          initialCount={row.vote_count}
          initialVoted={!!row.has_voted}
          isOwner={isOwner}
        />

        <Link
          to={detailHref}
          aria-label={`${row.comment_count ?? 0} ${(row.comment_count ?? 0) === 1 ? "comment" : "comments"}, open thread`}
          className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold text-ink-secondary transition-all duration-150 hover:bg-accent-soft/40 hover:text-accent active:scale-95"
        >
          <MessageCircle size={14} strokeWidth={2.4} />
          <span className="font-mono">{row.comment_count ?? 0}</span>
        </Link>

        <Link
          to={detailHref}
          className="ml-auto inline-flex h-9 items-center gap-1 rounded-full px-2.5 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted transition-colors hover:text-accent"
        >
          View →
        </Link>
      </div>
    </li>
  );
}

// ── Upvote button (shared between card + detail page) ─────────

export function UpvoteButton({
  target,
  targetId,
  initialCount,
  initialVoted,
  isOwner,
  size = "md",
}: {
  target: Target;
  targetId: number;
  initialCount: number;
  initialVoted: boolean;
  isOwner: boolean;
  /** "md" matches the card chip; "lg" is for the detail page action rail. */
  size?: "md" | "lg";
}) {
  const toast = useToast();
  const [voting, setVoting] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [hasVoted, setHasVoted] = useState(initialVoted);

  // Re-sync if the upstream payload changes (e.g. detail page refetch).
  useEffect(() => setCount(initialCount), [initialCount]);
  useEffect(() => setHasVoted(initialVoted), [initialVoted]);

  async function toggle(e: React.MouseEvent | React.SyntheticEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (isOwner) {
      toast.error("You can't vote on your own post");
      return;
    }
    setVoting(true);
    try {
      if (hasVoted) {
        await api.del(`/api/${target}s/${targetId}/vote`);
        setCount((c) => c - 1);
        setHasVoted(false);
      } else {
        await api.post(`/api/${target}s/${targetId}/vote`);
        setCount((c) => c + 1);
        setHasVoted(true);
      }
    } catch (err: any) {
      toast.error(err?.message || "Vote failed");
    } finally {
      setVoting(false);
    }
  }

  const sizeCls =
    size === "lg"
      ? "h-11 px-4 text-[13px]"
      : "h-9 px-3 text-[12px]";
  const iconSize = size === "lg" ? 16 : 14;

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={voting || isOwner}
      aria-pressed={hasVoted}
      aria-label={hasVoted ? "Remove upvote" : "Upvote"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-bold transition-all duration-150 active:scale-95",
        sizeCls,
        hasVoted
          ? "bg-accent text-white hover:bg-accent/90"
          : "text-ink-secondary hover:bg-accent-soft/40 hover:text-accent",
        isOwner && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-ink-secondary",
      )}
    >
      <ArrowUp
        size={iconSize}
        strokeWidth={2.5}
        className={cn(hasVoted && "fill-white")}
      />
      <span className="font-mono">{count}</span>
    </button>
  );
}

// ── Cover image — auth-aware blob URL with skeleton placeholder ──

export function IdeaCover({
  attachmentId,
  className,
}: {
  attachmentId: number;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    api
      .fetchBlobUrl(`/api/idea-attachments/${attachmentId}/blob`)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
        } else {
          url = u;
          setSrc(u);
        }
      })
      .catch(() => {
        // silent — card just renders without the image
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachmentId]);

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden border-y border-border-subtle bg-surface-dim",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <div className="skeleton h-full w-full" />
      )}
    </div>
  );
}

interface VoterRow {
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  user_profile_pic_r2_key: string | null;
  voted_at: string;
}

function firstName(name?: string | null, email?: string | null): string {
  const src = (name || email || "").trim();
  if (!src) return "Someone";
  // "John Doe" → "John"; "john.doe@…" → "john"
  return src.split(/[\s@._-]+/).filter(Boolean)[0] ?? "Someone";
}

/** Compact "[avatars] Jane and 12 others liked this" strip. */
export function VotersStrip({
  target,
  targetId,
}: {
  target: Target;
  targetId: number;
}) {
  const list = useQuery<{ rows: VoterRow[] }>(
    () => api.get(`/api/${target}s/${targetId}/voters`),
    [target, targetId],
  );
  const rows = list.data?.rows ?? [];
  if (rows.length === 0) return null;

  // Up to 4 overlapping avatars; the lead voter's first name + "N others"
  // carries the rest. No long name list — gets unwieldy past ~5 voters.
  const visible = rows.slice(0, 4);
  const lead = firstName(rows[0].user_name, rows[0].user_email);
  const others = rows.length - 1;

  return (
    <div className="mt-3 flex items-center gap-2.5">
      <div className="flex shrink-0">
        {visible.map((v, i) => (
          <span
            key={v.user_id}
            className={cn(
              "inline-flex rounded-full ring-2 ring-surface",
              i > 0 && "-ml-2",
            )}
            title={v.user_name || v.user_email || `User #${v.user_id}`}
            style={{ zIndex: visible.length - i }}
          >
            <Avatar
              userId={v.user_id}
              hasImage={v.user_profile_pic_r2_key}
              name={v.user_name}
              email={v.user_email}
              size={24}
            />
          </span>
        ))}
      </div>
      <span className="min-w-0 truncate text-[12px] text-ink-secondary">
        <span className="font-semibold text-ink">{lead}</span>
        {others > 0 && (
          <>
            {" "}and{" "}
            <span className="font-semibold text-ink">
              {others} other{others === 1 ? "" : "s"}
            </span>
          </>
        )}{" "}
        liked this
      </span>
    </div>
  );
}

function AttachmentCountChip({
  target,
  targetId,
}: {
  target: Target;
  targetId: number;
}) {
  const list = useQuery<{ rows: AttachmentRow[] }>(
    () => api.get(`/api/idea-attachments?target=${target}&target_id=${targetId}`),
    [target, targetId],
  );
  const count = list.data?.rows?.length ?? 0;
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-1 text-[10.5px] font-semibold text-ink-secondary">
      <Paperclip size={11} /> {count}
    </span>
  );
}

interface AttachmentRow {
  id: number;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_by: number | null;
  uploaded_at: string;
}

/**
 * Read-only attachment list shown inside the expanded row.
 * Upload and remove now live inside the edit panel — see SubmitPanel.
 */
function IdeaAttachmentsRead({
  target,
  targetId,
}: {
  target: Target;
  targetId: number;
}) {
  const toast = useToast();
  const list = useQuery<{ rows: AttachmentRow[] }>(
    () => api.get(`/api/idea-attachments?target=${target}&target_id=${targetId}`),
    [target, targetId],
  );
  const rows = list.data?.rows ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-border bg-surface/60 p-2.5">
      <div className="mb-1.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        <Paperclip size={11} /> Attachments
        <span className="ml-1 rounded-full bg-bg/60 px-1.5 font-mono text-[9.5px] text-ink-secondary">
          {rows.length}
        </span>
      </div>
      <ul className="divide-y divide-border-subtle">
        {rows.map((a) => (
          <li
            key={a.id}
            className="flex items-center gap-2 py-1.5 text-[11.5px]"
          >
            <FileText size={13} className="shrink-0 text-ink-muted" />
            <span className="min-w-0 flex-1 truncate font-semibold text-ink">
              {a.file_name}
            </span>
            {typeof a.size_bytes === "number" && (
              <span className="shrink-0 font-mono text-[9.5px] text-ink-muted">
                {formatBytes(a.size_bytes)}
              </span>
            )}
            <button
              type="button"
              onClick={async () => {
                try {
                  const url = await api.fetchBlobUrl(`/api/idea-attachments/${a.id}/blob`);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = a.file_name;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  setTimeout(() => URL.revokeObjectURL(url), 5000);
                } catch (e: any) {
                  toast.error(e?.message || "Download failed");
                }
              }}
              className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-bg/60 hover:text-accent"
              title="Download"
            >
              <Download size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_COMMENT_LEN = 2000;

// ── Comments ────────────────────────────────────────────────────

interface CommentRow {
  id: number;
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  user_profile_pic_r2_key: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
}

export function IdeaComments({
  target,
  targetId,
  isAdmin,
  autoFocus,
  onCountChange,
}: {
  target: Target;
  targetId: number;
  isAdmin: boolean;
  autoFocus: boolean;
  onCountChange: (delta: number) => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const list = useQuery<{ rows: CommentRow[] }>(
    () => api.get(`/api/idea-comments?target=${target}&target_id=${targetId}`),
    [target, targetId],
  );
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const rows = list.data?.rows ?? [];

  // When the user clicks the comment chip, the parent flips `autoFocus`
  // true. Focus the composer once the section is on screen so the
  // keyboard pops up on mobile and screen readers land on the input.
  useEffect(() => {
    if (autoFocus && composerRef.current) {
      composerRef.current.focus();
    }
  }, [autoFocus]);

  async function postComment(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (text.length > MAX_COMMENT_LEN) {
      toast.error(`Keep it under ${MAX_COMMENT_LEN} characters`);
      return;
    }
    setPosting(true);
    try {
      await api.post(`/api/idea-comments`, {
        target,
        target_id: targetId,
        body: text,
      });
      setDraft("");
      onCountChange(+1);
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to post comment");
    } finally {
      setPosting(false);
    }
  }

  async function saveEdit(id: number) {
    const text = editDraft.trim();
    if (!text) return;
    try {
      await api.patch(`/api/idea-comments/${id}`, { body: text });
      setEditingId(null);
      setEditDraft("");
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to update comment");
    }
  }

  async function removeComment(id: number) {
    const ok = await dialog.confirm({
      message: "Delete this comment?",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/idea-comments/${id}`);
      onCountChange(-1);
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete");
    }
  }

  return (
    <section className="mt-3 rounded-md border border-border bg-surface/60 p-3">
      <div className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        <MessageCircle size={11} className="text-accent" /> Comments
        {rows.length > 0 && (
          <span className="rounded-full bg-bg/60 px-1.5 font-mono text-[9.5px] text-ink-secondary">
            {rows.length}
          </span>
        )}
      </div>

      {list.loading ? (
        <div className="px-1 py-3 text-[11.5px] text-ink-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-1 py-3 text-[11.5px] italic text-ink-muted">
          Be the first to comment.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((c) => {
            const isOwn = !!user && c.user_id === user.id;
            const canDelete = isOwn || isAdmin;
            const isEditing = editingId === c.id;
            return (
              <li
                key={c.id}
                className="flex items-start gap-2.5 rounded-md bg-surface px-2.5 py-2 shadow-stone"
              >
                <Avatar
                  userId={c.user_id}
                  hasImage={c.user_profile_pic_r2_key}
                  name={c.user_name}
                  email={c.user_email}
                  size={28}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-[12px] font-semibold text-ink">
                      {c.user_name || c.user_email || `User #${c.user_id}`}
                    </span>
                    {isOwn && (
                      <span className="rounded-full bg-accent-soft/60 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-brand text-accent-ink">
                        You
                      </span>
                    )}
                    <span
                      className="font-mono text-[9.5px] text-ink-muted"
                      title={c.created_at}
                    >
                      {relativeTime(c.created_at)}
                      {c.edited_at && (
                        <span className="ml-1 italic text-ink-muted/70">
                          · edited
                        </span>
                      )}
                    </span>
                  </div>
                  {isEditing ? (
                    <div className="mt-1.5">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={2}
                        maxLength={MAX_COMMENT_LEN}
                        className="block w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                      />
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => saveEdit(c.id)}
                          className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-accent-hover active:scale-95"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setEditDraft("");
                          }}
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface px-2.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink">
                      {c.body}
                    </p>
                  )}
                </div>
                {!isEditing && (isOwn || canDelete) && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {isOwn && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(c.id);
                          setEditDraft(c.body);
                        }}
                        aria-label="Edit comment"
                        className="inline-flex h-9 w-9 items-center justify-center rounded text-ink-muted transition-colors hover:bg-accent-soft/40 hover:text-accent"
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => removeComment(c.id)}
                        aria-label="Delete comment"
                        className="inline-flex h-9 w-9 items-center justify-center rounded text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Composer */}
      {user && (
        <form
          onSubmit={postComment}
          className="mt-3 flex items-end gap-2 rounded-md border border-border bg-surface p-2"
        >
          <Avatar
            userId={user.id}
            hasImage={user.profile_pic_r2_key}
            name={user.name}
            email={user.email}
            size={28}
          />
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a comment…"
            rows={1}
            maxLength={MAX_COMMENT_LEN}
            onKeyDown={(e) => {
              // Cmd/Ctrl + Enter to submit, plain Enter for newline.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                postComment(e);
              }
            }}
            className="block min-h-[36px] flex-1 resize-y bg-transparent px-1 py-1 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-muted"
          />
          <button
            type="submit"
            disabled={posting || draft.trim().length === 0}
            aria-label="Post comment"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-accent text-white shadow-sm transition-all hover:bg-accent-hover active:scale-95 disabled:bg-border-strong disabled:hover:bg-border-strong"
          >
            {posting ? (
              <span className="font-mono text-[10px]">…</span>
            ) : (
              <Send size={15} />
            )}
          </button>
        </form>
      )}
    </section>
  );
}

export function SubmitPanel<T extends BaseRow>({
  target,
  open,
  onClose,
  mode,
  existing,
  formIntro,
  extraFields,
  bodyRequired,
  rewardLabel,
  onDone,
}: {
  target: Target;
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  existing: T | null;
  formIntro: ReactNode;
  extraFields?: ExtraField[];
  bodyRequired?: boolean;
  rewardLabel: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [existingAtts, setExistingAtts] = useState<AttachmentRow[]>([]);
  const [busy, setBusy] = useState(false);

  // Dirty-state computation: drives the unsaved-changes guard on Panel
  // dismissal. Compares current form values against either "empty" (create)
  // or the row's persisted shape (edit). Buffered file picks always count
  // as dirty since they aren't uploaded until submit.
  const dirty = useMemo(() => {
    if (!open) return false;
    if (pendingFiles.length > 0) return true;
    if (mode === "create") {
      if (title.trim() !== "") return true;
      if (body.trim() !== "") return true;
      if (Object.values(extra).some((v) => v.trim() !== "")) return true;
      return false;
    }
    if (!existing) return false;
    const exAny = existing as unknown as Record<string, unknown>;
    if (title.trim() !== existing.title) return true;
    if (body.trim() !== (existing.body ?? "")) return true;
    for (const f of extraFields ?? []) {
      const initial = String(exAny[f.key] ?? "");
      if ((extra[f.key] ?? "") !== initial) return true;
    }
    return false;
  }, [open, mode, existing, title, body, extra, pendingFiles, extraFields]);

  async function attemptClose() {
    if (!dirty) {
      onClose();
      return;
    }
    const ok = await dialog.confirm({
      message:
        mode === "create"
          ? "Discard your draft?"
          : "Discard unsaved edits?",
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok) onClose();
  }

  // Block the global pull-to-refresh while this panel is open with
  // pending changes. Without this, an accidental swipe-down on a long
  // form (the panel scrolls when content overflows) tears down the
  // page mid-typing.
  usePullToRefreshBlock(open && dirty);

  // Hydrate the form whenever the panel opens (or the target row changes).
  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && existing) {
      setTitle(existing.title);
      setBody(existing.body ?? "");
      const fromExtra: Record<string, string> = {};
      const tags = (existing as unknown as InnovationRow).tags;
      if (tags != null) fromExtra.tags = tags;
      setExtra(fromExtra);
      setPendingFiles([]);
      // Fetch existing attachments
      api
        .get<{ rows: AttachmentRow[] }>(
          `/api/idea-attachments?target=${target}&target_id=${existing.id}`,
        )
        .then((res) => setExistingAtts(res.rows))
        .catch(() => setExistingAtts([]));
    } else {
      setTitle("");
      setBody("");
      setExtra({});
      setPendingFiles([]);
      setExistingAtts([]);
    }
  }, [open, mode, existing, target]);

  function pickFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Single image only — replaces any previously staged file.
    const f = files[0];
    if (!f.type.startsWith("image/")) {
      toast.error("Pictures only — please choose an image file");
      return;
    }
    if (f.size > MAX_ATTACHMENT_BYTES) {
      toast.error(`${f.name} is over 25 MB`);
      return;
    }
    setPendingFiles([f]);
  }

  function removePending() {
    setPendingFiles([]);
  }

  async function removeExisting(att: AttachmentRow) {
    const ok = await dialog.confirm({
      message: `Remove ${att.file_name}?`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/idea-attachments/${att.id}`);
      setExistingAtts((cur) => cur.filter((a) => a.id !== att.id));
      toast.success("Photo removed");
    } catch (e: any) {
      toast.error(e?.message || "Remove failed");
    }
  }

  async function uploadOne(parentId: number, file: File): Promise<void> {
    await api.putBinary(
      `/api/idea-attachments/${target}/${parentId}?name=${encodeURIComponent(file.name)}`,
      file,
      file.type || "application/octet-stream",
    );
  }

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
    // Photo is optional — text-only posts are allowed. Pictures-only
    // remains a backend rule for whatever the user attaches.
    setBusy(true);
    try {
      let parentId: number;
      if (mode === "create") {
        const payload: Record<string, unknown> = {
          title: title.trim(),
          body: body.trim() || undefined,
          ...extra,
        };
        const res = await api.post<{ row: { id: number } }>(
          `/api/${target}s`,
          payload,
        );
        parentId = res.row.id;
      } else if (existing) {
        const payload: Record<string, unknown> = {
          title: title.trim(),
          body: bodyRequired ? body.trim() : body.trim() || null,
        };
        for (const f of extraFields ?? []) {
          if (extra[f.key] !== undefined) payload[f.key] = extra[f.key];
        }
        await api.patch(`/api/${target}s/${existing.id}`, payload);
        parentId = existing.id;
      } else {
        throw new Error("No row to edit");
      }

      // Upload buffered attachments. One failure shouldn't roll back the
      // record itself — toast the failure and keep going.
      const failures: string[] = [];
      for (const f of pendingFiles) {
        try {
          await uploadOne(parentId, f);
        } catch (e: any) {
          failures.push(`${f.name}: ${e?.message || "upload failed"}`);
        }
      }
      if (failures.length) {
        toast.error(failures.join(" · "));
      }

      toast.success(
        mode === "create"
          ? target === "innovation"
            ? "Innovation posted"
            : "Suggestion submitted"
          : "Updated",
      );
      onDone();
    } catch (err: any) {
      toast.error(err?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const titleText =
    mode === "edit"
      ? target === "innovation"
        ? "Edit innovation"
        : "Edit suggestion"
      : target === "innovation"
        ? "Pitch a big idea"
        : "Drop a suggestion";

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={titleText}
      width={460}
      dirty={dirty}
      onAttemptClose={attemptClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-md border border-accent/30 bg-gradient-to-br from-accent-soft/40 via-surface to-surface p-3">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-white shadow-sm">
              {target === "innovation" ? <Rocket size={14} /> : <Plus size={14} />}
            </span>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              {target === "innovation" ? "Innovation box" : "Suggestion box"}
            </div>
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent text-white px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-brand">
              <Trophy size={10} /> {rewardLabel}
            </span>
          </div>
          <div className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
            {formIntro}
          </div>
        </div>

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
            rows={target === "innovation" ? 6 : 3}
            placeholder={
              target === "innovation"
                ? "Why does it matter? Who benefits? Rough shape of the build?"
                : "One-liner is fine."
            }
            className="thin-scroll mt-0.5 w-full resize-none rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
          />
        </label>

        {extraFields?.map((f) => (
          <label key={f.key} className="block">
            <span className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
              {f.label}
            </span>
            <input
              value={extra[f.key] || ""}
              onChange={(e) =>
                setExtra((s) => ({
                  ...s,
                  [f.key]: e.target.value.slice(0, f.maxLength ?? 200),
                }))
              }
              placeholder={f.placeholder}
              className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
            />
          </label>
        ))}

        <PhotoPicker
          target={target}
          existing={existingAtts[0] ?? null}
          pending={pendingFiles[0] ?? null}
          onPick={(files) => pickFiles(files)}
          onRemoveExisting={() => existingAtts[0] && removeExisting(existingAtts[0])}
          onRemovePending={() => removePending()}
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[11.5px] font-semibold text-ink-secondary transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-all",
              "hover:bg-accent/90 active:scale-95",
              busy && "opacity-50",
            )}
          >
            <Send size={13} />
            {busy
              ? mode === "edit"
                ? "Saving…"
                : "Posting…"
              : mode === "edit"
                ? "Save"
                : "Post"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

// ── Mandatory cover-image picker ──────────────────────────────
//
// Single image required per post. Pictures only (image/*). Pre-existing
// attachment rendered via the auth-aware IdeaCover blob URL; freshly
// staged file rendered via a local objectURL so the user sees the
// preview before upload.

function PhotoPicker({
  existing,
  pending,
  onPick,
  onRemoveExisting,
  onRemovePending,
}: {
  target: Target;
  existing: AttachmentRow | null;
  pending: File | null;
  onPick: (files: FileList | null) => void;
  onRemoveExisting: () => void;
  onRemovePending: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Local preview for the staged file. Cleaned up on file change /
  // unmount so the blob doesn't leak.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!pending) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(pending);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);

  const hasAny = !!pending || !!existing;

  return (
    <div className="rounded-md border border-border bg-bg/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          <Paperclip size={11} /> Photo
          <span className="rounded-full bg-bg/60 px-1.5 font-mono text-[9px] uppercase tracking-brand text-ink-muted">
            Optional
          </span>
        </span>
        {hasAny ? (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10.5px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
          >
            <Pencil size={11} /> Replace
          </button>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent active:scale-95"
          >
            <Plus size={11} /> Add photo
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            onPick(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {!hasAny && (
        <div className="grid place-items-center rounded-md border border-dashed border-border-strong/60 bg-surface px-3 py-6 text-center text-[10.5px] text-ink-muted">
          A picture, mockup, or screenshot. Pictures only.
        </div>
      )}

      {pending && previewUrl && (
        <div className="relative aspect-video w-full overflow-hidden rounded-md border border-accent/30">
          <img
            src={previewUrl}
            alt={pending.name}
            className="h-full w-full object-cover"
          />
          <span className="absolute left-1.5 top-1.5 rounded-full bg-accent px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-brand text-white shadow-sm">
            Pending
          </span>
          <button
            type="button"
            onClick={onRemovePending}
            aria-label="Remove pending photo"
            className="absolute right-1.5 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface/95 text-ink-secondary shadow-sm transition-colors hover:bg-err/10 hover:text-err"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {!pending && existing && (
        <div className="relative w-full overflow-hidden rounded-md border border-border-subtle">
          <IdeaCover attachmentId={existing.id} />
          <button
            type="button"
            onClick={onRemoveExisting}
            aria-label="Remove photo"
            className="absolute right-1.5 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface/95 text-ink-secondary shadow-sm transition-colors hover:bg-err/10 hover:text-err"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
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
