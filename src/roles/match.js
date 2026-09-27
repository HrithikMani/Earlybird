import { listRoles } from './store.js';

export function normalizeText(s) {
  return ` ${String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()} `;
}

/** Roles that apply to a company, per its role_mode. */
export function effectiveRoles(company) {
  if (!company || company.role_mode === 'all_jobs') return [];
  const own = listRoles({ scope: 'company', company_id: company.id }).filter((r) => r.enabled);
  if (company.role_mode === 'company_only') return own;
  return [...listRoles({ scope: 'global' }).filter((r) => r.enabled), ...own];
}

/** Unique search terms for the portal (from roles' search_terms). */
export function searchTerms(roles) {
  const seen = new Set();
  const out = [];
  for (const r of roles) {
    for (const t of r.search_terms?.length ? r.search_terms : [r.name]) {
      const k = t.trim().toLowerCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(t.trim());
      }
    }
  }
  return out;
}

// A phrase matches when every one of its words appears in the text as a whole word, in any order
// ("DevOps Engineer" matches "DevOps Platform Engineer" but not "Engineering Manager").
function phraseIn(haystack, phrase) {
  const words = normalizeText(phrase).trim().split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => haystack.includes(` ${w} `));
}

/** Names of the roles a job title matches (name or synonyms, minus exclude words). */
export function matchRoles(title, roles) {
  const t = normalizeText(title);
  const matched = [];
  for (const r of roles) {
    const phrases = [r.name, ...(r.synonyms || []), ...(r.search_terms || [])];
    if (!phrases.some((p) => phraseIn(t, p))) continue;
    if ((r.exclude_words || []).some((w) => phraseIn(t, w))) continue;
    matched.push(r.name);
  }
  return matched;
}

/** Global/company notify filters (exclude keywords, locations). Returns null when the job passes, else the reason. */
export function filterReason(job, filters) {
  const title = normalizeText(job.title);
  if ((filters.excludeKeywords || []).some((k) => phraseIn(title, k))) return 'filtered';
  const locs = (filters.locations || []).filter(Boolean);
  if (locs.length && job.location) {
    const loc = job.location.toLowerCase();
    if (!locs.some((l) => loc.includes(l.toLowerCase()))) return 'filtered';
  }
  return null;
}
