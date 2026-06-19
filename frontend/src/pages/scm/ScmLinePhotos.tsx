// ----------------------------------------------------------------------------
// ScmLinePhotos — read-only thumbnail strip + lightbox for a SO / consignment
// line item's R2-backed photos.
//
// The `photo_urls` array holds R2 object KEYS (e.g. "so-items/<doc>/<item>/
// <uuid>.jpg" — they contain slashes). Each photo is served by an auth-gated
// proxy GET that takes the key as a SINGLE encoded path param:
//   GET <basePath>/photos/<encodeURIComponent(key)>
// <img src> can't carry the Authorization header, so we pull each one through
// api.fetchBlobUrl and render the resulting blob: URL. Blob URLs are revoked on
// unmount / when the key set changes to avoid leaks.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api } from "../../api/client";

/** Normalise the per-line photo field (pg camelCase dual-read + unknown JSON). */
export function readPhotoKeys(it: { photo_urls?: unknown; photoUrls?: unknown }): string[] {
  const raw = (it.photo_urls ?? it.photoUrls) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string" && k.length > 0);
}

/**
 * @param basePath proxy-GET prefix WITHOUT the trailing "/photos/<key>", e.g.
 *   `${SCM}/mfg-sales-orders/<docNo>/items/<itemId>`. The component appends
 *   `/photos/<encodeURIComponent(key)>` per photo.
 */
export function ScmLinePhotos({ basePath, photoKeys }: { basePath: string; photoKeys: string[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<number | null>(null);

  const keyJoin = photoKeys.join("\n");

  useEffect(() => {
    if (photoKeys.length === 0) return;
    let revoked = false;
    const created: string[] = [];
    Promise.all(
      photoKeys.map(async (key) => {
        try {
          const url = await api.fetchBlobUrl(`${basePath}/photos/${encodeURIComponent(key)}`);
          return [key, url] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (revoked) {
        pairs.forEach((p) => p && URL.revokeObjectURL(p[1]));
        return;
      }
      const next: Record<string, string> = {};
      pairs.forEach((p) => {
        if (p) {
          next[p[0]] = p[1];
          created.push(p[1]);
        }
      });
      setUrls(next);
    });
    return () => {
      revoked = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, keyJoin]);

  if (photoKeys.length === 0) return null;

  const openUrl = open != null ? urls[photoKeys[open]] : undefined;

  return (
    <div className="flex flex-wrap gap-1.5">
      {photoKeys.map((key, i) => {
        const url = urls[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => url && setOpen(i)}
            disabled={!url}
            className="h-12 w-12 overflow-hidden rounded border border-border bg-surface-dim transition-opacity hover:opacity-80 disabled:cursor-default"
            aria-label={`View photo ${i + 1}`}
          >
            {url ? (
              <img src={url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" draggable={false} />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[9px] text-ink-muted">…</span>
            )}
          </button>
        );
      })}

      {open != null && openUrl && (
        <Lightbox url={openUrl} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
      >
        <X size={18} />
      </button>
      <img
        src={url}
        alt=""
        className="max-h-[88vh] max-w-[92vw] select-none object-contain shadow-2xl"
        draggable={false}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
