import { runRule } from '../runner/index.js';
import { runnerOptions } from '../worker/scrape.js';
import { effectiveRoles, matchRoles, normalizeText, searchTerms } from '../roles/match.js';
import { errorDetail } from '../log/logger.js';

const TYPE_COST = { api: 1, html: 0.8, script: 0.6, browser: 0.4 };
const WEIGHTS = { freshness: 0.3, completeness: 0.25, relevance: 0.15, stability: 0.1, cost: 0.2 };

function tokens(s) {
  return new Set(normalizeText(s).trim().split(' ').filter(Boolean));
}

/** Fuzzy title match: substring either way, or ≥80% token overlap. */
export function titleMatches(a, b) {
  const na = normalizeText(a).trim();
  const nb = normalizeText(b).trim();
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.max(ta.size, tb.size) >= 0.8;
}

const keyOf = (j) => j.external_id || j.url;

/**
 * Runs a candidate rule the way discovery validates it: full run twice + fast run, with the company's real role terms.
 * Returns { passed, errors[], score{...,total}, sample, runs[] }.
 */
export async function validateCandidate({ company, spec, code, scriptPath, evidence = {}, signal, log }) {
  const roles = effectiveRoles(company);
  const terms = searchTerms(roles);
  const opts = { ...runnerOptions({ signal, log }), terms, scriptCode: code, scriptPath };
  const errors = [];
  const runs = [];
  const exec = async (mode) => {
    const t0 = Date.now();
    try {
      const r = await runRule(spec, { ...opts, mode });
      runs.push({ mode, ok: true, count: r.jobs.length, ms: Date.now() - t0, invalid: r.meta.invalid_count, per_query: r.meta.per_query });
      return r;
    } catch (err) {
      runs.push({ mode, ok: false, ms: Date.now() - t0, error: errorDetail(err) });
      errors.push(`${mode} run failed: ${err.type || 'Error'}: ${err.message}`);
      return null;
    }
  };

  const r1 = await exec('full');
  const r2 = r1 ? await exec('full') : null;
  const r3 = r1 ? await exec('fast') : null;
  const minJobs = Math.max(1, spec.expected_min_jobs ?? 1);

  if (r1) {
    if (r1.jobs.length < minJobs) errors.push(`returned ${r1.jobs.length} jobs; expected at least ${minJobs}`);
    if (r1.meta.invalid_count) errors.push(`${r1.meta.invalid_count} job(s) failed the job schema, e.g. ${r1.meta.invalid_samples[0]?.error}`);
    if (r1.meta.terms_capped) errors.push(`too many search terms for per_term search (cap ${opts.maxTerms}); fetched all jobs instead`);
  }
  if (r3 && r3.jobs.length === 0 && r1?.jobs.length) errors.push('fast mode returned 0 jobs while full mode returned jobs');

  const jobs = r1?.jobs || [];
  const score = { freshness: null, completeness: null, relevance: null, stability: null, id_stability: null, cost: null };

  if (r1 && r2) {
    const a = new Set(r1.jobs.map(keyOf));
    const b = new Set(r2.jobs.map(keyOf));
    let common = 0;
    for (const k of a) if (b.has(k)) common++;
    score.id_stability = a.size ? common / Math.max(a.size, b.size) : 0;
    const countOk = Math.abs(r1.jobs.length - r2.jobs.length) <= Math.max(1, r1.jobs.length * 0.05);
    score.stability = countOk ? score.id_stability : Math.min(score.id_stability, 0.5);
    if (score.id_stability < 0.9) errors.push(`job ids are not stable between two runs (${Math.round(score.id_stability * 100)}% overlap); map a stable id field or id_from_url`);
  }

  const matched = roles.length ? jobs.filter((j) => matchRoles(j.title, roles).length > 0) : jobs;
  if (roles.length && jobs.length) score.relevance = matched.length / jobs.length;
  const visible = evidence.visible_role_job_count ?? evidence.visible_job_count;
  if (visible) score.completeness = Math.min(1, matched.length / visible);
  const newest = (evidence.newest_titles || []).filter(Boolean);
  if (newest.length && jobs.length) {
    const found = newest.filter((t) => jobs.some((j) => titleMatches(j.title, t)));
    score.freshness = found.length / newest.length;
    if (score.freshness < 0.5) errors.push(`only ${found.length}/${newest.length} of the newest titles seen on the site were returned: missing ${newest.filter((t) => !found.includes(t)).slice(0, 3).join(' | ')}`);
  }
  if (r1) {
    const ms = runs.filter((r) => r.ok && r.mode === 'full').reduce((s, r) => s + r.ms, 0) / Math.max(1, runs.filter((r) => r.ok && r.mode === 'full').length);
    const queries = r1.meta.queries?.length || 1;
    score.cost = Math.max(0, (TYPE_COST[spec.type] ?? 0.5) - Math.min(0.2, (ms / 60000) * 0.2) - Math.min(0.1, (queries - 1) * 0.01));
  }

  let wsum = 0;
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    if (score[k] === null || score[k] === undefined) continue;
    wsum += w;
    total += w * score[k];
  }
  score.total = wsum ? total / wsum : 0;

  return {
    passed: !!r1 && errors.length === 0,
    errors,
    score,
    job_count: jobs.length,
    role_matched_count: matched.length,
    terms,
    runs,
    sample: jobs.slice(0, 15).map((j) => ({ title: j.title, url: j.url, location: j.location, posted_at: j.posted_at, external_id: j.external_id, search_term: j.search_term })),
  };
}
