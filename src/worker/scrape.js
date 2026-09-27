import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, getSqlite, newId, schema } from '../db/index.js';
import { enrichPostedDates } from '../runner/enrich.js';
import { canonicalUrl } from './dedupe.js';
import { runRule } from '../runner/index.js';
import { getSettings } from '../settings/index.js';
import { childLogger, errorDetail } from '../log/logger.js';
import { config } from '../config.js';
import { now } from '../runtime.js';
import { effectiveRoles, searchTerms } from '../roles/match.js';
import { getCompany, updateCompany } from '../store/companies.js';
import { currentRuleFor, ensureScriptFile, getRule } from '../store/rules.js';
import * as registry from '../tasks/registry.js';
import { ingestJobs } from './ingest.js';
import { updateHealthAfterRun } from './health.js';

const RUNS = schema.runs;

/** Options for runRule() derived from Settings. */
export function runnerOptions({ signal, log, artifactsDir } = {}) {
  const scraping = getSettings('scraping');
  const scripts = getSettings('scripts');
  return {
    signal,
    log,
    artifactsDir,
    userAgent: scraping.userAgent,
    timeoutMs: scraping.requestTimeoutMs,
    actionTimeoutMs: scraping.actionTimeoutMs,
    respectRobots: scraping.respectRobots,
    saveTraces: getSettings('logging').saveTraces,
    scriptTimeoutMs: scripts.timeoutMs,
    scriptMemoryMb: scripts.memoryMb,
    maxTerms: getSettings('roles').maxTermsPerRun,
    maxJobs: getSettings('filters').maxJobsPerCompany,
  };
}

/**
 * Lists without dates (e.g. Meta): read datePosted from the detail pages of jobs we don't have a date for yet:
 * new jobs first, then a small backfill of existing listings. Dates make the age window and "Posted" work.
 */
async function enrichMissingDates({ company, rule, jobs, meta, baseline, signal, log }) {
  if (rule.spec.enrich_dates === 'off') return;
  const missing = jobs.filter((j) => !j.posted_at);
  if (!missing.length || missing.length < jobs.length * 0.5) return; // the list has dates for most jobs
  // Jobs whose date we already know, listed or not (seen_jobs remembers dates of too-old jobs too).
  const known = new Map(
    getSqlite()
      .prepare('select canonical_url, posted_at from seen_jobs where company_id = ? and posted_at is not null union select canonical_url, posted_at from jobs where company_id = ? and posted_at is not null')
      .all(company.id, company.id)
      .map((r) => [r.canonical_url, r.posted_at]),
  );
  const tracking = getSettings('dedupe').trackingParams;
  // Re-use remembered dates; only unknown jobs need their detail page.
  for (const j of missing) {
    const p = known.get(canonicalUrl(j.url, tracking));
    if (p) {
      j.posted_at = p;
      j.posted_at_raw = 'datePosted (remembered from detail page)';
    }
  }
  const scraping = getSettings('scraping');
  await enrichPostedDates(jobs, {
    needs: (j) => !known.has(canonicalUrl(j.url, tracking)),
    limit: baseline ? 40 : 15,
    signal,
    userAgent: scraping.userAgent,
    timeoutMs: scraping.actionTimeoutMs,
    log,
    meta,
  });
}

export function chooseMode(company) {
  const every = getSettings('scheduling').fullSweepEveryMin * 60000;
  return !company.last_full_sweep_at || now() - company.last_full_sweep_at >= every ? 'full' : 'fast';
}

/**
 * Executes one scrape run for a company: rule → dedupe → store → notify queue → runs row → health.
 * Never throws for rule failures (they are recorded on the run); returns the run row.
 */
