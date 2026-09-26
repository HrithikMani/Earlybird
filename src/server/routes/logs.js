import { and, desc, eq, gte, inArray, like, lt, or } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { logBus } from '../../log/logger.js';
import { openSse } from '../sse.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const L = schema.logs;

function levelsFrom(min) {
  const i = LEVELS.indexOf(min);
  return i < 0 ? LEVELS : LEVELS.slice(i);
}

export default async function logRoutes(app) {
  app.get('/api/logs', async (req) => {
    const q = req.query;
    const where = [];
    if (q.level) where.push(inArray(L.level, levelsFrom(q.level)));
    if (q.scope) where.push(eq(L.scope, q.scope));
    for (const k of ['company_id', 'rule_id', 'run_id', 'task_id']) if (q[k]) where.push(eq(L[k], q[k]));
    if (q.q) where.push(or(like(L.msg, `%${q.q}%`), like(L.data, `%${q.q}%`)));
    if (q.since) where.push(gte(L.ts, Number(q.since)));
    if (q.before) where.push(lt(L.id, Number(q.before)));
    const limit = Math.min(Number(q.limit) || 200, 1000);
    const rows = getDb().select().from(L).where(where.length ? and(...where) : undefined).orderBy(desc(L.id)).limit(limit).all();
    return { items: rows };
  });

  // Live tail of every log entry (all levels >= requested).
  app.get('/api/logs/stream', async (req, reply) => {
    const allowed = new Set(levelsFrom(req.query.level || 'info'));
    const stream = openSse(req, reply);
    const onEntry = (e) => {
      if (!allowed.has(e.levelName)) return;
      if (req.query.scope && e.scope !== req.query.scope) return;
      for (const k of ['company_id', 'rule_id', 'run_id', 'task_id']) if (req.query[k] && e[k] !== req.query[k]) return;
      stream.send('log', e);
    };
    logBus.on('entry', onEntry);
    stream.onClose(() => logBus.off('entry', onEntry));
  });
}
