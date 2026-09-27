import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { createCompany, deleteCompany, editCompany, getCompany, listCompanies, updateCompany } from '../../store/companies.js';
import { currentRuleFor, getRule, listRules } from '../../store/rules.js';
import { listAlerts } from '../../store/alerts.js';
import { effectiveRoles, searchTerms } from '../../roles/match.js';
import { listRoles } from '../../roles/store.js';
import { runNow } from '../../worker/scheduler.js';
import { formatZodError } from '../../schema/rule.js';
import { drainOutbox } from '../../notify/discord.js';

function summarize(c) {
  const rule = currentRuleFor(c);
  const db = getDb();
  const openJobs = db.$client.prepare('select count(*) n from jobs where company_id = ? and closed_at is null').get(c.id).n;
  return { ...c, rule: rule ? { id: rule.id, type: rule.type, strategy: rule.strategy, version: rule.version } : null, open_jobs: openJobs };
}

export default async function companyRoutes(app) {
  app.get('/api/companies', async () => ({ items: listCompanies().map(summarize) }));

  app.post('/api/companies', async (req, reply) => {
    const { roles = [], rule, ...rest } = req.body || {};
    let company;
    try {
      company = createCompany(rest);
    } catch (e) {
      return reply.code(400).send({ error: 'validation_failed', message: formatZodError(e) });
    }
    const { createRole } = await import('../../roles/store.js');
    for (const r of roles) createRole(typeof r === 'string' ? { name: r, scope: 'company', company_id: company.id } : { ...r, scope: 'company', company_id: company.id });
    req.log.info({ scope: 'audit', company_id: company.id, name: company.name, url: company.careers_url }, 'company added');
    const { enqueueDiscovery } = await import('../../tasks/queue.js').catch(() => ({}));
    let task = null;
    if (!rule && enqueueDiscovery && req.body?.discover !== false) task = enqueueDiscovery(company.id);
    return { company: getCompany(company.id), task };
  });

  app.get('/api/companies/:id', async (req, reply) => {
    const c = getCompany(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const db = getDb();
    const roles = effectiveRoles(c);
    return {
      company: summarize(c),
      rules: listRules(c.id),
      active_rule: c.active_rule_id ? getRule(c.active_rule_id) : null,
      fallback_rule: c.fallback_rule_id ? getRule(c.fallback_rule_id) : null,
      company_roles: listRoles({ scope: 'company', company_id: c.id }),
      effective_roles: roles.map((r) => ({ id: r.id, name: r.name, scope: r.scope })),
      search_terms: searchTerms(roles),
      runs: db.select().from(schema.runs).where(eq(schema.runs.company_id, c.id)).orderBy(desc(schema.runs.started_at)).limit(30).all(),
      tasks: db.select().from(schema.tasks).where(eq(schema.tasks.company_id, c.id)).orderBy(desc(schema.tasks.created_at)).limit(20).all(),
      verifications: db.select().from(schema.verifications).where(eq(schema.verifications.company_id, c.id)).orderBy(desc(schema.verifications.created_at)).limit(10).all(),
      alerts: listAlerts({ companyId: c.id, limit: 20 }),
    };
  });

  app.put('/api/companies/:id', async (req, reply) => {
    try {
      const c = editCompany(req.params.id, req.body || {});
      if (!c) return reply.code(404).send({ error: 'not_found' });
      req.log.info({ scope: 'audit', company_id: c.id, keys: Object.keys(req.body || {}) }, 'company updated');
      return { company: c };
    } catch (e) {
      return reply.code(400).send({ error: 'validation_failed', message: formatZodError(e) });
    }
  });

  app.delete('/api/companies/:id', async (req) => {
    deleteCompany(req.params.id);
    req.log.info({ scope: 'audit', company_id: req.params.id }, 'company deleted');
    return { ok: true };
  });

  app.post('/api/companies/:id/pause', async (req) => {
    const c = updateCompany(req.params.id, { status: 'paused' });
    req.log.info({ scope: 'audit', company_id: c.id }, 'company paused');
    return { company: c };
  });

  app.post('/api/companies/:id/resume', async (req) => {
    const c = getCompany(req.params.id);
    const c2 = updateCompany(c.id, { status: c.active_rule_id ? 'active' : 'pending_discovery', next_run_at: null });
    req.log.info({ scope: 'audit', company_id: c.id }, 'company resumed');
    return { company: c2 };
  });

  // Run now. Waits for completion (runs are short); the dashboard shows progress via the Tasks page.
  app.post('/api/companies/:id/run', async (req) => {
    const mode = ['fast', 'full'].includes(req.body?.mode) ? req.body.mode : undefined;
    const run = await runNow(req.params.id, { mode });
    await drainOutbox();
    return { run };
  });

  app.get('/api/companies/:id/runs', async (req) => {
    const db = getDb();
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    return { items: db.select().from(schema.runs).where(eq(schema.runs.company_id, req.params.id)).orderBy(desc(schema.runs.started_at)).limit(limit).all() };
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const db = getDb();
    const run = db.select().from(schema.runs).where(eq(schema.runs.id, req.params.id)).get();
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const logs = db.select().from(schema.logs).where(eq(schema.logs.run_id, run.id)).orderBy(schema.logs.id).limit(500).all();
    return { run, logs, company: getCompany(run.company_id) };
  });

  app.get('/api/alerts', async (req) => ({ items: listAlerts({ state: req.query.state, limit: 200 }) }));
  app.post('/api/alerts/:id/resolve', async (req) => {
    const { resolveAlertById } = await import('../../store/alerts.js');
    resolveAlertById(req.params.id);
    return { ok: true };
  });

  app.get('/api/artifacts/:runId/:file', async (req, reply) => {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const { config } = await import('../../config.js');
    const file = path.join(config.paths.artifacts, path.basename(req.params.runId), path.basename(req.params.file));
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not_found' });
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.html') ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    return reply.type(type).send(fs.createReadStream(file));
  });

  app.get('/api/running', async () => {
    const registry = await import('../../tasks/registry.js');
    return { items: registry.list() };
  });

  app.post('/api/running/:id/stop', async (req, reply) => {
    const registry = await import('../../tasks/registry.js');
    return registry.stop(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'not running' });
  });

  app.post('/api/running/:id/kill', async (req, reply) => {
    const registry = await import('../../tasks/registry.js');
    return registry.kill(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'not running' });
  });

}
