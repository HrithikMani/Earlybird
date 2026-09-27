import crypto from 'node:crypto';
import { normalizeText } from '../roles/match.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Normalized job URL: https, lowercase host, no fragment/trailing slash, tracking params removed, params sorted. */
export function canonicalUrl(url, trackingParams = []) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url).trim();
  }
  const drop = new Set(trackingParams.map((p) => p.toLowerCase()));
  const kept = [...u.searchParams.entries()].filter(([k]) => !drop.has(k.toLowerCase()) && !k.toLowerCase().startsWith('utm_'));
  kept.sort(([a], [b]) => a.localeCompare(b));
  const search = kept.length ? '?' + new URLSearchParams(kept).toString() : '';
  const host = u.host.toLowerCase().replace(/^www\./, '');
  const isLocal = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  const proto = isLocal ? u.protocol : 'https:';
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${proto}//${host}${path}${search}`;
}

export function fingerprint(title, location, companyId) {
  return sha(`${companyId}|${normalizeText(title).trim()}|${normalizeText(location || '').trim()}`);
}

/** Identity keys for a runner job. */
export function jobKeys(job, companyId, trackingParams) {
  const canonical = canonicalUrl(job.url, trackingParams);
  return {
    job_key: job.external_id ? `id:${job.external_id}` : `url:${sha(canonical).slice(0, 32)}`,
    canonical_url: canonical,
    fingerprint: fingerprint(job.title, job.location, companyId),
  };
}
