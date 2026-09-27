import { getSqlite } from '../../db/index.js';
import { enqueueDiscovery, enqueueTask, getTask, killTask, retryTask, stopTask } from '../../tasks/queue.js';
import { taskBus } from '../../tasks/events.js';
import { getRule } from '../../store/rules.js';
import { getCompany } from '../../store/companies.js';
import { getRole } from '../../roles/store.js';
import { llmAvailable } from '../../agents/model.js';
import { getSettings } from '../../settings/index.js';
import { testMcpServer } from '../../agents/mcp.js';
import { openSse } from '../sse.js';

const parseEvent = (r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null });

export default async function taskRoutes(app) {
  app.get('/api/tasks', async (req) => {
    const where = [];
    const params = [];
    if (req.query.status === 'active') where.push("t.status in ('queued','running','cancelling')");
    else if (req.query.status) {
      where.push('t.status = ?');
      params.push(req.query.status);
    }
    if (req.query.kind) {
      where.push('t.kind = ?');
      params.push(req.query.kind);
    }
    if (req.query.company_id) {
      where.push('t.company_id = ?');
      params.push(req.query.company_id);
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = getSqlite()
      .prepare(`select t.*, c.name as company_name from tasks t left join companies c on c.id = t.company_id ${where.length ? 'where ' + where.join(' and ') : ''} order by t.created_at desc limit ?`)
      .all(...params, limit);
    return { items: rows.map((r) => ({ ...r, input: JSON.parse(r.input || 'null'), result: JSON.parse(r.result || 'null') })) };
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const task = getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: 'not_found' });
    const events = getSqlite().prepare('select * from task_events where task_id = ? order by seq').all(task.id).map(parseEvent);
    const chain = [];
    let p = task.parent_task_id;
    while (p && chain.length < 20) {
      const t = getTask(p);
      if (!t) break;
      chain.push({ id: t.id, status: t.status, attempt: t.attempt });
      p = t.parent_task_id;
    }
    const children = getSqlite().prepare('select id, status, attempt from tasks where parent_task_id = ?').all(task.id);
    const { maxCostUsd, maxSteps, maxWallTimeMin } = getSettings('ai');
    return { task, events, company: task.company_id ? getCompany(task.company_id) : null, retry_chain: chain, retries: children, limits: { maxCostUsd, maxSteps, maxWallTimeMin } };
  });

  // Live events: replays everything after ?after=<seq>, then streams new ones.
  app.get('/api/tasks/:id/stream', async (req, reply) => {
    const id = req.params.id;
    const stream = openSse(req, reply);
    const after = Number(req.query.after || 0);
    for (const r of getSqlite().prepare('select * from task_events where task_id = ? and seq > ? order by seq').all(id, after)) stream.send('event', parseEvent(r));
    const on = (ev) => stream.send('event', ev);
    taskBus.on(id, on);
    stream.onClose(() => taskBus.off(id, on));
  });

  app.post('/api/tasks/:id/stop', async (req, reply) => {
    const t = stopTask(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not_found' });
    req.log.info({ scope: 'audit', task_id: t.id }, 'task stop requested');
    return { task: t };
  });

  app.post('/api/tasks/:id/kill', async (req, reply) => {
    const t = killTask(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not_found' });
    req.log.info({ scope: 'audit', task_id: t.id }, 'task kill requested');
    return { task: t };
  });

  app.post('/api/tasks/:id/retry', async (req, reply) => {
    const t = retryTask(req.params.id, { operatorNote: req.body?.note || undefined });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    req.log.info({ scope: 'audit', task_id: t.id, parent: req.params.id, note: req.body?.note }, 'task retried');
    return { task: t };
  });

  app.post('/api/companies/:id/discover', async (req, reply) => {
    const c = getCompany(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const task = enqueueDiscovery(c.id, { operatorNote: req.body?.note });
    req.log.info({ scope: 'audit', company_id: c.id, task_id: task.id }, 'discovery requested');
    return { task, waiting_for_api_key: !llmAvailable(getSettings('ai').discoveryModel) };
  });

  app.post('/api/rules/:id/verify', async (req, reply) => {
    const rule = getRule(req.params.id);
    if (!rule) return reply.code(404).send({ error: 'not_found' });
    const window = ['10m', '1h', '24h'].includes(req.body?.window) ? req.body.window : '1h';
    const task = enqueueTask('verify', { companyId: rule.company_id, ruleId: rule.id, input: { window }, operatorNote: req.body?.note });
    return { task, waiting_for_api_key: !llmAvailable(getSettings('ai').verifyModel) };
  });

  app.post('/api/roles/:id/suggest-synonyms', async (req, reply) => {
    const role = getRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'not_found' });
    return { task: enqueueTask('synonyms', { companyId: role.company_id, input: { role_id: role.id } }) };
  });

  app.post('/api/mcp/test', async (req, reply) => {
    try {
      return { tools: await testMcpServer(req.body || {}) };
    } catch (e) {
      return reply.code(400).send({ error: 'mcp_failed', message: e.message });
    }
  });
}
