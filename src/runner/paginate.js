import { setPath } from './extract.js';

/** How many pages to fetch for this rule + mode. Fast sweeps only read the first page(s) of newest-first sources. */
export function maxPagesFor(rule, mode) {
  const max = rule.pagination?.max_pages ?? 1;
  if (mode === 'fast' && rule.sorted_newest_first) return Math.max(1, Math.min(rule.fast_max_pages ?? 1, max));
  return max;
}

export function pageValue(p, i) {
  if (p.kind === 'offset') return (p.start ?? 0) + i * p.page_size;
  if (p.kind === 'page') return (p.start ?? 1) + i;
  return undefined;
}

/** Returns {url, body} with pagination params applied. */
export function applyPagination({ url, body }, p, value) {
  if (!p || value === undefined) return { url, body };
  if (p.in === 'body') {
    const b = structuredClone(body ?? {});
    setPath(b, p.param, value);
    if (p.size_param) setPath(b, p.size_param, p.page_size);
    return { url, body: b };
  }
  const u = new URL(url);
  u.searchParams.set(p.param, String(value));
  if (p.size_param) u.searchParams.set(p.size_param, String(p.page_size));
  return { url: u.toString(), body };
}
