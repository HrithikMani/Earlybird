import path from 'node:path';
import { getSqlite, newId } from '../db/index.js';
import { getSettings } from '../settings/index.js';
import { config } from '../config.js';
import { now } from '../runtime.js';
import { formatZodError } from '../schema/rule.js';
import { VerifyReportSchema, extractJson } from '../schema/agent.js';
import { effectiveRoles, searchTerms } from '../roles/match.js';
import { getCompany } from '../store/companies.js';
import { ensureScriptFile, getRule } from '../store/rules.js';
import { raiseAlert } from '../store/alerts.js';
import { runRule } from '../runner/index.js';
import { runnerOptions } from '../worker/scrape.js';
import { emitTaskEvent } from '../tasks/events.js';
import { buildModel } from './model.js';
import { connectMcp } from './mcp.js';
import { buildTools, windowMs } from './tools.js';
import { loadPrompt } from './prompts.js';
import { runAgentTurn } from './loop.js';

const SYSTEM = `You are Earlybird's rule auditor. You check, with the browser tools and the run_rule / get_recent_jobs tools, whether a scraper rule
is catching the newest jobs on a careers portal. You never change the rule. Your final message must contain only the requested JSON object.`;

/** Deterministic checks (no LLM) that feed the verification prompt and the CLI. */
export async function precheck(ruleId, window = '1h', { signal } = {}) {
  const rule = getRule(ruleId);
  if (!rule) throw Object.assign(new Error(`rule ${ruleId} not found`), { statusCode: 404 });
  const company = getCompany(rule.company_id);
  const terms = searchTerms(effectiveRoles(company));
  const db = getSqlite();
  const since = now() - windowMs(window);
  const out = { rule_id: rule.id, company: company.name, window, checked_at: new Date(now()).toISOString() };
  for (const mode of ['fast', 'full']) {
    try {
      const { jobs, meta } = await runRule(rule.spec, { ...runnerOptions({ signal }), mode, terms, scriptPath: ensureScriptFile(rule) });
      const newest = jobs.filter((j) => j.posted_at).sort((a, b) => b.posted_at - a.posted_at)[0];
      out[mode] = { ok: true, job_count: jobs.length, pages: meta.pages, newest_posted: newest ? { title: newest.title, posted_at: new Date(newest.posted_at).toISOString() } : null, posted_in_window: jobs.filter((j) => j.posted_at && j.posted_at >= since).map((j) => j.title).slice(0, 20) };
    } catch (err) {
      out[mode] = { ok: false, error: `${err.type || 'Error'}: ${err.message}` };
    }
  }
  const recent = db.prepare('select title, posted_at, first_seen_at, notify_status, notify_skip_reason from jobs where company_id = ? and first_seen_at >= ? order by first_seen_at desc').all(company.id, since);
  out.stored_first_seen_in_window = recent.length;
  out.sent_in_window = recent.filter((j) => j.notify_status === 'sent').length;
  const lags = recent.filter((j) => j.posted_at && j.first_seen_at >= j.posted_at).map((j) => j.first_seen_at - j.posted_at);
  out.median_detection_lag_min = lags.length ? Math.round(lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)] / 60000) : null;
  out.last_success_at = company.last_success_at ? new Date(company.last_success_at).toISOString() : null;
  out.recent_errors = db.prepare("select error_type, error_message, started_at from runs where company_id = ? and status = 'error' order by started_at desc limit 5").all(company.id).map((r) => ({ ...r, started_at: new Date(r.started_at).toISOString() }));
  return out;
}

/** Stores a verification report (from the in-app agent or the CLI) and alerts when it isn't healthy. */
export async function saveVerification({ rule, report, taskId = null, source = 'app' }) {
  const parsed = VerifyReportSchema.parse(report);
  const id = newId('vfy');
  getSqlite()
    .prepare('insert into verifications (id, rule_id, company_id, task_id, source, window, verdict, report, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, rule.id, rule.company_id, taskId, source, parsed.window, parsed.verdict, JSON.stringify(parsed), Date.now());
  if (parsed.verdict !== 'healthy') {
    const company = getCompany(rule.company_id);
    await raiseAlert({
      companyId: rule.company_id,
      ruleId: rule.id,
      kind: `verification_${parsed.verdict}`,
      message: `${company.name}: verification of ${rule.id} (${parsed.window}) says ${parsed.verdict}. ${parsed.missing.length ? `Missing: ${parsed.missing.map((m) => m.title).slice(0, 5).join(', ')}. ` : ''}Suggested: ${parsed.suggested_action.replaceAll('_', ' ')}.`,
    });
  }
  return { id, ...parsed };
}

export async function runVerification(task, { signal, state, onKill, log, setTaskMeta }) {
  const rule = getRule(task.rule_id);
  if (!rule) throw new Error(`rule ${task.rule_id} not found`);
  const company = getCompany(rule.company_id);
  const window = task.input?.window || '1h';
  const ai = getSettings('ai');

  emitTaskEvent(task.id, 'phase', { phase: 'verify', note: `Pre-checks for ${rule.id} (window ${window})` });
  const pre = await precheck(rule.id, window, { signal });
  emitTaskEvent(task.id, 'tool_result', { tool: 'precheck', output: pre });

  const prompt = loadPrompt('verify-rule', {
    company_name: company.name,
    careers_url: company.careers_url,
    rule_id: rule.id,
    rule_version: String(rule.version),
    rule_strategy: rule.strategy,
    rule_type: rule.type,
    rule_json: rule.spec,
    window,
    now_iso: new Date(now()).toISOString(),
    precheck_json: pre,
    operator_note: task.operator_note ? `Operator note: ${task.operator_note}` : '',
  });
  setTaskMeta({ prompt_file: prompt.file, prompt_hash: prompt.hash, model: ai.verifyModel });
  const model = await buildModel(ai.verifyModel, { vars: { careers_url: company.careers_url, company_name: company.name, rule_id: rule.id, window } });
  const mcp = await connectMcp({ agent: 'verify', outputDir: path.join(config.paths.artifacts, task.id), log });
  onKill(() => mcp.close());
  try {
    const tools = { ...mcp.tools, ...buildTools({ company, signal, onPhase: (phase, note) => emitTaskEvent(task.id, 'phase', { phase, note }) }) };
    const messages = [{ role: 'user', content: prompt.text }];
    for (let attempt = 1; attempt <= ai.maxAttempts; attempt++) {
      const { text, responseMessages } = await runAgentTurn({ state, model, system: SYSTEM, messages, tools, signal });
      messages.push(...responseMessages);
      let report;
      try {
        report = VerifyReportSchema.parse({ window, ...extractJson(text) });
      } catch (e) {
        const feedback = `Your report could not be used: ${formatZodError(e)}. Reply with ONLY the JSON object.`;
        emitTaskEvent(task.id, 'log', { message: feedback }, 'warn');
        messages.push({ role: 'user', content: feedback });
        continue;
      }
      const saved = await saveVerification({ rule, report, taskId: task.id });
      const summary = `Verdict: ${saved.verdict} (window ${window}). ${saved.notes}`;
      emitTaskEvent(task.id, 'phase', { phase: 'commit', note: summary });
      return { summary, verification_id: saved.id, verdict: saved.verdict, report: saved, precheck: pre };
    }
    throw Object.assign(new Error('the verification agent did not return a usable report'), { type: 'bad_output' });
  } finally {
    await mcp.close();
  }
}

