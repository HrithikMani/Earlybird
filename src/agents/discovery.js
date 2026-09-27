import path from 'node:path';
import { getSettings } from '../settings/index.js';
import { config } from '../config.js';
import { ruleJsonSchema, formatZodError } from '../schema/rule.js';
import { DiscoveryResultSchema, extractJson } from '../schema/agent.js';
import { effectiveRoles, searchTerms } from '../roles/match.js';
import { getCompany, updateCompany } from '../store/companies.js';
import { activateRule, saveRule, setFallback, getRule } from '../store/rules.js';
import { executeRun } from '../worker/scrape.js';
import { emitTaskEvent } from '../tasks/events.js';
import { buildModel } from './model.js';
import { connectMcp } from './mcp.js';
import { buildTools } from './tools.js';
import { loadPrompt } from './prompts.js';
import { runAgentTurn } from './loop.js';
import { validateCandidate } from './validate.js';

const SYSTEM = `You are Earlybird's rule-discovery agent. You configure a job scraper for one company by exploring its careers portal
with the browser tools, then building rules and testing them with the run_rule tool. Work in phases (explore → analyze → build → test → commit)
and call report_phase when you change phase. Your final message must contain only the JSON object requested in the instructions.`;

export class NoValidRule extends Error {
  constructor(message, detail) {
    super(message);
    this.type = 'no_valid_rule';
    this.detail = detail;
  }
}

function candidateSummary(c, v) {
  return { strategy: c.strategy, type: c.rule?.type, passed: v.passed, score: v.score, errors: v.errors, job_count: v.job_count, role_matched: v.role_matched_count };
}

