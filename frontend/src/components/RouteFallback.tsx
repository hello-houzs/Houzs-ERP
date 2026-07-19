import React from "react";
import { useLocation } from "react-router-dom";
import { Skeleton } from "./Skeleton";
import { reportClientError } from "../lib/errorReporter";

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
const RECOVER_AT_KEY = "chunk-recovered-at";
/** A recovery that didn't stick must not immediately trigger another one. Any
 *  chunk error within this window of the last attempt shows the panel instead.
 *  Time-based, not once-per-session: a tab left open across a LATER deploy
 *  still self-heals once. */
const RECOVER_COOLDOWN_MS = 60_000;
/** hardRecover() always ends in reload(), but its awaits (SW unregister, cache
 *  delete) are not guaranteed to settle. Don't strand the user on a skeleton. */
const RECOVER_TIMEOUT_MS = 10_000;

/** Whether we may self-heal now. False when we already tried within the
 *  cooldown — or when sessionStorage is unavailable, since without a memory
 *  across reloads an auto-reload would loop forever. */
function canHardRecover(): boolean {
  try {
    const prev = Number(sessionStorage.getItem(RECOVER_AT_KEY) ?? 0);
    return !prev || Date.now() - prev > RECOVER_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markHardRecover(): boolean {
  try {
    sessionStorage.setItem(RECOVER_AT_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

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
  /** Self-heal is in flight. Renders the page skeleton, NOT the error panel:
   *  hardRecover() is async, so showing the panel here is what made the owner
   *  see "error 先然後再 loading 出來" — the crash flashed for the few hundred
   *  ms until the reload landed, on a load that then recovered fine. */
  recovering: boolean;
}

interface BoundaryProps {
  children: React.ReactNode;
  /** Changes when the route changes — a crash is cleared on navigation so one
   *  page's render error never bricks the whole shell. */
  resetKey?: string;
}

export class ChunkReloadBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, recovering: false };
  private recoverTimer: number | null = null;

  static getDerivedStateFromError(error: Error): BoundaryState {
    // Decide the RENDER here, in the same commit that catches: a stale chunk we
    // are about to self-heal shows the skeleton; anything else shows the panel.
    return { error, recovering: isStaleChunkError(error) && canHardRecover() };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (isStaleChunkError(error)) {
      // markHardRecover() returning false means sessionStorage is unusable, so
      // we can't remember this attempt — reloading blind would loop. Show the
      // panel and let the user press Reload.
      if (canHardRecover() && markHardRecover()) {
        // Unregister the old SW + purge caches, THEN reload once (cooldown-
        // guarded) so the fresh hashed build is fetched from the network.
        void hardRecover();
        return;
      }
      // A reload already failed to fix it — surface it instead of looping.
      console.error("[chunk-recover] stale chunk error persisted:", error?.message ?? error);
      // Report the PERSISTED case only: routine post-deploy chunk misses
      // self-heal silently above and would be pure noise, but a recovery that
      // did not stick means a user is staring at the panel — IT should know.
      reportClientError(error, "stale-chunk-persisted");
      this.setState({ recovering: false });
      return;
    }
    // A real render error (bad data shape, unguarded access, ...). Log it so
    // IT can find and fix the underlying page bug instead of it recurring
    // invisibly behind the generic panel.
    console.error("[route-crash]", error?.message ?? error, info?.componentStack ?? "");
    // Report AND fall through to the fallback render — never swallow, never
    // change behaviour. React catches render errors before window.onerror can,
    // so without this call a white-screen class of crash would stay invisible
    // to the daily digest. reportClientError never throws and never loops.
    reportClientError(error, "route-crash");
  }

  componentDidUpdate(prevProps: BoundaryProps, prevState: BoundaryState): void {
    if (this.state.recovering && !prevState.recovering) {
      this.recoverTimer = window.setTimeout(() => {
        // The reload never landed — stop pretending to load and show the panel.
        this.setState({ recovering: false });
      }, RECOVER_TIMEOUT_MS);
    }
    // Recover on navigation: when the route changes while a crash is showing,
    // clear it so the destination page renders. A single boundary wraps every
    // route, so without this a crash on one page persists app-wide until a
    // full reload (owner 2026-07-13: "整个 system 都崩溃掉了").
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.clearRecoverTimer();
      this.setState({ error: null, recovering: false });
    }
    // NOTE: the recovery guard is deliberately NOT cleared on a successful
    // render. It used to be, which re-armed it the moment the app shell
    // rendered — so a chunk error arriving right after (the lazy route
    // resolving) could reload again, and again. The cooldown replaces it.
  }

  componentWillUnmount(): void {
    this.clearRecoverTimer();
  }

  private clearRecoverTimer(): void {
    if (this.recoverTimer !== null) {
      window.clearTimeout(this.recoverTimer);
      this.recoverTimer = null;
    }
  }

  render() {
    // Self-heal in flight: keep showing "loading", the reload is coming.
    if (this.state.recovering) return <PageSkeleton />;
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="text-sm font-medium text-ink">Something went wrong loading this page.</p>
          <p className="max-w-md text-xs text-ink-muted">
            Please reload to try again. If it keeps happening, let IT know.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                // Full recovery, not a plain reload: a plain reload kept failing
                // for the owner because the old SW re-served the stale shell.
                markHardRecover();
                this.setState({ recovering: true });
                void hardRecover();
              }}
              className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-ink hover:bg-surface-dim"
            >
              Reload
            </button>
            <a
              href="/"
              className="rounded-lg px-4 py-2 text-sm font-medium text-ink-secondary hover:text-ink hover:bg-surface-dim"
            >
              Go to overview
            </a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Location-aware wrapper for ChunkReloadBoundary. Feeds the current pathname as
 * the reset key so a page crash is cleared the moment the user navigates
 * elsewhere (in-app nav via the sidebar recovers without a reload). Use this at
 * the app shell instead of ChunkReloadBoundary directly.
 */
export function RouteCrashBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return <ChunkReloadBoundary resetKey={location.pathname}>{children}</ChunkReloadBoundary>;
}
