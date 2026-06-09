import { useEffect, useRef, useState } from "react";

// Polls `fetcher` every `intervalMs`. The fetcher is kept in a ref so callers
// can pass inline closures without restarting the timer on each render.
export function usePoll(fetcher, intervalMs = 1000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const next = await fetcherRef.current();
        if (live) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (live) setError(err);
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return { data, error };
}
