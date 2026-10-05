import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './i18n';

export interface AsyncState<T> { data: T | undefined; error: string; forbidden: boolean; loading: boolean; reload: () => void }

/** Minimal data loader: ignores stale responses, exposes 403 separately so pages can degrade gracefully. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { pollMs?: number } = {}): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const tick = useRef(0);
  const fnRef = useRef(fn); fnRef.current = fn;

  const run = useCallback(async (silent: boolean) => {
    const my = ++tick.current;
    if (!silent) setLoading(true);
    try {
      const r = await fnRef.current();
      if (my === tick.current) { setData(r); setError(''); setForbidden(false); }
    } catch (e) {
      if (my === tick.current) { setError(errorMessage(e)); setForbidden((e as { code?: string }).code === 'FORBIDDEN'); }
    } finally { if (my === tick.current) setLoading(false); }
  }, []);

  useEffect(() => {
    void run(false);
    if (!opts.pollMs) return;
    const h = setInterval(() => { if (!document.hidden) void run(true); }, opts.pollMs);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, opts.pollMs, ...deps]);

  return { data, error, forbidden, loading, reload: () => void run(false) };
}
