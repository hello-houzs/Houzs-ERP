# HOOKKA ↔ Houzs — technique parity

Answers "why aren't we mirroring ALL of HOOKKA's techniques?" HOOKKA's full
perf/scale/rendering/delivery technique set (mined from their repo) mapped to
Houzs status, with a verdict for each. Three buckets: **DONE** (adopted /
equivalent), **SKIP-FOR-NOW** (big-data/high-concurrency machinery, premature at
our ~tens-of-orders scale), and **GAP** (always-worth-it, not done yet → backlog).

Key architecture divergence: HOOKKA uses **direct SQL (postgres.js)** everywhere,
so the PostgREST 1000-row cap is moot for them. Our SCM layer DOES use PostgREST
(`sb.from(...)`), so that cap is real for us (already handled via chunked `.in()`).

---

## Bucket A — DONE (adopted or equivalent)

| HOOKKA technique | Houzs status |
|---|---|
| Client localStorage SWR cache | ✅ react-query + `lib/query-persist.ts` snapshot (SCM lists) + `api/cache.ts` 15s memory. (narrower than HOOKKA — see GAP-9) |
| Per-build cache namespace (`__BUILD_ID__`) | ✅ added this campaign (snapshot key) |
| Cross-tab invalidation (BroadcastChannel) | ✅ `cross-tab-sync.ts` + `api/cache.ts` bus |
| `_headers`: `/*` no-cache HTML, `/assets/*` immutable | ✅ verified (deep SPA routes revalidate) |
| Route-level code-splitting (React.lazy) | ✅ desktop + **mobile (this campaign, #426)** |
| Heavy libs lazy (`await import` jspdf/xlsx) | ✅ |
| Manual vendor chunk splitting | ✅ `react-vendor`/`leaflet`/`lucide`/`vendor` (less granular — GAP-4) |
| `keepPreviousData` | ✅ SCM hooks `placeholderData: prev` |
| Skeleton / Suspense fallbacks | ✅ (mobile Suspense added #426) |
| Virtualization / windowing | ✅ DataGrid + **DataTable (#430)** + **mobile lists (#433/#434)** |
| SW per-resource strategy (network-first HTML, cache-first assets) | ✅ `public/sw.js` |
| SW always returns a Response (no white screen) | ✅ verified |
| Version-check auto-reload | ✅ `NewVersionBanner` (mobile reach = GAP-5b) |
| Keep-warm cron | ✅ `*/5` Hyperdrive ping |
| Hyperdrive connection pooling + tuning | ✅ pool tuned; new client per request |
| Visibility-aware singleton polling | ✅ presence deduped + notifications singleton |
| No WebSockets (polling instead) | ✅ same choice |
| No materialized views | ✅ same (never adopted) |
| Web Push | ✅ `BrowserPushSink` + push outbox |
| `waitUntil` background work | ✅ scan bg-job, email outbox |
| Field projection (`?fields=minimal`) | ✅ mobile lists use it (HOOKKA doesn't even have this) |

---

## Bucket B — SKIP FOR NOW (big-data / high-concurrency; premature at our scale)

These pay off at HOOKKA's data volume + concurrent operators. At ~tens of orders
they add infra + complexity + a class of freshness bugs (HOOKKA's own snapshot
staleness incidents) for **zero current benefit**. Adopt when a specific endpoint
actually gets slow under real data — not before.

| HOOKKA technique | Why skip now / when to adopt |
|---|---|
| Server-side Postgres **snapshot tables** (`withSnapshot`) | Our aggregations are cheap on small data. **Adopt for AR aging / dashboard first** when they slow down. Follow their freshness guardrails (epoch-normalize timestamps, DELETE-on-write, single-flight, declared fields). |
| Cloudflare **KV edge body cache** (version-keyed + serve-stale) | Needs a KV namespace + per-org version keys. Only helps under concurrent load on the same list. Not our profile yet. |
| **Single-flight / stampede protection** (server) | Only matters when many operators hit the same cold recompute at once. |
| **Serve-stale-while-revalidate** (server) | Rides on snapshots (above). |
| **Freshness probes** (cross-table MAX(updated_at)) | Only exists to validate server snapshots. |
| **Maintained counter columns** (outstandingSen) | We compute balance live via the payment-totals VIEW. Fine until the view aggregation is a bottleneck. |
| In-isolate short-TTL memoization | Micro-opt for hot bursts; negligible at our volume. |
| Nightly snapshot-rebuild crons | Only needed once server snapshots exist. |

---

## Bucket C — GAP (always-worth-it, NOT done yet → backlog)

These are cheap at any scale and are HOOKKA's incident-hardening. Ranked.
NOTE (verified 2026-07-14): several items I first listed here turned out to be
ALREADY DONE or intentional non-gaps in Houzs — corrected below. Verify before
building.

1. **SW cache keyed to build id (auto), not a manual constant.** Ours is
   `VERSION = "houzs-erp-v174"` bumped by hand — a deploy that forgets to bump
   serves a stale shell. HOOKKA derives it from the build `?v`. **P1 (real gap).**
   Risk: PWA-churn sensitive — do carefully.
2. ~~purgeServiceWorkerAndCaches on chunk-load error~~ **ALREADY DONE** —
   `components/RouteFallback.tsx:ChunkReloadBoundary` unregisters every SW + deletes
   every cache before reloading, with a one-shot loop-guard. Only small belt-and-
   braces left: a WINDOW-level `vite:preloadError` + capture-phase `/assets/*` 404
   handler for a failure BEFORE React mounts (the boundary can't catch that). **P2.**
3. **Degraded-response guard** — never overwrite populated cache with an empty /
   `{success:false}` body. LOW value for us: `api/client.ts` non-2xx already throws
   (never caches), and our endpoints return raw data not `{success}` envelopes, so a
   "degraded 200" is rare. Add a light guard at `client.ts:303` if desired. **P3.**
4. ~~Atomic doc-number counter~~ **NOT A GAP — intentional.** `scm/lib/doc-no.ts`
   uses `max+1` on purpose: it self-heals a deleted-mid-month gap (reuses the freed
   number), which an ever-incrementing atomic counter cannot. The concurrent-create
   race is handled by a unique constraint + `mint()` retry (re-reads the live max).
   Considered tradeoff with an advantage over HOOKKA's counter. **No action.**
5. **Background pre-cache of build assets on SW install** (weak-wifi: pre-fetch
   the JS/CSS chunks so a flaky connection doesn't stall first paint; respect
   Data-Saver). Relevant for phones on-site. **P2.**
6. **Module-preload filtering** — strip pdf/xlsx chunks from `<link modulepreload>`
   so cold visits don't eagerly pull ~1MB of never-used JS. One `resolveDependencies`
   hook in vite.config. **P2.**
7. **Verified-save readback** — write → cache-busting readback → field-compare
   before showing success ("green tick but didn't persist"). We dropped the vendored
   verified-save; mutations are plain PATCH. **P2 (correctness).**
8. **FE RUM / slow-fetch timing** — warn on any fetch ≥500ms, basic real-user
   metrics. We have none. **P2 (observability, finds the next slow thing for us).**
9. **Extend the localStorage snapshot to more lists** (Projects / Service / Team)
   if they also cold-open with a spinner — same `query-persist.ts`, add to the
   whitelist. **P2.**
10. **More trgm GIN indexes** on remaining searched columns (customer / supplier /
    debtor names) — we did products/fabric (0104) only. **P2.**
11. **Runtime self-applied indexes** — HOOKKA `CREATE INDEX IF NOT EXISTS` on first
    hit of a hot endpoint (deploys don't replay migrations). We auto-apply via
    pg-migrate on deploy instead, so this is **equivalent, not needed.**

---

## The short answer to "why not all?"
- The **always-worth-it** techniques: mostly already adopted (Bucket A). The rest
  are a concrete backlog (Bucket C, 10 real items).
- The **big-data machinery** (Bucket B): deliberately deferred — at ~tens of orders
  it's pure overhead and drags in HOOKKA's own snapshot-staleness bug class. It
  becomes worthwhile as data grows; the first candidate is a server snapshot for
  AR aging / the dashboard.