export async function executeRun(companyId, { mode, trigger = 'schedule', ruleId } = {}) {
  const company = getCompany(companyId);
  if (!company) throw Object.assign(new Error(`company ${companyId} not found`), { statusCode: 404 });
  const rule = ruleId ? getRule(ruleId) : currentRuleFor(company);
  if (!rule) throw Object.assign(new Error(`${company.name} has no active rule yet`), { statusCode: 409 });

  const onFallback = !ruleId && company.using_fallback && rule.id === company.fallback_rule_id;
  const baseline = !onFallback && !ruleId && company.baseline_rule_id !== rule.id;
  const runMode = baseline ? 'full' : mode || chooseMode(company);
  const roles = effectiveRoles(company);
  const terms = searchTerms(roles);
  const runId = newId('run');
  const startedAt = now();
  const log = childLogger('run', { company_id: company.id, rule_id: rule.id, run_id: runId });
  const runTrigger = baseline ? 'baseline' : onFallback ? 'fallback' : trigger;

  getDb().insert(RUNS).values({ id: runId, company_id: company.id, rule_id: rule.id, mode: runMode, trigger: runTrigger, status: 'running', started_at: startedAt }).run();
  updateCompany(company.id, { last_run_at: startedAt });
  const reg = registry.register(runId, { kind: 'run', company_id: company.id, rule_id: rule.id, label: `${company.name} (${runMode})` });
  log.info({ mode: runMode, trigger: runTrigger, rule_type: rule.type, rule_version: rule.version, terms: terms.length }, `run started: ${company.name}`);

  let result;
  try {
    const opts = runnerOptions({ signal: reg.signal, log, artifactsDir: path.join(config.paths.artifacts, runId) });
    const { jobs, meta } = await runRule(rule.spec, { ...opts, mode: runMode, terms, scriptPath: ensureScriptFile(rule) });
    await enrichMissingDates({ company, rule, jobs, meta, baseline, signal: reg.signal, log });
    const stats = ingestJobs({ company, rule, jobs, mode: runMode, baseline, queries: meta.queries || (meta.terms_capped ? [''] : terms.length ? terms : ['']), capped: meta.terms_capped, roles });
    const duration = now() - startedAt;
    const runStats = { ...stats, enrich: meta.enrich, pages: meta.pages, requests: meta.requests.length, invalid: meta.invalid_count, per_query: meta.per_query, terms_capped: meta.terms_capped };
    getDb()
      .update(RUNS)
      .set({ status: 'ok', duration_ms: duration, http_status: meta.last_status ?? null, job_count: jobs.length, new_job_count: stats.new, notified_count: stats.queued, closed_job_count: stats.closed, stats: runStats, artifacts: meta.artifacts ?? null })
      .where(eq(RUNS.id, runId))
      .run();
    const companyPatch = { baseline_rule_id: baseline ? rule.id : company.baseline_rule_id };
    if (runMode === 'full') companyPatch.last_full_sweep_at = startedAt;
    if (stats.queued > 0) companyPatch.last_new_job_at = startedAt;
    updateCompany(company.id, companyPatch);
    if (meta.invalid_count) log.warn({ invalid: meta.invalid_count, samples: meta.invalid_samples }, 'some jobs failed validation and were skipped');
    log.info({ ...runStats, per_query: undefined, duration_ms: duration, requests_detail: meta.requests.slice(0, 50) }, `run ok: ${jobs.length} jobs, ${stats.new} new, ${stats.queued} to notify${baseline ? ' (baseline)' : ''}`);
    await updateHealthAfterRun(getCompany(company.id), rule, { ok: true, jobCount: jobs.length, mode: runMode, onFallback, baseline, hitCap: !!meta.hit_cap });
  } catch (err) {
    const duration = now() - startedAt;
    const cancelled = err.type === 'Cancelled' || reg.signal.aborted;
    const detail = { ...errorDetail(err), meta: err.meta ? { ...err.meta, requests: err.meta.requests?.slice(0, 50) } : undefined };
    getDb()
      .update(RUNS)
      .set({
        status: cancelled ? 'cancelled' : 'error',
        duration_ms: duration,
        http_status: err.status ?? err.meta?.last_status ?? null,
        error_type: err.type || err.name || 'Error',
        error_message: err.message,
        error_detail: detail,
        artifacts: err.meta?.artifacts ?? err.detail?.artifacts ?? null,
      })
      .where(eq(RUNS.id, runId))
      .run();
    if (cancelled) log.warn({ reason: String(reg.signal.reason || err.message) }, 'run cancelled');
    else {
      log.error({ err: detail, error_type: err.type, http_status: err.status, duration_ms: duration }, `run failed: ${err.type || 'Error'}: ${err.message}`);
      await updateHealthAfterRun(getCompany(company.id), rule, { ok: false, error: err, mode: runMode, onFallback });
    }
  } finally {
    reg.done();
  }
  result = getDb().select().from(RUNS).where(eq(RUNS.id, runId)).get();
  return result;
}
