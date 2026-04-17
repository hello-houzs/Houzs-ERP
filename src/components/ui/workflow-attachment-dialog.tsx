// Per-workflow attachment dialog — click a BD workflow checkpoint
// (e.g. "Floorplan", "Agreement / Quotation Approval") to view existing
// files or drop new ones. Photos are stored in IndexedDB and tagged with
// (eventA42, workflowKey), so each checkpoint has its own attachment set.

import { useEffect, useRef, useState } from "react";
import { X, Upload, Trash2, FileText, Image as ImageIcon, Download } from "lucide-react";
import {
  addPhoto, deletePhoto, useEventPhotos, formatBytes,
  type PhotoRecord,
} from "@/lib/photos-store";

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

function AttachmentRow({ photo }: { photo: PhotoRecord }) {
  const url = useObjectUrl(photo.blob);
  const isImage = photo.mimeType.startsWith("image/");
  return (
    <div className="flex items-center gap-3 px-3 py-2 border border-[#DDE5E5] rounded-md hover:bg-[#F4F7F7]">
      <div className="h-12 w-12 rounded bg-[#FAFBFB] border border-[#F0F3F3] overflow-hidden shrink-0 flex items-center justify-center">
        {isImage && url ? (
          <img src={url} alt={photo.filename} className="w-full h-full object-cover" />
        ) : (
          <FileText className="h-5 w-5 text-gray-400" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold text-[#0A1F2E] truncate">{photo.filename}</div>
        <div className="text-[9px] text-gray-500 tabular-nums">
          {formatBytes(photo.size)} · {new Date(photo.uploadedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
        </div>
      </div>
      {url && (
        <a
          href={url}
          download={photo.filename}
          className="h-7 w-7 rounded inline-flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#0F766E]/10 shrink-0"
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      )}
      <button
        type="button"
        onClick={() => deletePhoto(photo.id)}
        className="h-7 w-7 rounded inline-flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 shrink-0"
        title="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function WorkflowAttachmentDialog({
  eventA42,
  workflowKey,
  label,
  onClose,
}: {
  eventA42: string;
  workflowKey: string;
  label: string;
  onClose: () => void;
}) {
  const { photos, loading } = useEventPhotos(eventA42);
  const scoped = photos.filter((p) => p.workflowKey === workflowKey);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        await addPhoto(eventA42, "OTHER", f, workflowKey);
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
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Attachments</div>
            <h3 className="text-[14px] font-bold text-[#0A1F2E] truncate">{label}</h3>
            <p className="text-[10px] text-gray-500 mt-0.5">{scoped.length} file(s) · drop or click to upload</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded inline-flex items-center justify-center text-gray-400 hover:text-[#0A1F2E] hover:bg-gray-100 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="flex-1 overflow-y-auto p-4 space-y-2"
        >
          {error && (
            <div className="px-3 py-2 rounded bg-red-50 text-[10px] text-red-700 border border-red-100">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-[11px] text-gray-400 text-center py-8">Loading…</div>
          ) : scoped.length === 0 ? (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="w-full border-2 border-dashed border-[#DDE5E5] rounded-md py-10 text-center text-[11px] text-gray-400 hover:border-[#0F766E] hover:text-[#0F766E] transition flex flex-col items-center gap-2"
            >
              <ImageIcon className="h-6 w-6" />
              <span>Drop files or click to upload</span>
              <span className="text-[9px] text-gray-300">Images or PDF</span>
            </button>
          ) : (
            scoped.map((p) => <AttachmentRow key={p.id} photo={p} />)
          )}
        </div>

        {/* Footer — upload button */}
        <div className="px-4 py-3 border-t border-[#DDE5E5] bg-[#FAFBFB] flex items-center justify-between">
          <span className="text-[10px] text-gray-400">Stored locally in IndexedDB</span>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="h-8 px-3 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            {uploading ? "Uploading…" : "Upload files"}
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
    </div>
  );
}
