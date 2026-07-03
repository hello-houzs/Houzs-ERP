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
// and /api/auth/* is never cached (see api/cache.ts NEVER_CACHE). gcTime keeps
// the cached snapshot in memory for 5 min after a page unmounts so a quick
// there-and-back is instant; refetchOnWindowFocus stays off as before. Callsites
// that pass their own staleTime (the whole SCM + mobile layer) are unaffected —
// an explicit option always wins over these defaults.
import { QueryClient, MutationCache } from "@tanstack/react-query";
import { installCrossTabSync, broadcastDataChanged } from "./cross-tab-sync";

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
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Listen for other tabs' writes and invalidate our active queries.
installCrossTabSync(queryClient);
