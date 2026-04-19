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

const VERSION = "houzs-erp-v1";
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

  // Everything else (the SPA shell): cache-first with background
  // refresh. New deploys get fresh asset filenames so this is safe.
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
