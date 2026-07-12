import React from "react";
import { Skeleton } from "./Skeleton";

/**
 * Suspense fallback for lazily-loaded route chunks — a brand-tinted page
 * shape (header, KPI tiles, table block) instead of a blank screen or a
 * bare "Loading..." line. Pattern from Hookka's PageSkeleton.
 */
export function PageSkeleton() {
  return (
    <div className="space-y-6 p-1" aria-busy="true" aria-label="Loading page">
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-lg" />
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/**
 * Catches chunk-load failures after a redeploy (the old bundle references
 * hashed chunk files that no longer exist) and reloads the page once to
 * pick up the new build. Any other render error shows a compact retry
 * panel instead of a white screen.
 */
const RELOAD_FLAG = "chunk-reloaded-once";

function isStaleChunkError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|Failed to fetch dynamically imported|preload|module script|MIME type/i.test(
    msg,
  );
}

/**
 * HARD recovery after a redeploy strands the client. Purging Cache Storage
 * alone was NOT enough (owner 2026-07-04, "Something went wrong loading this
 * page" stuck across reloads): a still-registered OLD service worker keeps
 * intercepting fetches and can serve the app-shell HTML for a hashed
 * /assets/*.js request -> "Expected a JavaScript module but got text/html" ->
 * the import fails AGAIN after a plain reload. So we UNREGISTER every service
 * worker AND delete every cache, THEN reload — the next load fetches the fresh
 * build from the network and registers the current SW. Best-effort; always
 * reloads even if a step throws.
 */
async function hardRecover(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch {}
  try {
    if ("caches" in window) {
      const ks = await caches.keys();
      await Promise.all(ks.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch {}
  window.location.reload();
}

interface BoundaryState {
  error: Error | null;
}

export class ChunkReloadBoundary extends React.Component<
  { children: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    if (isStaleChunkError(error)) {
      try {
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
          sessionStorage.setItem(RELOAD_FLAG, "1");
          // Unregister the old SW + purge caches, THEN reload once (loop-
          // guarded) so the fresh hashed build is fetched from the network.
          void hardRecover();
          return;
        }
      } catch {
        window.location.reload();
      }
    }
  }

  componentDidUpdate(): void {
    // A successful render after navigation clears the one-shot guard.
    if (!this.state.error) {
      try {
        sessionStorage.removeItem(RELOAD_FLAG);
      } catch {}
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="text-sm font-medium text-ink">Something went wrong loading this page.</p>
          <p className="max-w-md text-xs text-ink-muted">
            Please reload to try again. If it keeps happening, let IT know.
          </p>
          <button
            onClick={() => {
              // Full recovery, not a plain reload: a plain reload kept failing
              // for the owner because the old SW re-served the stale shell.
              void hardRecover();
            }}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-ink hover:bg-surface-dim"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
