import { useQuery as useTanstackQuery } from "@tanstack/react-query";

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

// Optional per-callsite freshness controls. Defaults mirror the global
// queryClient (refetch-on-mount when stale). Set
// `refetchOnMount: "always"` + `staleTime: 0` on a list query that must
// reflect a sibling tab's create the instant the consumer mounts.
export interface UseQueryOptions {
  refetchOnMount?: boolean | "always";
  staleTime?: number;
  // Set true on a PAGINATED / tab-switched list so changing page/tab keeps the
  // previous rows on screen while the next slice loads, instead of flashing an
  // empty table + spinner (TanStack v5's keepPreviousData behaviour). Purely
  // presentational — does not touch the query key or caching.
  keepPreviousData?: boolean;
}

// Backed by TanStack Query (see lib/queryClient.ts). The public API is
// unchanged from the old hand-rolled hook — every existing callsite keeps
// working as `useQuery(fetcher, deps)` — but now gets caching, request dedup
// and cache-while-revalidate for free. The query key is derived from the
// fetcher's source plus the deps, so each callsite/deps combination caches
// separately (callsites must keep their dynamic values in `deps`, the same
// rule the old hook required to refetch correctly).
export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
  options: UseQueryOptions = {},
): QueryState<T> {
  const q = useTanstackQuery<T>({
    queryKey: ["uq", fetcher.toString(), ...deps],
    queryFn: () => fetcher(),
    ...(options.refetchOnMount !== undefined && {
      refetchOnMount: options.refetchOnMount,
    }),
    ...(options.staleTime !== undefined && { staleTime: options.staleTime }),
    // keepPreviousData: hold the last successful data while the next key's
    // fetch is in flight, so a page/tab switch never blanks the list.
    ...(options.keepPreviousData && { placeholderData: (prev: T | undefined) => prev }),
  });
  return {
    data: q.data ?? null,
    loading: q.isPending,
    error: q.error ? (q.error as Error).message || String(q.error) : null,
    reload: () => {
      void q.refetch();
    },
  };
}
