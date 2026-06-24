import { useQuery as useTanstackQuery } from "@tanstack/react-query";

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

// Optional per-callsite freshness controls. Defaults mirror the global
// queryClient (staleTime 0, refetch-on-mount when stale). Set
// `refetchOnMount: "always"` + `staleTime: 0` on a list query that must
// reflect a sibling tab's create the instant the consumer mounts.
export interface UseQueryOptions {
  refetchOnMount?: boolean | "always";
  staleTime?: number;
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
