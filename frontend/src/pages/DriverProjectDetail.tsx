import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  MapPin,
  Phone,
  Camera,
  Paperclip,
  FileText,
  Play,
  Trash2,
  Wrench,
  Hammer,
  Truck,
} from "lucide-react";
import { useQuery } from "../hooks/useQuery";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { formatDate, formatDateTime, cn } from "../lib/utils";
import { MediaLightbox } from "../components/MediaLightbox";

interface DriverPhasePhoto {
  id: number;
  phase: "setup" | "dismantle";
  r2_key: string;
  content_type: string | null;
  caption: string | null;
  uploaded_by: number | null;
  uploaded_by_name: string | null;
  uploaded_at: string;
}

interface DriverDocumentAttachment {
  id: number;
  item_id: number;
  r2_key: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_at: string;
  uploaded_by_name: string | null;
}

interface DriverDocument {
  id: number;
  title: string;
  description: string | null;
  role_label: string | null;
  status: "pending" | "done" | "na" | "blocked";
  section_name: string | null;
  attachments: DriverDocumentAttachment[];
}

interface DriverProjectDetailResp {
  project: {
    id: number;
    code: string | null;
    name: string;
    brand: string | null;
    venue: string | null;
    venue_address: string | null;
    state: string | null;
    start_date: string | null;
    end_date: string | null;
    setup_start_at: string | null;
    setup_end_at: string | null;
    dismantle_start_at: string | null;
    dismantle_end_at: string | null;
    setup_helper_outsourced: number;
    dismantle_helper_outsourced: number;
    setup_lorry_plate: string | null;
    dismantle_lorry_plate: string | null;
    pic_name: string | null;
    pic_phone: string | null;
    setup_driver_name: string | null;
    setup_helper_1_name: string | null;
    setup_helper_2_name: string | null;
    setup_driver_phone: string | null;
    setup_helper_1_phone: string | null;
    setup_helper_2_phone: string | null;
    dismantle_driver_name: string | null;
    dismantle_helper_1_name: string | null;
    dismantle_helper_2_name: string | null;
    dismantle_driver_phone: string | null;
    dismantle_helper_1_phone: string | null;
    dismantle_helper_2_phone: string | null;
  };
  my_phases: Array<"setup" | "dismantle">;
  my_roles: { setup?: string; dismantle?: string };
  documents: DriverDocument[];
  photos: DriverPhasePhoto[];
}

/**
 * Driver-app project brief + per-phase photo upload.
 *
 * Crew member sees only the phases they are on. Photo uploads are
 * scoped to those phases server-side; the UI mirrors the gate.
 */
