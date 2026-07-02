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
  return /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|Failed to fetch dynamically imported|preload/i.test(
    msg,
  );
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
          // A poisoned/old service-worker cache can keep serving a stale or
          // empty asset even after a redeploy (so a plain reload re-fails).
          // Purge all caches first, then reload once (guarded against loops),
          // so the fresh hashed build is fetched from the network.
          const reload = () => window.location.reload();
          if ("caches" in window) {
            caches
              .keys()
              .then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
              .finally(reload);
          } else {
            reload();
          }
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
              this.setState({ error: null });
              window.location.reload();
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
