import { tool } from 'ai';
import { z } from 'zod';
import { getSqlite } from '../db/index.js';
import { runRule } from '../runner/index.js';
import { runnerOptions } from '../worker/scrape.js';
import { effectiveRoles, searchTerms } from '../roles/match.js';
import { ensureScriptFile, getRule } from '../store/rules.js';
import { now } from '../runtime.js';

const WINDOWS = { '10m': 10 * 60000, '1h': 3600000, '24h': 86400000 };
export const windowMs = (w) => WINDOWS[w] ?? 3600000;

function summarizeRun({ jobs, meta }) {
  const newest = [...jobs].sort((a, b) => (b.posted_at ?? 0) - (a.posted_at ?? 0));
  return {
    ok: true,
    job_count: jobs.length,
    per_query: meta.per_query,
    pages: meta.pages,
    requests: meta.requests.length,
    duration_ms: meta.duration_ms,
    invalid_count: meta.invalid_count,
    invalid_samples: meta.invalid_samples.slice(0, 3),
    jobs_with_posted_date: jobs.filter((j) => j.posted_at).length,
    newest_jobs: newest.slice(0, 12).map((j) => ({ title: j.title, url: j.url, id: j.external_id, location: j.location, posted_at: j.posted_at ? new Date(j.posted_at).toISOString() : j.posted_at_raw, search_term: j.search_term })),
  };
}

function summarizeError(err) {
  return {
    ok: false,
    error_type: err.type || err.name,
    message: err.message,
    detail: err.detail ? JSON.parse(JSON.stringify(err.detail, (k, v) => (k === 'stack' ? undefined : typeof v === 'string' && v.length > 1500 ? v.slice(0, 1500) + '…' : v))) : undefined,
    meta: err.meta ? { pages: err.meta.pages, per_query: err.meta.per_query, actions: err.meta.actions } : undefined,
  };
}

/**
 * Custom tools given to the agents (on top of MCP tools). `onEvent` records a task event.
 */
export function buildTools({ company, signal, onPhase }) {
  const terms = () => searchTerms(effectiveRoles(company));
  return {
    report_phase: tool({
      description: 'Report which phase you are in: explore (open the careers page), analyze (URL, page, network, search/sort/newest jobs), build (form + test rules), commit (final answer). Call it whenever you move to a new phase, with a one-line note of what you found.',
      inputSchema: z.object({ phase: z.enum(['explore', 'analyze', 'build', 'test', 'commit', 'verify']), note: z.string() }),
      execute: async ({ phase, note }) => {
        onPhase?.(phase, note);
        return { ok: true };
      },
    }),
    run_rule: tool({
      description:
        "Run a rule with Earlybird's real runner (the same code the scheduler uses) and see what it returns. Pass either `rule` (draft rule JSON) or `rule_id` (stored rule). For script rules also pass `code`. Uses the company's real role search terms unless `terms` is given. Returns job count, per-query counts, the newest jobs (sorted by posted date) and any error with details.",
      inputSchema: z.object({
        rule: z.record(z.string(), z.any()).optional(),
        rule_id: z.string().optional(),
        code: z.string().optional(),
        mode: z.enum(['fast', 'full']).default('full'),
        terms: z.array(z.string()).optional(),
      }),
      execute: async ({ rule, rule_id, code, mode, terms: t }) => {
        try {
          const stored = rule_id ? getRule(rule_id) : null;
          if (rule_id && !stored) return { ok: false, message: `rule ${rule_id} not found` };
          const spec = stored ? stored.spec : rule;
          if (!spec) return { ok: false, message: 'pass rule or rule_id' };
          const res = await runRule(spec, { ...runnerOptions({ signal }), mode, terms: t ?? terms(), scriptCode: code ?? undefined, scriptPath: stored ? ensureScriptFile(stored) : undefined });
          return summarizeRun(res);
        } catch (err) {
          if (signal?.aborted) throw err;
          return summarizeError(err);
        }
      },
    }),
    get_recent_jobs: tool({
      description: 'Jobs Earlybird has stored for this company recently (first seen within the window), with whether they were sent to Discord.',
      inputSchema: z.object({ window: z.enum(['10m', '1h', '24h']).default('1h'), rule_id: z.string().optional() }),
      execute: async ({ window }) => {
        const since = now() - windowMs(window);
        const rows = getSqlite()
          .prepare('select title, url, location, posted_at, first_seen_at, notify_status, notify_skip_reason, rule_id from jobs where company_id = ? and first_seen_at >= ? order by first_seen_at desc limit 100')
          .all(company.id, since);
        const newestPosted = getSqlite().prepare('select title, url, posted_at from jobs where company_id = ? and posted_at is not null order by posted_at desc limit 10').all(company.id);
        return { window, count: rows.length, jobs: rows, newest_by_posted_date: newestPosted.map((r) => ({ ...r, posted_at: new Date(r.posted_at).toISOString() })) };
      },
    }),
  };
}
