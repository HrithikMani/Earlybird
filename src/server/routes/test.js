import { getSqlite } from '../../db/index.js';
import { clearSettingsCache } from '../../settings/index.js';
import { runtime } from '../../runtime.js';
import { testHooks } from '../../testing.js';
import { config } from '../../config.js';

// Registered ONLY when EARLYBIRD_TEST=1 (see app.js). Never available in normal use.
export default async function testRoutes(app) {
  if (!config.isTest) return;

  app.post('/api/test/reset', async () => {
    const db = getSqlite();
    const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%'").all();
    db.transaction(() => {
      for (const { name } of tables) db.prepare(`delete from "${name}"`).run();
    })();
    clearSettingsCache();
    runtime.clockOffsetMs = 0;
    return { ok: true };
  });

  app.post('/api/test/tick', async () => testHooks.tick());
  app.post('/api/test/drain-tasks', async () => testHooks.drainTasks());
  app.post('/api/test/drain-outbox', async () => testHooks.drainOutbox());
  app.post('/api/test/cleanup', async () => testHooks.cleanup());

  app.post('/api/test/advance-clock', async (req) => {
    runtime.clockOffsetMs += Number(req.body?.ms || 0);
    return { offsetMs: runtime.clockOffsetMs, now: Date.now() + runtime.clockOffsetMs };
  });

  app.post('/api/test/sql', async (req) => {
    const { sql, params = [] } = req.body;
    const stmt = getSqlite().prepare(sql);
    return stmt.reader ? { rows: stmt.all(...params) } : { info: stmt.run(...params) };
  });
}
