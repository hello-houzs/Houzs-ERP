// TanStack Query client. The custom useQuery hook (hooks/useQuery.ts) runs on
// top of this, so every existing data call gets caching + request dedup +
// cache-while-revalidate with no callsite changes.
//
// PERF: the global staleTime was 0, so EVERY query that doesn't set its own
// refetched from scratch on every mount / navigation — the main reason heavy
// pages (Service cases, Projects, Team, dashboards) showed a full-load spinner
// each time you came back to them. A modest 30s staleTime lets a revisited page
// serve its cached snapshot instantly and only revalidate once the data is
// older than that. This is SAFE because reads-after-writes stay fresh: every
// mutation calls invalidateQueries (same tab) and broadcastDataChanged →
// invalidateQueries (other tabs), and invalidation ignores staleTime and forces
// an active refetch. Queries that must always be live (role/permission lists,
// see pages/Team.tsx) already override with staleTime:0 + refetchOnMount:"always",
// and /api/auth/* is never cached (see api/cache.ts NEVER_CACHE).
//
// gcTime keeps a page's cached data in memory after it unmounts so re-opening it
// is instant (cache-while-revalidate: cached rows show immediately, a background
// refetch replaces them if stale — NO loading spinner). Measured: a warm revisit
// of the SCM SO/PO lists already refetches=false, skeleton=false. Bumped 5min →
// 30min so that "instant re-open" window covers a whole work session, not just a
// quick there-and-back — the SCM doc lists (SO/PO/DO/SI/GRN) were showing a
// full-load spinner whenever a revisit fell outside the old 5-min window. It does
// NOT survive a full page reload / PWA reopen (in-memory only); a localStorage
// snapshot layer for cold-open instancy is the tracked follow-up. refetchOnWindow-
// Focus stays off. Callsites with their own staleTime (SCM + mobile) are
// unaffected — an explicit option always wins over these defaults.
import { QueryClient, MutationCache, hashKey } from "@tanstack/react-query";
import { installCrossTabSync, broadcastDataChanged } from "./cross-tab-sync";
import { installQueryPersist } from "./query-persist";
import { getActiveCompanyId } from "./activeCompany";

export const queryClient = new QueryClient({
  // Cross-tab sync: every successful write tells other open tabs to refetch.
  // One central hook in the MutationCache, so no per-mutation wiring is needed.
  mutationCache: new MutationCache({
    onSuccess: () => {
      broadcastDataChanged();
    },
  }),
  defaultOptions: {
    queries: {
      // Multi-company cache isolation (fixes "switch company → list keeps the
      // previous company's rows until F5"). Fold the active company id into the
      // HASH react-query uses to BUCKET each query, so two companies asking the
      // SAME queryKey (e.g. ['mfg-products','all',''] — the ~40 vendored SCM
      // modules and the custom useQuery hook all key by URL/args only, never by
      // company) land in SEPARATE cache entries. Cross-company collisions become
      // structurally impossible, and a switch re-buckets every active observer to
      // a fresh (empty) slot → automatic refetch of the newly-selected company's
      // data (the <CompanyScopedApp> remount in main.tsx makes observers
      // recompute this hash). When no company is selected (single-company /
      // pre-activation) the prefix is empty → byte-identical hashing to before,
      // so single-company Houzs is behaviourally unchanged. NOTE: this only
      // changes the storage bucket — invalidateQueries({queryKey}) matching still
      // compares key ARRAYS (partialMatchKey), so every existing mutation-side
      // invalidation keeps working across the company-scoped entries.
      queryKeyHashFn: (key) => {
        const cid = getActiveCompanyId();
        return (cid !== null ? `co:${cid}|` : "") + hashKey(key);
      },
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Listen for other tabs' writes and invalidate our active queries.
installCrossTabSync(queryClient);

// Persist the SCM document-list queries to localStorage so a COLD open (fresh
// session / full reload / PWA reopen) renders the last-known list instantly and
// revalidates in the background — no full-load spinner. Runs at module init so
// the cache is seeded before the first render. See query-persist.ts.
installQueryPersist(queryClient);