export function DriverProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id || "0", 10);
  const toast = useToast();
  const { user } = useAuth();
  const detail = useQuery<DriverProjectDetailResp>(
    () => api.get(`/api/driver/projects/${projectId}`),
    [projectId]
  );

  const [activeTab, setActiveTab] = useState<"setup" | "dismantle" | null>(null);

  useEffect(() => {
    if (!activeTab && detail.data?.my_phases.length) {
      setActiveTab(detail.data.my_phases[0]);
    }
  }, [detail.data, activeTab]);

  if (detail.loading) {
    return <div className="px-4 py-5 text-[12px] text-ink-secondary">Loading…</div>;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="px-4 py-5">
        <Link to="/driver/projects" className="mb-3 inline-flex items-center gap-1 text-[12px] text-ink-secondary">
          <ArrowLeft size={14} /> Back
        </Link>
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[13px] text-err">
          {detail.error || "Project not found"}
        </div>
      </div>
    );
  }

  const { project, my_phases, my_roles, photos, documents } = detail.data;
  const phaseToShow = activeTab ?? my_phases[0];

  return (
    <div className="px-4 py-5">
      <Link
        to="/driver/projects"
        className="mb-3 inline-flex items-center gap-1 text-[12px] text-ink-secondary"
      >
        <ArrowLeft size={14} /> Back
      </Link>

      <div className="mb-4">
        <h1 className="font-display text-[19px] font-extrabold leading-tight tracking-tight text-ink sm:text-[26px] lg:text-[28px]">
          {project.name}
        </h1>
        {project.brand && (
          <div className="mt-1 inline-block rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink">
            {project.brand}
          </div>
        )}
      </div>

      {/* Venue */}
      {(project.venue || project.venue_address) && (
        <div className="mb-3 rounded-lg border border-border bg-surface p-3">
          <div className="flex items-start gap-2">
            <MapPin size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
            <div className="min-w-0">
              {project.venue && (
                <div className="text-[13px] font-semibold text-ink">{project.venue}</div>
              )}
              {project.venue_address && (
                <a
                  href={`https://maps.google.com/?q=${encodeURIComponent(project.venue_address)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-[12px] text-ink-secondary underline-offset-2 hover:underline"
                >
                  {project.venue_address}
                </a>
              )}
            </div>
          </div>
          <div className="mt-2 text-[11px] text-ink-muted">
            Event: {formatDate(project.start_date)} – {formatDate(project.end_date)}
          </div>
        </div>
      )}

      {/* PIC */}
      {project.pic_name && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-surface p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-accent">
            <Phone size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              PIC
            </div>
            <div className="truncate text-[13px] font-semibold text-ink">
              {project.pic_name}
            </div>
          </div>
          {project.pic_phone && (
            <a
              href={`tel:${project.pic_phone}`}
              className="rounded-md border border-accent/40 px-3 py-1.5 text-[12px] font-semibold text-accent"
            >
              {project.pic_phone}
            </a>
          )}
        </div>
      )}

      {/* Documents — crew-visible tasklist items (mig 086). Sits above the
          phase tabs because these are project-level docs (booth layout,
          work permit, …), not phase-specific. Doesn't render when no
          documents are marked crew-visible. */}
      {documents.length > 0 && <DocumentsCard documents={documents} />}

      {/* Phase tabs */}
      {my_phases.length > 1 && (
        <div className="mb-3 grid grid-cols-2 rounded-md border border-border bg-surface p-1">
          {my_phases.map((p) => (
            <button
              key={p}
              onClick={() => setActiveTab(p)}
              className={cn(
                "flex items-center justify-center gap-1 rounded py-1.5 text-[12px] font-semibold uppercase tracking-wide transition-colors",
                phaseToShow === p
                  ? "bg-accent text-white"
                  : "text-ink-secondary"
              )}
            >
              {p === "setup" ? <Wrench size={12} /> : <Hammer size={12} />}
              {p}
            </button>
          ))}
        </div>
      )}

      {phaseToShow && (
        <PhasePanel
          projectId={project.id}
          phase={phaseToShow}
          myRole={my_roles[phaseToShow]}
          project={project}
          photos={photos.filter((p) => p.phase === phaseToShow)}
          currentUserId={user?.id ?? null}
          onReload={() => detail.reload()}
          toast={toast}
        />
      )}
    </div>
  );
}

function PhasePanel({
  projectId,
  phase,
  myRole,
  project,
  photos,
  currentUserId,
  onReload,
  toast,
}: {
  projectId: number;
  phase: "setup" | "dismantle";
  myRole?: string;
  project: DriverProjectDetailResp["project"];
  photos: DriverPhasePhoto[];
  currentUserId: number | null;
  onReload: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const window =
    phase === "setup"
      ? { start: project.setup_start_at, end: project.setup_end_at }
      : { start: project.dismantle_start_at, end: project.dismantle_end_at };
  const lorry =
    phase === "setup" ? project.setup_lorry_plate : project.dismantle_lorry_plate;
  const outsourced =
    phase === "setup"
      ? !!project.setup_helper_outsourced
      : !!project.dismantle_helper_outsourced;

  const crewNames =
    phase === "setup"
      ? [
          { name: project.setup_driver_name, phone: project.setup_driver_phone, role: "Driver" },
          { name: project.setup_helper_1_name, phone: project.setup_helper_1_phone, role: "Helper 1" },
          { name: project.setup_helper_2_name, phone: project.setup_helper_2_phone, role: "Helper 2" },
        ]
      : [
          { name: project.dismantle_driver_name, phone: project.dismantle_driver_phone, role: "Driver" },
          { name: project.dismantle_helper_1_name, phone: project.dismantle_helper_1_phone, role: "Helper 1" },
          { name: project.dismantle_helper_2_name, phone: project.dismantle_helper_2_phone, role: "Helper 2" },
        ];

  return (
    <div className="space-y-3">
      {myRole && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-[12px] text-accent">
          Your role: <span className="font-bold">{myRole}</span>
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Phase window
        </div>
        <div className="mt-1 text-[13px] font-semibold text-ink">
          {formatPhaseRange(window.start, window.end)}
        </div>
        {lorry && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
            <Truck size={13} />
            <span className="font-mono">{lorry}</span>
          </div>
        )}
        {outsourced && (
          <div className="mt-2 text-[11px] text-ink-muted">
            Helpers supplied by contractor.
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Crew
        </div>
        <div className="space-y-1.5">
          {crewNames.map((c, i) =>
            c.name ? (
              <div key={i} className="flex items-center justify-between gap-2 text-[12.5px]">
                <div className="min-w-0">
                  <span className="text-ink-muted">{c.role}:</span>{" "}
                  <span className="font-semibold text-ink">{c.name}</span>
                </div>
                {c.phone && (
                  <a
                    href={`tel:${c.phone}`}
                    className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-ink-secondary"
                  >
                    {c.phone}
                  </a>
                )}
              </div>
            ) : null
          )}
        </div>
      </div>

      <PhotoUploader
        projectId={projectId}
        phase={phase}
        onUploaded={onReload}
        toast={toast}
      />

      <PhotoGrid
        photos={photos}
        phase={phase}
        currentUserId={currentUserId}
        onChanged={onReload}
        toast={toast}
      />
    </div>
  );
}

// Maps a filename to its upload ext (must match the backend MIME_BY_EXT map).
function extFromName(name: string): string | null {
  const lower = name.toLowerCase();
  const ALLOWED = [
    "jpg", "jpeg", "png", "webp", "heic",
    "pdf", "xlsx", "docx",
    "mp4", "mov", "webm", "m4v",
  ];
  for (const ext of ALLOWED) {
    if (lower.endsWith(`.${ext}`)) return ext;
  }
  return null;
}

const MIME_BY_EXT_CLIENT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
};

function PhotoUploader({
  projectId,
  phase,
  onUploaded,
  toast,
}: {
  projectId: number;
  phase: "setup" | "dismantle";
  onUploaded: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState("");

  async function handleFile(file: File, fallbackCaption?: string) {
    const ext = extFromName(file.name) ?? "jpg";
    const mime = MIME_BY_EXT_CLIENT[ext];
    setBusy(true);
    try {
      const { key, mime_type } = await api.putBinary<{ key: string; mime_type: string }>(
        `/api/driver/projects/${projectId}/photos/upload?phase=${phase}&ext=${ext}`,
        file,
        mime
      );
      // For non-image attachments, default the caption to the filename so
      // the office side has something readable in the list.
      const isImage = mime_type.startsWith("image/");
      const isVideo = mime_type.startsWith("video/");
      const finalCaption =
        caption.trim() || (isImage || isVideo ? null : fallbackCaption || file.name);
      await api.post(`/api/driver/projects/${projectId}/photos`, {
        phase,
        r2_key: key,
        content_type: mime_type,
        caption: finalCaption,
      });
      setCaption("");
      toast.success(
        isImage ? "Photo uploaded" : isVideo ? "Video uploaded" : "File uploaded"
      );
      onUploaded();
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setBusy(false);
      if (cameraRef.current) cameraRef.current.value = "";
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Add {phase} evidence
      </div>
      <input
        type="text"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="Caption (optional)"
        className="mb-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*,video/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*,application/pdf,.pdf,.xlsx,.docx,.mp4,.mov,.webm,.m4v"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (!extFromName(f.name)) {
            toast.error("Unsupported file type");
            if (fileRef.current) fileRef.current.value = "";
            return;
          }
          handleFile(f);
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => cameraRef.current?.click()}
          disabled={busy}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md border py-3 text-[12px] font-bold uppercase tracking-wide",
            busy
              ? "border-border bg-bg text-ink-muted"
              : "border-accent bg-accent text-white"
          )}
        >
          <Camera size={15} />
          Photo
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md border py-3 text-[12px] font-bold uppercase tracking-wide",
            busy
              ? "border-border bg-bg text-ink-muted"
              : "border-border text-ink hover:border-accent/50"
          )}
        >
          <Paperclip size={15} />
          File
        </button>
      </div>
      {busy && (
        <div className="mt-2 text-center text-[11px] text-ink-secondary">Uploading…</div>
      )}
      <div className="mt-2 text-[10px] text-ink-muted">
        Photos + videos play inline. PDF / XLSX / DOCX open as a download. Max 50 MB.
      </div>
    </div>
  );
}

function PhotoGrid({
  photos,
  phase,
  currentUserId,
  onChanged,
  toast,
}: {
  photos: DriverPhasePhoto[];
  phase: "setup" | "dismantle";
  currentUserId: number | null;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  async function handleDelete(photo: DriverPhasePhoto) {
    const isVideo = (photo.content_type || "").startsWith("video/");
    const kind = isVideo ? "video" : "photo";
    const ok = await dialog.confirm({
      title: `Delete this ${kind}?`,
      message: photo.caption
        ? `"${photo.caption}" will be removed from the ${photo.phase} record. This can't be undone.`
        : `This ${kind} will be removed from the ${photo.phase} record. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeleting(photo.id);
    try {
      await api.del(`/api/projects/phase-photos/${photo.id}`);
      toast.success("Deleted");
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Failed to delete");
    } finally {
      setDeleting(null);
    }
  }

  if (photos.length === 0) {
    return (
      <EmptyState
        compact
        message="No evidence yet. Capture a photo or upload a file to record what was done."
      />
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {photos.map((p, i) => (
          <PhotoThumb
            key={p.id}
            photo={p}
            isMine={currentUserId != null && p.uploaded_by === currentUserId}
            isDeleting={deleting === p.id}
            onOpen={() => setLightboxIndex(i)}
            onDelete={() => handleDelete(p)}
          />
        ))}
      </div>
      {lightboxIndex !== null && (
        <MediaLightbox
          items={photos}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          baseUrl="/api/projects/attachments"
          badge={phase}
        />
      )}
    </>
  );
}

function PhotoThumb({
  photo,
  isMine,
  isDeleting,
  onOpen,
  onDelete,
}: {
  photo: DriverPhasePhoto;
  isMine: boolean;
  isDeleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const isImage = (photo.content_type || "").startsWith("image/");
  const isVideo = (photo.content_type || "").startsWith("video/");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    let revoke: string | null = null;
    api
      .fetchBlobUrl(`/api/projects/attachments/${photo.r2_key}`)
      .then((u) => {
        revoke = u;
        setUrl(u);
      })
      .catch(() => {});
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [photo.r2_key, isImage]);

  // Container is a div so we can nest a separate Delete button. The
  // thumb itself stays a button for accessibility. Delete only shows
  // when the driver is the uploader — the backend enforces the same
  // rule, this is just so the trash icon doesn't dangle uselessly on
  // someone else's upload.
  return (
    <div className={cn(
      "relative overflow-hidden rounded-md border border-border bg-surface",
      isDeleting && "opacity-50 pointer-events-none"
    )}>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full text-left active:bg-paper"
        aria-label="Open preview"
      >
        <div className="aspect-square bg-bg">
          {isImage ? (
            url ? (
              <img src={url} alt={photo.caption || ""} className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full" />
            )
          ) : isVideo ? (
            <div className="relative flex h-full w-full items-center justify-center bg-ink/90">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 shadow-lg">
                <Play size={20} className="ml-0.5 text-ink" fill="currentColor" />
              </div>
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[8px] font-bold uppercase tracking-wider text-white">
                {extFromKey(photo.r2_key) || "Video"}
              </span>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center">
              <FileText size={28} className="text-ink-secondary" />
              <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                {extFromKey(photo.r2_key) || "File"}
              </div>
            </div>
          )}
        </div>
        {photo.caption && (
          <div className="truncate px-2 py-1 text-[11px] text-ink-secondary">
            {photo.caption}
          </div>
        )}
      </button>
      {isMine && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          disabled={isDeleting}
          aria-label="Delete this upload"
          title="Delete this upload"
          className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-err/90 disabled:opacity-40"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

function extFromKey(key: string): string | null {
  const m = key.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : null;
}

function formatPhaseRange(start: string | null, end: string | null): string {
  if (!start && !end) return "Not scheduled";
  return `${formatDateTime(start)} → ${formatDateTime(end)}`;
}

// ── Documents card (mig 086) ───────────────────────────────────────
// Read-only window into the project's crew-visible tasklist rows. Each
// row shows the title + role tag + status, and a row of attachment
// chips below. Tap an image → opens MediaLightbox; tap a PDF/xlsx/docx
// → opens it in a new tab.

const STATUS_PILL: Record<string, string> = {
  pending: "bg-warning-bg text-warning-text",
  done: "bg-synced/15 text-synced",
  na: "bg-bg/40 text-ink-muted",
  blocked: "bg-err/15 text-err",
};

function DocumentsCard({ documents }: { documents: DriverDocument[] }) {
  // Group by section_name so the driver sees "Booth Layout & Setup",
  // "Expo Map", etc. as headings — mirrors the office side.
  const groups = useMemo(() => {
    const m = new Map<string, DriverDocument[]>();
    for (const d of documents) {
      const key = d.section_name || "General";
      const arr = m.get(key) ?? [];
      arr.push(d);
      m.set(key, arr);
    }
    return Array.from(m.entries());
  }, [documents]);

  // Flatten the playable attachments (images + videos) so the lightbox
  // can step through every preview-able file in the card, not just one
  // document's. PDF/xlsx/docx open in a new tab and don't participate.
  const allImages = useMemo(
    () =>
      documents
        .flatMap((d) => d.attachments)
        .filter((a) => {
          const t = a.content_type || "";
          return t.startsWith("image/") || t.startsWith("video/");
        })
        .map((a) => ({
          r2_key: a.r2_key,
          content_type: a.content_type,
          caption: a.file_name,
        })),
    [documents]
  );
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <FileText size={14} className="text-ink-secondary" />
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Documents
        </div>
      </div>
      <div className="space-y-3">
        {groups.map(([sectionName, docs]) => (
          <div key={sectionName}>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              {sectionName}
            </div>
            <div className="space-y-1.5">
              {docs.map((d) => (
                <DocumentRow
                  key={d.id}
                  doc={d}
                  onOpenImage={(r2_key) => {
                    const idx = allImages.findIndex((a) => a.r2_key === r2_key);
                    if (idx >= 0) setLightboxIndex(idx);
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {lightboxIndex !== null && (
        <MediaLightbox
          items={allImages}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          baseUrl="/api/projects/attachments"
          badge="Documents"
        />
      )}
    </div>
  );
}

function DocumentRow({
  doc,
  onOpenImage,
}: {
  doc: DriverDocument;
  onOpenImage: (r2_key: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-bg/30 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex-1 truncate text-[13px] font-semibold text-ink">
          {doc.title}
        </div>
        {doc.role_label && (
          <span className="rounded-full border border-border bg-bg/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-ink-secondary">
            {doc.role_label}
          </span>
        )}
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
            STATUS_PILL[doc.status] || STATUS_PILL.pending
          )}
        >
          {doc.status}
        </span>
      </div>
      {doc.description && (
        <div className="mt-0.5 text-[11.5px] text-ink-secondary">{doc.description}</div>
      )}
      {doc.attachments.length === 0 ? (
        <div className="mt-1.5 text-[11px] italic text-ink-muted">No file yet</div>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {doc.attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} onOpenImage={onOpenImage} />
          ))}
        </div>
      )}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onOpenImage,
}: {
  attachment: DriverDocumentAttachment;
  onOpenImage: (r2_key: string) => void;
}) {
  const t = attachment.content_type || "";
  const isPlayable = t.startsWith("image/") || t.startsWith("video/");
  const isVideo = t.startsWith("video/");
  const [busy, setBusy] = useState(false);

  async function openFile() {
    if (isPlayable) {
      onOpenImage(attachment.r2_key);
      return;
    }
    setBusy(true);
    try {
      const url = await api.fetchBlobUrl(
        `/api/projects/attachments/${attachment.r2_key}`
      );
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // toast surfaced through the parent if needed
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={openFile}
      disabled={busy}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11px] hover:border-accent/40 hover:text-accent disabled:opacity-50"
      title={attachment.file_name}
    >
      {isVideo ? <Play size={11} className="shrink-0" /> : <FileText size={11} className="shrink-0" />}
      <span className="truncate">{attachment.file_name}</span>
    </button>
  );
}
