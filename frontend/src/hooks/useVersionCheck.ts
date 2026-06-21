// ---------------------------------------------------------------------------
// Deploy-churn recovery — RUNTIME layer (adapted from 2990's use-version-check,
// itself ported from HOOKKA).
//
// Houzs already recovers from a redeploy two other ways:
//   • the service worker bumps its VERSION (public/sw.js) → the cache layer,
//   • ChunkReloadBoundary (components/RouteFallback.tsx) catches a failed lazy
//     import() of a now-missing hashed chunk and hard-reloads once.
//
// This adds the COMPLEMENTARY piece those two don't cover: detect that a newer
// build is live WHILE the tab is still happily running the old one (no crash,
// no navigation), and offer a non-blocking "Reload now" banner. We never reload
// from under the operator — a deploy mid-data-entry can't wipe their work; they
// click when ready. It does NOT touch the service worker.
//
// No new backend route: reads the static index.html the SPA already serves.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

// Vite emits ONE hashed entry module (e.g. /assets/index-AbC123.js). Its
// filename changes on every build, so it's a free build id.
function assetHashFrom(src: string): string | null {
  const m = src.match(/\/assets\/([A-Za-z0-9_.-]+\.js)/);
  return m?.[1] ?? null;
}

/** The entry-chunk filename this tab booted with (null if we can't tell — e.g.
    the dev server serves /src/main.tsx, not a hashed asset — then version
    checking is simply skipped, never wrong). */
function bootBuildId(): string | null {
  const scripts = Array.from(
    document.querySelectorAll('script[type="module"][src*="/assets/"]'),
  ) as HTMLScriptElement[];
  for (const s of scripts) {
    const h = assetHashFrom(s.src);
    if (h) return h;
  }
  return null;
}

function latestBuildIdFrom(html: string): string | null {
  // Match the ENTRY module <script ... src="/assets/xxx.js"> specifically, so
  // we compare like-for-like with bootBuildId() (NOT a <link modulepreload>,
  // which would differ from the entry and false-positive every check).
  const m = html.match(
    /<script[^>]+type=["']module["'][^>]*\bsrc=["'](\/assets\/[A-Za-z0-9_.-]+\.js)["']/i,
  );
  return m?.[1] ? assetHashFrom(m[1]) : null;
}

/** Poll the deployed index.html for a changed entry chunk. Returns
    `updateReady` once a newer build is live; the caller decides when to reload
    (we never reload from under the operator). Pauses while the tab is hidden. */
export function useVersionCheck(intervalMs = 5 * 60_000): { updateReady: boolean } {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const boot = bootBuildId();
    if (!boot) return; // dev server / can't detect — skip silently
    let stopped = false;

    const check = async () => {
      if (stopped || document.hidden || updateReady) return;
      try {
        const res = await fetch(`/index.html?_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return; // transient / offline — try again next tick
        const latest = latestBuildIdFrom(await res.text());
        if (latest && latest !== boot) {
          setUpdateReady(true);
          stopped = true;
        }
      } catch {
        /* network blip — ignore */
      }
    };

    const id = window.setInterval(() => {
      void check();
    }, intervalMs);
    const onVis = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVis);
    void check(); // once on mount

    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs, updateReady]);

  return { updateReady };
}
