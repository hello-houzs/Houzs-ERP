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

1. **SW cache keyed to build id (auto), not a manual constant.** Ours is
   `VERSION = "houzs-erp-v170"` bumped by hand — a deploy that forgets to bump
   serves a stale shell. HOOKKA derives it from the build `?v`. **P1.** (= plan D-SW)
2. **`purgeServiceWorkerAndCaches` on chunk-load error.** On a stale-chunk /
   `vite:preloadError`, unregister SW + clear caches BEFORE reloading (a plain
   reload re-serves the same dead shell → white screen). We only do a plain reload
   today — I hit exactly this while verifying (had to purge by hand). **P1.**
3. **Degraded-response guard** — never overwrite populated cache with an empty /
   `{success:false}` / non-2xx body (blank-page prevention; HOOKKA bug 1b). Add to
   the api/cache + snapshot layers. **P1.**
4. **Atomic doc-number counter** (`INSERT … ON CONFLICT DO UPDATE … RETURNING`).
   Ours is `MAX(no)+1`, which can race two concurrent creates to the same number.
   HOOKKA's atomic counter can't. **P1 (correctness, not just speed).**
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
