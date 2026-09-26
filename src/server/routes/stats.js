import { getSqlite } from '../../db/index.js';
import { now } from '../../runtime.js';

export default async function statsRoutes(app) {
  app.get('/api/stats', async () => {
    const db = getSqlite();
    const one = (sql, ...p) => db.prepare(sql).get(...p)?.n ?? 0;
    const since = now() - 24 * 3600 * 1000;
    return {
      companies: one('select count(*) n from companies'),
      openJobs: one('select count(*) n from jobs where closed_at is null'),
      newJobs24h: one('select count(*) n from jobs where first_seen_at >= ?', since),
      notified24h: one("select count(*) n from notifications where status = 'sent' and sent_at >= ?", since),
      runningTasks: one("select count(*) n from tasks where status in ('queued','running','cancelling')"),
      openAlerts: one("select count(*) n from alerts where state = 'open'"),
      attention: db
        .prepare("select id, name, status, health_note from companies where status in ('failing','degraded','needs_review') order by updated_at desc limit 20")
        .all(),
    };
  });
}
