import { activateRule, approveRule, getRule, listRules, rollbackRule, saveRule, setFallback, ensureScriptFile } from '../../store/rules.js';
import { getCompany } from '../../store/companies.js';
import { effectiveRoles, searchTerms } from '../../roles/match.js';
import { runRule } from '../../runner/index.js';
import { runnerOptions } from '../../worker/scrape.js';
import { formatZodError, ruleJsonSchema, safeParseRule } from '../../schema/rule.js';
import { validateCandidate } from '../../agents/validate.js';
import { getSettings } from '../../settings/index.js';
import { errorDetail } from '../../log/logger.js';
import { getDb, schema } from '../../db/index.js';
import { desc, eq } from 'drizzle-orm';

export default async function ruleRoutes(app) {
  app.get('/api/schema/rule', async () => ruleJsonSchema());

  app.get('/api/rules/:id', async (req, reply) => {
    const rule = getRule(req.params.id);
    if (!rule) return reply.code(404).send({ error: 'not_found' });
    const db = getDb();
    return {
      rule,
      company: getCompany(rule.company_id),
      versions: listRules(rule.company_id).filter((r) => r.rule_key === rule.rule_key),
      runs: db.select().from(schema.runs).where(eq(schema.runs.rule_id, rule.id)).orderBy(desc(schema.runs.started_at)).limit(30).all(),
      verifications: db.select().from(schema.verifications).where(eq(schema.verifications.rule_id, rule.id)).orderBy(desc(schema.verifications.created_at)).limit(20).all(),
      jobs: db.select().from(schema.jobs).where(eq(schema.jobs.rule_id, rule.id)).orderBy(desc(schema.jobs.first_seen_at)).limit(50).all(),
    };
  });

  /** Dry run: executes a stored rule or a draft ({spec, code}) for a company. No DB writes, no Discord. */
  app.post('/api/rules/test', async (req, reply) => {
    const { ruleId, companyId, spec, code, mode = 'full' } = req.body || {};
    const stored = ruleId ? getRule(ruleId) : null;
    const company = getCompany(companyId || stored?.company_id);
    if (!company) return reply.code(404).send({ error: 'company not found' });
    const ruleSpec = stored ? stored.spec : spec;
    const parsed = safeParseRule(ruleSpec);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_rule', message: formatZodError(parsed.error) });
    const terms = searchTerms(effectiveRoles(company));
    try {
      const { jobs, meta } = await runRule(parsed.data, { ...runnerOptions({ log: req.log }), mode, terms, scriptPath: stored ? ensureScriptFile(stored) : undefined, scriptCode: code });
      return { ok: true, count: jobs.length, jobs: jobs.slice(0, 200), meta, terms };
    } catch (err) {
      return { ok: false, error: errorDetail(err), meta: err.meta };
    }
  });

  /**
   * Saves a rule version for a company after running the full validation pipeline.
   * body: { companyId, spec, code?, activate?, asFallback?, force?, reason?, createdBy? }
   */
  app.post('/api/rules', async (req, reply) => {
    const { companyId, spec, code, activate = false, asFallback = false, force = false, reason, createdBy = 'manual', ruleKey } = req.body || {};
    const company = getCompany(companyId);
    if (!company) return reply.code(404).send({ error: 'company not found' });
    const parsed = safeParseRule(spec);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_rule', message: formatZodError(parsed.error) });
    if (parsed.data.type === 'script' && !getSettings('scripts').allow) return reply.code(400).send({ error: 'scripts_disabled', message: 'Script rules are disabled in Settings → Scripts.' });
    const validation = await validateCandidate({ company, spec: parsed.data, code });
    if (!validation.passed && !force) return reply.code(422).send({ error: 'validation_failed', validation });
    const current = company.active_rule_id ? getRule(company.active_rule_id) : null;
    if (activate && current?.score?.total !== undefined && validation.score.total < current.score.total && !force) {
      return reply.code(409).send({ error: 'worse_than_active', message: `new rule scores ${validation.score.total.toFixed(2)} < active ${current.score.total.toFixed(2)}; pass force with a reason to replace it`, validation });
    }
    const needsApproval = parsed.data.type === 'script' && getSettings('scripts').requireApproval;
    const rule = saveRule({ companyId, spec: parsed.data, code, createdBy, ruleKey: ruleKey || current?.rule_key, score: validation.score, notes: reason });
    if (activate && !needsApproval) activateRule(rule.id);
    else if (asFallback) setFallback(rule.id);
    req.log.info({ scope: 'audit', company_id: companyId, rule_id: rule.id, activate, forced: force, reason, score: validation.score.total }, 'rule saved');
    return { rule: getRule(rule.id), validation, needsApproval };
  });

  app.post('/api/rules/:id/activate', async (req) => {
    const company = activateRule(req.params.id, { keepOldAsFallback: !!req.body?.keepOldAsFallback });
    req.log.info({ scope: 'audit', rule_id: req.params.id, company_id: company.id }, 'rule activated');
    return { company };
  });

  app.post('/api/rules/:id/fallback', async (req) => {
    const company = setFallback(req.params.id);
    req.log.info({ scope: 'audit', rule_id: req.params.id }, 'rule set as fallback');
    return { company };
  });

  app.post('/api/rules/:id/approve', async (req) => {
    const rule = approveRule(req.params.id);
    activateRule(rule.id);
    req.log.info({ scope: 'audit', rule_id: rule.id }, 'script rule approved');
    return { rule };
  });

  app.post('/api/companies/:id/rollback', async (req) => {
    const rule = rollbackRule(req.params.id);
    req.log.info({ scope: 'audit', company_id: req.params.id, rule_id: rule.id }, 'rule rolled back');
    return { rule };
  });

  app.get('/api/rules/:id/code', async (req, reply) => {
    const rule = getRule(req.params.id);
    if (!rule?.code) return reply.code(404).send({ error: 'no code' });
    return reply.type('text/plain; charset=utf-8').send(rule.code);
  });

}
