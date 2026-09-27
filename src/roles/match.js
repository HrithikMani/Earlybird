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

// Country aliases so "United States" matches "Seattle, Washington, USA", "Columbus, OH, United States" or "Austin, TX".
const US_STATES = 'al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc'.split(' ');
const US_STATE_NAMES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia'];
const COUNTRY_ALIASES = {
  us: ['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america'],
  uk: ['united kingdom', 'uk', 'great britain', 'gb', 'england', 'scotland', 'wales'],
  in: ['india'],
  ca: ['canada'],
  de: ['germany', 'deutschland'],
};

function countryKey(wanted) {
  const w = normalizeText(wanted).trim();
  return Object.keys(COUNTRY_ALIASES).find((k) => COUNTRY_ALIASES[k].includes(w));
}

/** True when a job location matches one wanted location (country aliases and US state codes understood). */
export function locationMatches(location, wanted) {
  const loc = normalizeText(location);
  const key = countryKey(wanted);
  if (!key) return phraseIn(loc, wanted); // a city, region or "Remote": plain word match
  if (COUNTRY_ALIASES[key].some((a) => loc.includes(` ${a} `))) return true;
  // "IN, TS, Hyderabad" / "US, WA, Seattle": ISO country code first.
  const ISO = { us: 'us', uk: 'gb', in: 'in', ca: 'ca', de: 'de' };
  const first = String(location).split(',').map((p) => normalizeText(p).trim());
  if (first.length >= 3 && first[0] === ISO[key]) return true;
  if (key === 'us') {
    // "Austin, TX" / "Seattle, Washington" with no country: a US state code or name at a comma boundary.
    // Only "City, ST" (optionally followed by nothing else), so "Bangalore, KA, IN" is not read as Indiana.
    const parts = String(location).split(/[,;|/()]/).map((p) => normalizeText(p).trim()).filter(Boolean);
    if (parts.length === 2 && US_STATES.includes(parts[1])) return true;
    if (parts.some((p) => US_STATE_NAMES.includes(p)) && !Object.entries(COUNTRY_ALIASES).some(([k, a]) => k !== 'us' && a.some((x) => loc.includes(` ${x} `)))) return true;
  }
  return false;
}

/** Where the company wants jobs from: the portal filter location plus notify-filter / global locations. */
export function wantedLocations(company, globalFilters) {
  const list = [company.source_filters?.location, ...(company.notify_filters?.locations ?? globalFilters.locations ?? [])];
  return [...new Set(list.map((l) => (l || '').trim()).filter(Boolean))];
}

/** True when the job is in one of the wanted locations (or no location preference / no location on the job). */
export function inWantedLocation(job, wanted) {
  if (!wanted.length || !job.location) return true;
  // No country information at all ("Remote", "Multiple Locations"): keep it rather than hide a possibly relevant job.
  if (/^\s*(remote|anywhere|multiple locations?|various locations?|flexible)\s*$/i.test(job.location)) return true;
  return wanted.some((w) => locationMatches(job.location, w));
}

/** Global/company notify filters (exclude keywords, locations). Returns null when the job passes, else the reason. */
export function filterReason(job, filters) {
  const title = normalizeText(job.title);
  if ((filters.excludeKeywords || []).some((k) => phraseIn(title, k))) return 'filtered';
  const locs = (filters.locations || []).filter(Boolean);
  if (locs.length && job.location && !locs.some((l) => locationMatches(job.location, l))) return 'filtered';
  return null;
}
