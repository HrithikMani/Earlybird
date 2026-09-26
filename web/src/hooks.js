import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api.js';

/** Fetches JSON from url; refetches when url changes or every `intervalMs`. */
export function useApi(url, { intervalMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!url) return;
    try {
      const data = await api.get(url);
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (alive.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [url]);
  useEffect(() => {
    alive.current = true;
    load();
    const t = intervalMs ? setInterval(load, intervalMs) : null;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [load, intervalMs]);
  return { ...state, reload: load };
}

function subscribeHash(cb) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

/** Minimal hash router: returns ['/companies/cmp_x', {query}] */
export function useRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash || '#/');
  const [path, qs] = hash.slice(1).split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export function navigate(to) {
  window.location.hash = to;
}
