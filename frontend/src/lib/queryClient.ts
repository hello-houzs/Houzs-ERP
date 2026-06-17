// TanStack Query client. The custom useQuery hook (hooks/useQuery.ts) runs on
// top of this, so every existing data call gets caching + request dedup +
// cache-while-revalidate with no callsite changes. Defaults mirror the old
// hand-rolled hook's behaviour (always-fresh on mount, no focus refetch) to
// avoid surprising the existing pages.
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
