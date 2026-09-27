import { safeParseRule, formatZodError } from '../schema/rule.js';
import { runApi } from './api.js';
import { runHtml } from './html.js';
import { runBrowser } from './browser.js';
import { runScript } from './script.js';
import { isAllowedByRobots } from './robots.js';
import { normalizeJob } from './normalize.js';
import { Cancelled, InvalidRule, RobotsDisallowed, RunnerError } from './errors.js';

export * from './errors.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Earlybird/0.1';

/** Which queries to run for a rule given the search terms. */
export function planQueries(rule, terms = [], maxTerms = 10) {
  const clean = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
  const mode = rule.search?.mode ?? 'none';
  if (mode === 'none' || clean.length === 0) return { queries: [''], capped: false };
  if (mode === 'combined') return { queries: [clean.join(rule.search.combine_with ?? ' OR ')], capped: false };
  if (clean.length > maxTerms) return { queries: [''], capped: true };
  return { queries: clean, capped: false };
}

function firstUrl(rule) {
  if (rule.type === 'browser') return rule.actions.find((a) => a.do === 'goto')?.url;
  return rule.url;
}

/**
 * Executes a rule and returns normalized jobs. Pure: no DB, no Discord, no LLM.
 * @param {object} ruleInput rule JSON (validated here)
 * @param {object} opts { mode, terms, signal, log, userAgent, timeoutMs, actionTimeoutMs, respectRobots,
 *   maxTerms, artifactsDir, saveTraces, scriptPath, scriptCode, scriptTimeoutMs, scriptMemoryMb }
 * @returns {Promise<{jobs: object[], meta: object}>}
 */
export async function runRule(ruleInput, opts = {}) {
  const parsed = safeParseRule(ruleInput);
  if (!parsed.success) throw new InvalidRule(`rule is invalid: ${formatZodError(parsed.error)}`, { detail: { issues: parsed.error.issues } });
  const rule = parsed.data;
  const mode = opts.mode === 'fast' ? 'fast' : 'full';
  const started = Date.now();
  const meta = { mode, type: rule.type, started_at: started, requests: [], pages: 0, per_query: {}, invalid_count: 0, invalid_samples: [], bytes: 0 };
  const ctx = {
    mode,
    signal: opts.signal,
    log: opts.log,
    meta,
    userAgent: opts.userAgent || DEFAULT_UA,
    timeoutMs: opts.timeoutMs ?? 30000,
    actionTimeoutMs: opts.actionTimeoutMs ?? 30000,
    artifactsDir: opts.artifactsDir,
    saveTraces: opts.saveTraces,
    scriptPath: opts.scriptPath,
    scriptCode: opts.scriptCode,
    scriptTimeoutMs: opts.scriptTimeoutMs,
    scriptMemoryMb: opts.scriptMemoryMb,
  };
  if (opts.signal?.aborted) throw new Cancelled();

  const target = firstUrl(rule);
  if (opts.respectRobots && target && rule.type !== 'script') {
    const probe = target.replace(/\{\{\s*\w+\s*\}\}/g, '');
    if (!(await isAllowedByRobots(probe, { userAgent: ctx.userAgent, signal: opts.signal }))) {
      throw new RobotsDisallowed(`robots.txt disallows ${probe}`, { detail: { url: probe } });
    }
  }

  const byKey = new Map();
  const addRaw = (raw, baseUrl, term) => {
    for (const r of raw) {
      const t = r._term ?? term;
      const res = normalizeJob(r, rule, { baseUrl, searchTerm: t });
      if (res.error) {
        meta.invalid_count++;
        if (meta.invalid_samples.length < 5) meta.invalid_samples.push({ error: res.error, raw: res.raw });
        continue;
      }
      const key = res.job.external_id || res.job.url;
      if (!byKey.has(key)) byKey.set(key, res.job);
    }
  };

  try {
    if (rule.type === 'script') {
      const { queries, capped } = planQueries(rule, opts.terms, opts.maxTerms ?? 10);
      meta.terms_capped = capped;
      const terms = queries.filter(Boolean);
      const { raw, baseUrl } = await runScript(rule, ctx, terms);
      meta.per_query['(script)'] = raw.length;
      addRaw(raw, baseUrl, undefined);
    } else {
      const { queries, capped } = planQueries(rule, opts.terms, opts.maxTerms ?? 10);
      meta.terms_capped = capped;
      meta.queries = queries;
      const exec = rule.type === 'api' ? runApi : rule.type === 'html' ? runHtml : runBrowser;
      for (const q of queries) {
        const { raw, baseUrl } = await exec(rule, ctx, q);
        meta.per_query[q || '(all)'] = raw.length;
        addRaw(raw, baseUrl, q || undefined);
      }
    }
  } catch (err) {
    meta.duration_ms = Date.now() - started;
    if (err instanceof RunnerError) {
      err.meta = meta;
      throw err;
    }
    const wrapped = new RunnerError('InternalError', err.message, { cause: err, detail: { stack: err.stack } });
    wrapped.meta = meta;
    throw wrapped;
  }

  meta.duration_ms = Date.now() - started;
  const jobs = [...byKey.values()];
  meta.job_count = jobs.length;
  return { jobs, meta, rule };
}
