import { RefreshCw } from "lucide-react";
import { useVersionCheck } from "../hooks/useVersionCheck";

/**
 * NewVersionBanner — a non-blocking "a newer version is ready" prompt.
 *
 * Mounted ONCE near the app root. When useVersionCheck detects that a newer
 * build is live (the deployed index.html now references a different entry
 * chunk), it shows a small bottom-centre banner with a "Reload now" button.
 * We never reload from under the operator — they click when they're ready, so
 * a deploy mid-data-entry can't wipe their work.
 *
 * Complements the service-worker VERSION bump (cache layer) and
 * ChunkReloadBoundary (crash self-heal); this is the no-crash runtime layer.
 * Styled with Houzs's Tailwind tokens to match PwaBanners.
 */
export function NewVersionBanner() {
  const { updateReady } = useVersionCheck();
  if (!updateReady) return null;

  return (
    <div
      className="fixed bottom-3 left-1/2 z-[100] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-ink px-4 py-2.5 text-[12.5px] text-white shadow-slab sm:bottom-6"
      role="status"
      aria-live="polite"
    >
      <span className="truncate">A newer version of the system is ready.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[11px] font-bold text-white hover:bg-accent-hover"
      >
        <RefreshCw size={14} strokeWidth={2} />
        Reload now
      </button>
    </div>
  );
}
