import { useCallback, useEffect, useState } from "react";

/** Загрузка данных с повтором по reload(); key — когда менять, заново. */
export function useAsync<T>(load: () => Promise<T>, key: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, key);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    run()
      .then((value) => alive && (setData(value), setError(null)))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [run, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
