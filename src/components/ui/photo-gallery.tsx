"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, X, Image as ImageIcon, FileText } from "lucide-react";
import {
  addPhoto, deletePhoto, useEventPhotos, formatBytes,
  PHOTO_CATEGORIES, type PhotoCategory, type PhotoRecord,
} from "@/lib/photos-store";

/** Managed object URL — creates on mount, revokes on unmount */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) { setUrl(null); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function Thumb({
  photo,
  onClick,
  onDelete,
}: {
  photo: PhotoRecord;
  onClick: () => void;
  onDelete: () => void;
}) {
  const url = useObjectUrl(photo.blob);
  const isImage = photo.mimeType.startsWith("image/");

  return (
    <div className="relative group rounded-md border border-[#DDE5E5] overflow-hidden bg-[#FAFBFB] aspect-square">
      {isImage && url ? (
        <button
          type="button"
          onClick={onClick}
          className="absolute inset-0 w-full h-full"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={photo.filename} className="w-full h-full object-cover" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="absolute inset-0 w-full h-full flex flex-col items-center justify-center gap-1 p-2 text-gray-500"
        >
          <FileText className="h-6 w-6" />
          <div className="text-[9px] text-center truncate w-full px-1">{photo.filename}</div>
        </button>
      )}

      {/* Hover overlay with filename + delete */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5 opacity-0 group-hover:opacity-100 transition pointer-events-none">
        <div className="text-[9px] text-white truncate">{photo.filename}</div>
        <div className="text-[8px] text-gray-300">{formatBytes(photo.size)}</div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition inline-flex items-center justify-center hover:bg-red-600"
        title="Delete"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function Lightbox({
  photo,
  onClose,
}: {
  photo: PhotoRecord;
  onClose: () => void;
}) {
  const url = useObjectUrl(photo.blob);
  const isImage = photo.mimeType.startsWith("image/");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 h-9 w-9 rounded-full bg-white/10 text-white hover:bg-white/20 inline-flex items-center justify-center"
      >
        <X className="h-5 w-5" />
      </button>
      <div
        className="max-w-5xl max-h-[90vh] flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {isImage && url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={url} alt={photo.filename} className="max-w-full max-h-[80vh] object-contain rounded" />
        ) : (
          <div className="bg-white rounded p-8 flex flex-col items-center gap-3">
            <FileText className="h-16 w-16 text-gray-400" />
            <div className="text-sm text-gray-600">{photo.filename}</div>
            {url && (
              <a href={url} download={photo.filename} className="text-[11px] text-[#0F766E] font-semibold hover:underline">
                Download
              </a>
            )}
          </div>
        )}
        <div className="text-[11px] text-white/80 text-center">
          <div className="font-semibold">{photo.filename}</div>
          <div className="text-white/60">
            {formatBytes(photo.size)} · {new Date(photo.uploadedAt).toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  );
}

function CategorySection({
  eventA42,
  category,
  label,
  desc,
  photos,
  onOpen,
}: {
  eventA42: string;
  category: PhotoCategory;
  label: string;
  desc: string;
  photos: PhotoRecord[];
  onOpen: (p: PhotoRecord) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        await addPhoto(eventA42, category, f);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    await onFiles(e.dataTransfer.files);
  }

  return (
    <div className="rounded-md border border-[#DDE5E5] overflow-hidden">
      <div className="px-3 py-2 bg-[#FAFBFB] border-b border-[#F0F3F3] flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-[#0A1F2E]">{label}</div>
          <div className="text-[9px] text-gray-500 truncate">{desc}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[9px] font-semibold text-gray-400">{photos.length}</span>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="h-7 px-2 rounded border border-[#0F766E] text-[10px] font-semibold text-[#0F766E] hover:bg-[#0F766E] hover:text-white inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Upload className="h-3 w-3" /> {uploading ? "Uploading…" : "Upload"}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/*,application/pdf"
            onChange={(e) => onFiles(e.target.files)}
            className="hidden"
          />
        </div>
      </div>
      {error && (
        <div className="px-3 py-1.5 bg-red-50 text-[10px] text-red-700 border-b border-red-100">
          {error}
        </div>
      )}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="p-3"
      >
        {photos.length === 0 ? (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="w-full border border-dashed border-[#DDE5E5] rounded-md p-4 text-center text-[10px] text-gray-400 hover:border-[#0F766E] hover:text-[#0F766E] transition inline-flex flex-col items-center gap-1.5"
          >
            <ImageIcon className="h-5 w-5" />
            <span>Drop files or click to upload</span>
          </button>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
            {photos.map((p) => (
              <Thumb
                key={p.id}
                photo={p}
                onClick={() => onOpen(p)}
                onDelete={() => deletePhoto(p.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function PhotoGallery({ eventA42 }: { eventA42: string }) {
  const { photos, loading } = useEventPhotos(eventA42);
  const [lightbox, setLightbox] = useState<PhotoRecord | null>(null);

  if (loading) {
    return <div className="text-[11px] text-gray-400 p-4">Loading photos…</div>;
  }

  return (
    <div className="space-y-3">
      {PHOTO_CATEGORIES.map((cat) => (
        <CategorySection
          key={cat.key}
          eventA42={eventA42}
          category={cat.key}
          label={cat.label}
          desc={cat.desc}
          photos={photos.filter((p) => p.category === cat.key)}
          onOpen={setLightbox}
        />
      ))}
      {lightbox && <Lightbox photo={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
