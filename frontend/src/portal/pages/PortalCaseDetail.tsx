import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Upload, Send, Package, Star, X, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";
import { portalApi } from "../portalApi";
import { PortalFrame } from "../components/PortalFrame";
import { StatusPill } from "../components/StatusPill";
import { useDialog } from "../../hooks/useDialog";
import { formatDate, formatDateTime } from "../../lib/utils";
import type { PortalCaseDetail } from "../types";

const ALLOWED_EXT = ["jpg", "jpeg", "png", "webp"];
const MAX_SIZE = 10 * 1024 * 1024;

export function PortalCaseDetailPage() {
  const dialog = useDialog();
  const { token = "" } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<PortalCaseDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const d = await portalApi.get<PortalCaseDetail>("/api/portal/case", token);
      setData(d);
    } catch (e: any) {
      if (e?.status === 401) setExpired(true);
      else setErr(e?.message || "Could not load case");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [token]);

  async function postComment() {
    if (!comment.trim()) return;
    setPosting(true);
    try {
      await portalApi.post("/api/portal/case/comments", token, { text: comment.trim() });
      setComment("");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to post");
    } finally {
      setPosting(false);
    }
  }

  async function archiveComment(actId: number) {
    if (!await dialog.confirm("Remove this comment?")) return;
    try {
      await portalApi.post(`/api/portal/case/comments/${actId}/archive`, token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to remove");
    }
  }

  async function archivePhoto(attId: number) {
    if (!await dialog.confirm("Remove this photo?")) return;
    try {
      await portalApi.post(`/api/portal/case/attachments/${attId}/archive`, token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to remove");
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = "";
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) { setErr(`Unsupported file type: .${ext}`); return; }
    if (f.size > MAX_SIZE) { setErr("File exceeds 10 MB"); return; }
    setUploading(true);
    setErr(null);
    try {
      const buf = await f.arrayBuffer();
      await portalApi.putBinary(
        `/api/portal/case/attachments?ext=${ext}&name=${encodeURIComponent(f.name)}`,
        token,
        buf,
        f.type || "image/jpeg"
      );
      await load();
    } catch (e: any) {
      setErr(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  if (expired) {
    return (
      <PortalFrame>
        <div className="mx-auto max-w-sm py-8 text-center">
          <div className="mb-2 text-lg font-semibold">Link Expired</div>
          <div className="text-sm text-ink-secondary">
            This tracking link is no longer valid. Please use the tracking page to
            re-verify your case, or ask Houzs Century for a fresh link.
          </div>
          <button
            onClick={() => nav("/track")}
            className="mt-6 rounded-md bg-accent px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-white"
          >
            Track a case
          </button>
        </div>
      </PortalFrame>
    );
  }

  if (loading) {
    return <PortalFrame><div className="py-10 text-center text-ink-muted">Loading case…</div></PortalFrame>;
  }

  if (err && !data) {
    return (
      <PortalFrame>
        <div className="py-8 text-center">
          <div className="mb-2 text-lg font-semibold text-err">Unavailable</div>
          <div className="text-sm text-ink-secondary">{err}</div>
        </div>
      </PortalFrame>
    );
  }
  if (!data) return <PortalFrame><div /></PortalFrame>;

  const { case: cs, items, attachments, timeline } = data;

  return (
    <PortalFrame>
      {/* Header */}
      <div className="rounded-lg border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-lg font-bold">{cs.assr_no}</span>
          <StatusPill color={cs.status_color} label={cs.status_label} />
        </div>
        {cs.customer_name && (
          <div className="mt-1 text-[13px] text-ink-secondary">
            {cs.customer_name}
          </div>
        )}
        <div className="mt-1 text-[12px] text-ink-muted">
          Reported {formatDate(cs.complained_date)}
          {cs.expected_resolution_at && <> · Expected by {formatDate(cs.expected_resolution_at)}</>}
          {cs.closed_at && <> · Closed {formatDate(cs.closed_at)}</>}
        </div>
      </div>

      {/* Items */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Items under service
        </h2>
        {items.length === 0 ? (
          <div className="text-[12px] text-ink-muted">No items recorded.</div>
        ) : (
          <ul className="space-y-2">
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-3 text-[13px]">
                <Package size={14} className="text-ink-muted" />
                <span className="font-mono text-[11px]">{it.item_code}</span>
                <span className="flex-1 truncate text-ink-secondary">{it.item_description || ""}</span>
                {it.qty && <span className="text-[11px] text-ink-muted">× {it.qty}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Issue */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Reported issue
        </h2>
        <div className="text-sm whitespace-pre-line">{cs.complaint_issue || "—"}</div>
        {cs.category && (
          <div className="mt-2 text-[11px] text-ink-muted">Category: {cs.category}</div>
        )}
      </section>

      {/* Photos */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Photos &amp; evidence
          </h2>
          <label className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-semibold text-ink hover:border-accent/40 ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
            <Upload size={11} /> {uploading ? "Uploading…" : "Upload photo"}
            <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" onChange={onFile} disabled={uploading} />
          </label>
        </div>
        {attachments.length === 0 ? (
          <div className="text-[12px] text-ink-muted">No photos yet.</div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {attachments.map((a, i) => (
              <PortalPhoto
                key={a.id}
                token={token}
                attId={a.id}
                label={a.category}
                source={a.source ?? "staff"}
                onClick={() => setLightboxIndex(i)}
                onRemove={
                  a.source === "customer" && cs.stage !== "completed"
                    ? () => archivePhoto(a.id)
                    : undefined
                }
              />
            ))}
          </div>
        )}
        <div className="mt-2 text-[10px] text-ink-muted">
          JPG / PNG / WEBP · up to 10 MB each.
        </div>
      </section>

      {/* Timeline */}
      <section className="mt-5 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Updates
        </h2>
        <ul className="space-y-3">
          {timeline.map((t) => (
            <li key={t.id} className="group border-l-2 border-border pl-3 text-[13px]">
              <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                <span>{formatDateTime(t.at)}</span>
                {/* Customer can retract their own comments */}
                {t.source === "customer" && t.action === "customer_comment" && cs.stage !== "completed" && (
                  <button
                    onClick={() => archiveComment(t.id)}
                    className="ml-auto rounded p-0.5 opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                    title="Remove this comment"
                    aria-label="Remove this comment"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
              <div>
                {t.source === "customer" && (
                  <span className="mr-1 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent">
                    You
                  </span>
                )}
                {t.label}
              </div>
              {t.note && <div className="mt-1 whitespace-pre-line text-ink-secondary">{t.note}</div>}
            </li>
          ))}
          {timeline.length === 0 && (
            <li className="text-[12px] text-ink-muted">No updates yet.</li>
          )}
        </ul>
      </section>

      {/* Comment box */}
      {cs.stage !== "completed" && (
        <section className="mt-5 rounded-lg border border-border bg-surface p-5">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Add an update or question
          </h2>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Our team will see this on the case…"
            className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            maxLength={2000}
          />
          <div className="mt-2 flex items-center justify-end">
            <button
              onClick={postComment}
              disabled={!comment.trim() || posting}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-white disabled:opacity-50"
            >
              <Send size={11} /> {posting ? "Posting…" : "Post update"}
            </button>
          </div>
        </section>
      )}

      {/* Completed-case satisfaction summary */}
      {cs.stage === "completed" && cs.satisfaction_rating && (
        <section className="mt-5 rounded-lg border border-border bg-surface p-5 text-center">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Thanks for your feedback
          </div>
          <div className="inline-flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <Star
                key={n}
                size={20}
                className={n <= (cs.satisfaction_rating ?? 0) ? "fill-amber-400 text-amber-400" : "text-ink-muted/40"}
              />
            ))}
          </div>
        </section>
      )}

      {err && (
        <div className="mt-4 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-sm text-err">
          {err}
        </div>
      )}

      {lightboxIndex !== null && attachments[lightboxIndex] && (
        <Lightbox
          attachments={attachments}
          token={token}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </PortalFrame>
  );
}

function PortalPhoto({ token, attId, label, source, onClick, onRemove }: {
  token: string;
  attId: number;
  label: string;
  source: string;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    portalApi
      .fetchBlobUrl(`/api/portal/case/attachments/${attId}`, token)
      .then((u) => { if (!revoked) setUrl(u); })
      .catch(() => {});
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [attId]);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        className="block w-full overflow-hidden rounded-md border border-border bg-bg text-left transition-all hover:border-accent/50 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2"
        aria-label={`View ${label} photo full-size`}
      >
        {url ? (
          <img
            src={url}
            alt={label}
            className="h-24 w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="h-24 w-full animate-pulse bg-ink-muted/10" />
        )}
        <div className="flex items-center justify-between px-1.5 py-1 text-[9px] uppercase tracking-wider text-ink-muted">
          <span>{label}</span>
          {source === "customer" && <span className="text-accent">You</span>}
        </div>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="absolute right-1 top-1 rounded-full bg-ink/75 p-1 text-white opacity-0 transition-opacity hover:bg-err group-hover:opacity-100 focus:opacity-100"
          title="Remove this photo"
          aria-label="Remove this photo"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

// ── Full-screen lightbox ─────────────────────────────────────
// Loads the currently-selected attachment at full resolution in a
// portal-ed overlay. Supports keyboard nav (←/→/Esc), clicking the
// backdrop to close, and swipe-like prev/next buttons on mobile.
function Lightbox({
  attachments,
  token,
  index,
  onChange,
  onClose,
}: {
  attachments: PortalCaseDetail["attachments"];
  token: string;
  index: number;
  onChange: (i: number) => void;
  onClose: () => void;
}) {
  const att = attachments[index];
  const [url, setUrl] = useState<string | null>(null);

  const go = useCallback(
    (delta: number) => {
      const next = (index + delta + attachments.length) % attachments.length;
      onChange(next);
    },
    [index, attachments.length, onChange]
  );

  // Keyboard handlers
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Load the current attachment as a blob URL
  useEffect(() => {
    setUrl(null);
    let revoked = false;
    portalApi
      .fetchBlobUrl(`/api/portal/case/attachments/${att.id}`, token)
      .then((u) => { if (!revoked) setUrl(u); })
      .catch(() => {});
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.id]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      {/* Top bar */}
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 px-4 py-3 text-white sm:px-6 sm:py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-[2pt]">
          <span className="rounded-full border border-white/30 px-2 py-0.5 font-semibold">
            {att.category}
          </span>
          {att.source === "customer" && (
            <span className="rounded-full bg-accent/90 px-2 py-0.5 font-semibold text-white">
              You
            </span>
          )}
          <span className="font-mono text-[10px] text-white/60">
            {index + 1} / {attachments.length}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <X size={18} />
        </button>
      </div>

      {/* Prev / next (only when there's more than 1 photo) */}
      {attachments.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); go(-1); }}
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:left-6"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); go(1); }}
            aria-label="Next photo"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:right-6"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      {/* Image */}
      <div
        className="relative flex max-h-[90vh] max-w-[92vw] items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          <img
            src={url}
            alt={att.file_name || att.category}
            className="max-h-[88vh] max-w-[92vw] select-none object-contain shadow-2xl"
            draggable={false}
          />
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded bg-white/5 text-white/60">
            Loading…
          </div>
        )}
      </div>

      {/* Caption / filename */}
      {att.file_name && (
        <div
          className="absolute inset-x-0 bottom-0 px-4 py-3 text-center text-[11px] text-white/70 sm:py-4"
          onClick={(e) => e.stopPropagation()}
        >
          {att.file_name}
        </div>
      )}
    </div>,
    document.body
  );
}
