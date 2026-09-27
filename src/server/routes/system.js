import { sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { runtime, now } from '../../runtime.js';
import { configWarnings } from '../../settings/index.js';
import { APP_VERSION, config } from '../../config.js';

const STALL_MS = 3 * 60 * 1000;

export function healthSnapshot() {
  let dbOk = true;
  let dbError;
  try {
    getDb().get(sql`select 1`);
  } catch (e) {
    dbOk = false;
    dbError = e.message;
  }
  const lastTick = runtime.scheduler.lastTickAt;
  const schedulerStalled = runtime.scheduler.running && (!lastTick || now() - lastTick > STALL_MS) && now() - runtime.startedAt > STALL_MS;
  return {
    ok: dbOk && !schedulerStalled,
    version: APP_VERSION,
    uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
    now: now(),
    testMode: config.isTest,
    db: { ok: dbOk, error: dbError },
    scheduler: { ...runtime.scheduler, stalled: schedulerStalled },
    pools: runtime.pools,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    warnings: dbOk ? configWarnings() : [],
  };
}

export default async function systemRoutes(app) {
  app.post('/api/maintenance/cleanup', async (req) => {
    const { runCleanup } = await import('../../worker/cleanup.js');
    const res = runCleanup();
    req.log.info({ scope: 'audit', ...res }, 'cleanup run manually');
    return res;
  });

  app.get('/api/health', async (_req, reply) => {
    const h = healthSnapshot();
    reply.code(h.db.ok ? 200 : 503);
    return h;
  });
}
