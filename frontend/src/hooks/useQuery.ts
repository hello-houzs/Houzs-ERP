import { useCallback, useEffect, useRef, useState } from "react";

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown> = []
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);

  const run = useCallback(() => {
    const myTick = ++tick.current;
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => {
        if (myTick === tick.current) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (myTick === tick.current) {
          setError(e?.message || String(e));
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { data, loading, error, reload: run };
}
