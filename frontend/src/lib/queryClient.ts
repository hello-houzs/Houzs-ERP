// TanStack Query client. The custom useQuery hook (hooks/useQuery.ts) runs on
// top of this, so every existing data call gets caching + request dedup +
// cache-while-revalidate with no callsite changes. Defaults mirror the old
// hand-rolled hook's behaviour (always-fresh on mount, no focus refetch) to
// avoid surprising the existing pages.
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
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Listen for other tabs' writes and invalidate our active queries.
installCrossTabSync(queryClient);
