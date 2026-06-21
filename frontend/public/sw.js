/**
 * Service worker — pragmatic v1.
 *
 * Strategy:
 *   • App shell (HTML/JS/CSS): cache-first with network fallback +
 *     background revalidate. Lets the app launch instantly on the
 *     home screen, even with no signal.
 *   • API requests: network-first with a timed fallback to last-good
 *     cached response. Avoids stale data on the happy path while
 *     still showing *something* in a tunnel/lift.
 *   • POST/PUT/PATCH/DELETE: never cached, never replayed by us. Real
 *     background-sync queueing is deferred to a later iteration —
 *     when offline the user just sees the toast error and tries
 *     again on reconnect.
 *
 * Cache version bumps on every deploy via the build hash baked in
 * by Vite (the asset filenames change, so cache hits naturally fall
 * through to network for new builds).
 */

// Bumping this purges old caches in the activate step. v2: HTML is now
// fetched network-first so the stale-on-first-refresh issue from v1 is
// gone; this one-shot bump also clears any v1 shell entry that has the
// pre-fix index.html baked in. v3 (2026-05-12): one-shot purge to
// recover iPhone Safari clients that were stuck on a cached CSS bundle
// after the page-access refactor — old cache-first /assets entries
// were serving pre-rebuild CSS, leaving Tailwind classes unapplied.
// v4 (2026-06-19): one-shot purge to recover staff clients left on a
// stale shell after a burst of same-day deploys (the SCM port). The
// activate step deletes the old v3 caches so every client rebuilds from
// the live build on its next load — no manual hard-refresh needed.
// v5 (2026-06-20): SCM cutover — the 2990-vendored pages replace the
// native SCM (new chunks, system-font rebrand, real document PDFs). Purge
// so every client picks up the new shell + assets on next load.
// v6 (2026-06-21): hotfix — mount PromptProvider in Scm2990Shell so the
// SCM pages that call usePrompt (Sales Order detail, pricing Maintenance
// editor) stop crashing with "usePrompt must be used within PromptProvider".
// v7 (2026-06-21): SCM sidebar re-sectioned 1:1 with 2990 (Sales Order /
// Consignment / Procurement [MRP+Products here] / Transportation / Warehouse);
// added the missing Sales Invoices, Drivers, Adjustments nav items.
// v8 (2026-06-21): 2990-parity batch — restore DataGrid CSV/Excel export, SO
// status-label wording, Products bulk inactive/active, MRP sofa line-order;
// (+ backend /document-flow + /drivers routes, no SW impact).
// v9 (2026-06-21): nav labels aligned 1:1 with 2990 — Consignment items to
// singular + full "Purchase Consignment ..." names; dropped Product Models +
// Fabric Tracking from Procurement (tabs-in-Products in 2990, not nav items).
// v10 (2026-06-21): T12 detail-page re-vendor (PO/PI/GRN/PR/PCO/PC-recv/PC-ret
// now edit product/variants + add lines) + PoLineCard/PcLineCard; dialog
// z-index, SI description2, SofaComboTab bulk/grid, ProductModels SKUs col;
// removed Order Add-ons tab + One-shot badge (Houzs unused). Backend: reports +
// so-dropdown-options routes mounted; 0022 seeds 2990 reference data on deploy.
const VERSION = "houzs-erp-v10";
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;

// Pre-cache the bare-minimum shell so the app is launchable offline.
// Hashed assets (built JS/CSS) are picked up lazily on first fetch.
const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/logo-mark.png",
  "/logo-wordmark.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll fails the install if any one URL 404s — tolerant
      // version using individual put-on-success keeps the SW alive
      // when one shell asset goes missing temporarily.
      Promise.allSettled(
        SHELL_URLS.map(async (url) => {
          try {
            const r = await fetch(url, { cache: "no-store" });
            if (r.ok) await cache.put(url, r.clone());
          } catch {}
        })
      )
    )
  );
  // Take over from the previous SW immediately on first install so
  // users don't need to close every tab.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept cross-origin (fonts CDN, Google APIs, etc.).
  // The browser handles these — caching them ourselves invites
  // CORS surprises on offline retry.
  if (url.origin !== self.location.origin) return;

  // Mutating requests bypass the SW entirely. We don't queue them
  // yet; the page handles failure via toast + manual retry.
  if (req.method !== "GET") return;

  // API requests: network-first w/ short timeout, fall back to cache.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req));
    return;
  }

  // HTML / SPA navigation requests must always try the network first so a
  // fresh deploy is picked up on the very next refresh. Falls back to the
  // cached index.html only when offline. Without this, cache-first served
  // a stale index.html for one extra refresh after every deploy.
  const isNavigation =
    req.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname === "/index.html";
  if (isNavigation) {
    event.respondWith(navigationNetworkFirst(req));
    return;
  }

  // Everything else (hashed /assets/*, manifest, logos): cache-first with
  // background refresh. Hashed asset filenames change on every build, so
  // serving them from cache is always correct for the corresponding HTML.
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(API_CACHE);
  try {
    // 4-second timeout: don't make the user wait forever if the
    // network is "present but broken" (captive portal, lift, etc.).
    const fresh = await fetchWithTimeout(req, 4000);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    }
    throw new Error("network response not ok");
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Truly nothing — return a synthetic 503 so the app's error
    // path renders instead of throwing an unhandled rejection.
    return new Response(
      JSON.stringify({ error: "offline", offline: true }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// Navigation = the SPA's index.html shell. Always try network first so a
// new deploy lands on the next refresh; cache fallback only kicks in when
// the user is offline (lift, tunnel, no signal at venue).
async function navigationNetworkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetchWithTimeout(req, 4000);
    if (fresh && fresh.ok) {
      // Mirror the shell into cache under both the requested URL and
      // /index.html so the SPA fallback path below always finds it.
      cache.put(req, fresh.clone()).catch(() => {});
      cache.put("/index.html", fresh.clone()).catch(() => {});
      return fresh;
    }
    throw new Error("network response not ok");
  } catch {
    const cached =
      (await cache.match(req)) || (await cache.match("/index.html"));
    if (cached) return cached;
    return new Response("Offline", { status: 503 });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    // Background revalidate — keep the shell fresh for next time.
    fetch(req)
      .then((r) => {
        if (r && r.ok) cache.put(req, r.clone()).catch(() => {});
      })
      .catch(() => {});
    return cached;
  }
  try {
    const r = await fetch(req);
    if (r && r.ok) cache.put(req, r.clone()).catch(() => {});
    return r;
  } catch {
    // SPA fallback: any unknown route returns the cached index.html
    // so React Router can take over once the JS evaluates.
    const indexCached = await cache.match("/index.html");
    return indexCached || new Response("Offline", { status: 503 });
  }
}

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    fetch(req, { signal: controller.signal })
      .then((r) => {
        clearTimeout(t);
        resolve(r);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}