/** Discovery task: returns { active_rule_id, fallback_rule_id, candidates[], evidence, summary }. */
export async function runDiscovery(task, { signal, state, onKill, log, setTaskMeta }) {
  const company = getCompany(task.company_id);
  if (!company) throw new Error(`company ${task.company_id} not found`);
  const ai = getSettings('ai');
  const roles = effectiveRoles(company);
  const terms = searchTerms(roles);
  updateCompany(company.id, { status: 'discovering' });

  const prompt = loadPrompt('discover-rule', {
    company_name: company.name,
    careers_url: company.careers_url,
    roles: roles.length ? roles.map((r) => `- ${r.name} (search terms: ${(r.search_terms || [r.name]).join(', ')})`).join('\n') : '(no roles: all jobs are wanted)',
    search_terms: terms.join(', ') || '(none)',
    source_filters: company.source_filters ? JSON.stringify(company.source_filters) : '(none)',
    operator_note: task.operator_note ? `Operator note: ${task.operator_note}` : '',
    rule_schema_json: ruleJsonSchema(),
    scripts_allowed: getSettings('scripts').allow ? 'yes' : 'no',
  });
  setTaskMeta({ prompt_file: prompt.file, prompt_hash: prompt.hash, model: ai.discoveryModel });

  const model = await buildModel(ai.discoveryModel, { vars: { careers_url: company.careers_url, company_name: company.name } });
  emitTaskEvent(task.id, 'phase', { phase: 'explore', note: `Starting: opening ${company.careers_url} in Playwright` });
  const mcp = await connectMcp({ agent: 'discovery', outputDir: path.join(config.paths.artifacts, task.id), log });
  onKill(() => mcp.close());
  try {
    const tools = { ...mcp.tools, ...buildTools({ company, signal, onPhase: (phase, note) => emitTaskEvent(task.id, 'phase', { phase, note }) }) };
    const messages = [{ role: 'user', content: prompt.text }];
    const history = [];

    for (let attempt = 1; attempt <= ai.maxAttempts; attempt++) {
      emitTaskEvent(task.id, 'status', { message: `attempt ${attempt} of ${ai.maxAttempts}` });
      const { text, responseMessages } = await runAgentTurn({ state, model, system: SYSTEM, messages, tools, signal });
      messages.push(...responseMessages);

      let parsed;
      try {
        parsed = DiscoveryResultSchema.parse(extractJson(text));
      } catch (e) {
        const feedback = `Your final answer could not be used: ${formatZodError(e)}. Reply again with ONLY the JSON object described in the instructions.`;
        emitTaskEvent(task.id, 'log', { message: feedback }, 'warn');
        history.push({ attempt, error: feedback });
        messages.push({ role: 'user', content: feedback });
        continue;
      }

      emitTaskEvent(task.id, 'phase', { phase: 'test', note: `Validating ${parsed.candidates.length} candidate(s) in code (2 full runs + 1 fast run each, real role terms)` });
      const results = [];
      for (const cand of parsed.candidates) {
        if (cand.strategy === 'script' && !getSettings('scripts').allow) {
          results.push({ cand, v: { passed: false, errors: ['script rules are disabled in Settings'], score: { total: 0 } } });
          continue;
        }
        const v = await validateCandidate({ company, spec: cand.rule, code: cand.code, evidence: parsed.evidence, signal, log });
        results.push({ cand, v });
        emitTaskEvent(task.id, 'validation', candidateSummary(cand, v), v.passed ? 'info' : 'warn');
      }
      const passing = results.filter((r) => r.v.passed).sort((a, b) => b.v.score.total - a.v.score.total || (b.v.score.cost ?? 0) - (a.v.score.cost ?? 0));
      history.push({ attempt, candidates: results.map((r) => candidateSummary(r.cand, r.v)) });

      if (!passing.length) {
        const feedback = `None of your candidates passed validation:\n${results.map((r) => `- ${r.cand.strategy}: ${r.v.errors.join('; ')}`).join('\n')}\nFix the rules (test them with run_rule) and answer again with the JSON object.`;
        emitTaskEvent(task.id, 'log', { message: feedback }, 'warn');
        messages.push({ role: 'user', content: feedback });
        continue;
      }

      // Commit: winner → active, runner-up → fallback.
      const requireApproval = getSettings('scripts').requireApproval;
      const [best, second] = passing;
      const note = (r) => `${r.cand.notes || ''}${parsed.evidence.how_to_get_newest ? ` | newest jobs: ${parsed.evidence.how_to_get_newest}` : ''}`.trim();
      const current = getCompany(company.id);
      const winner = saveRule({ companyId: company.id, spec: best.cand.rule, code: best.cand.code, createdBy: 'discovery', sourceTaskId: task.id, score: best.v.score, notes: note(best), ruleKey: current.active_rule_id ? getRule(current.active_rule_id)?.rule_key : undefined });
      const needsApproval = winner.type === 'script' && requireApproval;
      if (!needsApproval) activateRule(winner.id);
      let fallback = null;
      if (second) {
        fallback = saveRule({ companyId: company.id, spec: second.cand.rule, code: second.cand.code, createdBy: 'discovery', sourceTaskId: task.id, score: second.v.score, notes: note(second) });
        setFallback(fallback.id);
      }

      let baselineRun = null;
      if (!needsApproval) {
        emitTaskEvent(task.id, 'status', { message: 'Running the baseline (current jobs are recorded, nothing is sent to Discord)' });
        baselineRun = await executeRun(company.id, { trigger: 'baseline' });
      } else {
        updateCompany(company.id, { status: 'needs_review', health_note: `Script rule ${winner.id} is waiting for approval` });
      }
      const why = `${best.cand.strategy}/${winner.type} scored ${best.v.score.total.toFixed(2)}${second ? ` vs ${second.cand.strategy}/${second.cand.rule.type} ${second.v.score.total.toFixed(2)}` : ''}`;
      const summary = needsApproval
        ? `Rule ${winner.id} (${winner.strategy}/${winner.type}) passed validation and is waiting for approval before it goes live (${why}).`
        : `Rules committed and ready for scheduled runs: active ${winner.id} (${winner.strategy}/${winner.type})${fallback ? `, fallback ${fallback.id} (${fallback.strategy}/${fallback.type})` : ''}. Why: ${why}. Baseline: ${baselineRun?.job_count ?? 0} current jobs recorded.`;
      emitTaskEvent(task.id, 'phase', { phase: 'commit', note: summary });
      return {
        summary,
        active_rule_id: needsApproval ? null : winner.id,
        pending_approval_rule_id: needsApproval ? winner.id : null,
        fallback_rule_id: fallback?.id ?? null,
        baseline_run_id: baselineRun?.id ?? null,
        evidence: parsed.evidence,
        attempts: history,
      };
    }
    throw new NoValidRule(`no candidate passed validation after ${ai.maxAttempts} attempts`, { attempts: history });
  } finally {
    await mcp.close();
  }
}
