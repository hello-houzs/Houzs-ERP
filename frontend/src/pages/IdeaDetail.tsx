import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MessageCircle, Pencil, Trash2 } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { Avatar } from "../components/Avatar";
import { ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DetailLayout } from "../components/DetailLayout";
import { RowActionsMenu, type MenuItem } from "../components/RowActionsMenu";
import { cn, relativeTime } from "../lib/utils";
import {
  IdeaComments,
  IdeaCover,
  StatusBadge,
  SubmitPanel,
  UpvoteButton,
  VotersStrip,
  type BaseRow,
  type Target,
} from "../components/IdeaList";

interface DetailRow extends BaseRow {
  tags?: string | null;
  awarded_at?: string | null;
  decided_by_name?: string | null;
}

interface Props {
  target: Target;
}

/**
 * Single-post detail page — `/innovations/:id` and `/suggestions/:id`.
 *
 * Uses DetailLayout chrome so the breadcrumb / back behaviour matches
 * every other detail page in the ERP. The post body is laid out in
 * X-style: byline (avatar + name + timestamp + dot menu) → title →
 * body → tags → optional cover image → stats row → action rail →
 * voters strip → comments.
 *
 * Admin review actions live in the Engagement admin console — they
 * are no longer surfaced here. The dot menu offers Edit (owner while
 * `review`) and Delete (owner OR admin, soft-archive).
 */
