import { RunnerJobSchema } from '../schema/job.js';
import { parsePostedAt } from './dates.js';

/** Replaces {{query}} in strings (URL-encoded when inside a URL), recursively in objects/arrays. */
export function applyTemplate(value, vars, { urlEncode = false } = {}) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => {
      const v = vars[k] ?? '';
      return urlEncode ? encodeURIComponent(v) : v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => applyTemplate(v, vars, { urlEncode }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyTemplate(v, vars, { urlEncode })]));
  return value;
}

export function resolveUrl(href, base) {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * Turns a raw extracted item into a validated runner job.
 * Returns { job } or { error, raw }.
 */
export function normalizeJob(raw, rule, { baseUrl, searchTerm, now = Date.now() }) {
  const url = resolveUrl(raw.url, rule.url_prefix || baseUrl);
  let externalId = raw.id !== undefined && raw.id !== null && raw.id !== '' ? String(raw.id) : undefined;
  if (!externalId && rule.id_from_url && url) {
    const m = url.match(new RegExp(rule.id_from_url));
    if (m) externalId = m[1] ?? m[0];
  }
  const postedRaw = raw.posted_at === undefined || raw.posted_at === null ? undefined : String(raw.posted_at);
  const posted = parsePostedAt(raw.posted_at, rule.posted_at_format, now);
  const candidate = {
    external_id: externalId,
    title: raw.title,
    url,
    location: raw.location || undefined,
    department: raw.department || undefined,
    posted_at: posted,
    posted_at_raw: postedRaw,
    search_term: searchTerm || undefined,
  };
  const parsed = RunnerJobSchema.safeParse(candidate);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), raw };
  }
  return { job: parsed.data };
}