export function IdeaDetail({ target }: Props) {
  const { id: idParam } = useParams();
  const id = parseInt(idParam ?? "", 10);
  const { user } = useAuth();
  const isAdmin = !!user?.permissions?.includes("*");
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  const [editOpen, setEditOpen] = useState(false);

  const detail = useQuery<{ row: DetailRow }>(
    () => api.get(`/api/${target}s/${id}`),
    [target, id],
  );

  const row = detail.data?.row;
  const isOwner = !!user && !!row && row.user_id === user.id;
  const canEdit = isOwner && row?.status === "review";
  const canDelete = isOwner || isAdmin;

  const breadcrumbs = useMemo(
    () => [
      {
        label: target === "innovation" ? "Innovations" : "Suggestions",
        to: `/${target}s`,
      },
      { label: row?.title ?? (target === "innovation" ? "Innovation" : "Suggestion") },
    ],
    [target, row?.title],
  );

  async function handleDelete() {
    if (!row) return;
    const ok = await dialog.confirm({
      message:
        target === "innovation"
          ? "Delete this innovation? It will be archived and disappear from the list."
          : "Delete this suggestion? It will be archived and disappear from the list.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/${target}s/${row.id}`);
      toast.success("Post deleted");
      navigate(`/${target}s`);
    } catch (err: any) {
      toast.error(err?.message || "Delete failed");
    }
  }

  if (!Number.isFinite(id)) {
    return (
      <DetailLayout breadcrumbs={breadcrumbs} title="Bad URL">
        <EmptyState
          message="Bad URL"
          description="This post link is malformed."
          cta={{ label: "Back", onClick: () => navigate(`/${target}s`) }}
        />
      </DetailLayout>
    );
  }

  if (detail.loading) {
    return (
      <DetailLayout
        breadcrumbs={breadcrumbs}
        title="Loading…"
        loading
      >
        <ListSkeleton rows={1} />
      </DetailLayout>
    );
  }

  if (detail.error || !row) {
    return (
      <DetailLayout breadcrumbs={breadcrumbs} title="Not found">
        <EmptyState
          message="Couldn't load post"
          description={detail.error || "It may have been deleted."}
          cta={{ label: "Back to list", onClick: () => navigate(`/${target}s`) }}
        />
      </DetailLayout>
    );
  }

  const tags = row.tags;
  const menuItems: MenuItem[] = [];
  if (canEdit) {
    menuItems.push({
      icon: Pencil,
      label: "Edit post",
      onClick: () => setEditOpen(true),
    });
  }
  if (canDelete) {
    menuItems.push({
      icon: Trash2,
      label: "Delete post",
      onClick: handleDelete,
      danger: true,
    });
  }

  return (
    <DetailLayout
      breadcrumbs={breadcrumbs}
      eyebrow={target === "innovation" ? "Innovation" : "Suggestion"}
      title={row.title}
      actions={menuItems.length > 0 ? <RowActionsMenu items={menuItems} title="Post actions" size={36} /> : null}
    >
      <article className="mx-auto max-w-2xl">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-stone">
          {/* Byline: avatar + name + timestamp + status */}
          <header className="flex items-center gap-3 px-5 pt-5">
            <Avatar
              userId={row.user_id}
              hasImage={row.user_profile_pic_r2_key}
              name={row.user_name}
              email={row.user_email}
              size={44}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="truncate text-[14px] font-bold text-ink">
                  {row.user_name || row.user_email || `User #${row.user_id}`}
                </span>
                {isOwner && (
                  <span className="rounded-full bg-accent-soft/60 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-brand text-accent-ink">
                    You
                  </span>
                )}
              </div>
              <div className="font-mono text-[10.5px] text-ink-muted">
                {relativeTime(row.created_at)}
                {row.decided_by_name && row.status !== "review" && (
                  <span className="ml-1.5 text-ink-muted/80">
                    · decided by {row.decided_by_name}
                  </span>
                )}
              </div>
            </div>
            <StatusBadge status={row.status} />
          </header>

          {/* Body */}
          {row.body && (
            <p className="whitespace-pre-wrap px-5 pt-3 text-[14px] leading-relaxed text-ink">
              {row.body}
            </p>
          )}

          {/* Tags */}
          {tags && (
            <div className="flex flex-wrap items-center gap-1.5 px-5 pt-3">
              {tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
                .map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-accent-soft/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-brand text-accent-ink"
                  >
                    #{t}
                  </span>
                ))}
            </div>
          )}

          {/* Cover image (optional) */}
          {row.cover_attachment_id != null && (
            <IdeaCover attachmentId={row.cover_attachment_id} className="mt-4" />
          )}

          {/* Decline reason callout */}
          {row.decline_reason && (
            <div className="mx-5 mt-4 rounded-md border border-err/30 bg-err-bg/40 p-3 text-[12.5px] text-err">
              <div className="mb-1 font-mono text-[9.5px] font-bold uppercase tracking-brand">
                Decline reason
              </div>
              <p className="whitespace-pre-wrap">{row.decline_reason}</p>
            </div>
          )}

          {/* Stats row */}
          <div className="mt-4 flex items-center gap-3 px-5 pb-2 font-mono text-[11px] text-ink-muted">
            <span>
              <span className={cn("font-bold", row.vote_count > 0 ? "text-ink" : "text-ink-muted")}>
                {row.vote_count}
              </span>{" "}
              {row.vote_count === 1 ? "Like" : "Likes"}
            </span>
            <span aria-hidden>·</span>
            <span>
              <span className={cn("font-bold", (row.comment_count ?? 0) > 0 ? "text-ink" : "text-ink-muted")}>
                {row.comment_count ?? 0}
              </span>{" "}
              {(row.comment_count ?? 0) === 1 ? "Comment" : "Comments"}
            </span>
          </div>

          {/* Action rail */}
          <div className="flex items-center gap-2 border-t border-border-subtle bg-bg/30 px-3 py-2">
            <UpvoteButton
              target={target}
              targetId={row.id}
              initialCount={row.vote_count}
              initialVoted={!!row.has_voted}
              isOwner={isOwner}
              size="lg"
            />
            <a
              href="#comments"
              className="inline-flex h-11 items-center gap-1.5 rounded-full px-4 text-[13px] font-bold text-ink-secondary transition-all duration-150 hover:bg-accent-soft/40 hover:text-accent active:scale-95"
            >
              <MessageCircle size={16} strokeWidth={2.4} />
              <span className="font-mono">{row.comment_count ?? 0}</span>
            </a>
          </div>

          {/* Compact voters strip */}
          <div className="px-5 pb-4">
            <VotersStrip target={target} targetId={row.id} />
          </div>
        </div>

        {/* Comments thread */}
        <div id="comments" className="mt-4">
          <IdeaComments
            target={target}
            targetId={row.id}
            isAdmin={isAdmin}
            autoFocus={false}
            onCountChange={() => detail.reload()}
          />
        </div>
      </article>

      {/* Edit panel — modal */}
      <SubmitPanel
        target={target}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        mode="edit"
        existing={row}
        formIntro={
          target === "innovation"
            ? "Refine the pitch — title, body, tags, photo."
            : "Tweak the wording or swap the photo."
        }
        extraFields={
          target === "innovation"
            ? [
                {
                  key: "tags",
                  label: "Tags",
                  placeholder: "comma,separated,tags",
                  maxLength: 200,
                },
              ]
            : undefined
        }
        bodyRequired={target === "innovation"}
        rewardLabel={
          target === "innovation"
            ? "Reward when shipped"
            : "Reward when approved"
        }
        onDone={() => {
          setEditOpen(false);
          detail.reload();
        }}
      />
    </DetailLayout>
  );
}
