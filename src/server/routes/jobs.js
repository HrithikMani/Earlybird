import { getSqlite, newId } from '../../db/index.js';
import { getSettings } from '../../settings/index.js';
import { drainOutbox, sendTestMessage } from '../../notify/discord.js';

// Whitelisted ORDER BY clauses (never interpolate user input into SQL). Jobs without a posted date go last.
const SORTS = {
  posted: 'j.posted_at is null, j.posted_at desc, j.first_seen_at desc',
  posted_asc: 'j.posted_at is null, j.posted_at asc, j.first_seen_at asc',
  first_seen: 'j.first_seen_at desc, j.title',
  first_seen_asc: 'j.first_seen_at asc, j.title',
  company: 'c.name, j.posted_at is null, j.posted_at desc',
  title: 'j.title collate nocase, j.posted_at desc',
};

export default async function jobRoutes(app) {
  app.get('/api/jobs', async (req) => {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.company_id) {
      where.push('j.company_id = ?');
      params.push(q.company_id);
    }
    if (q.rule_id) {
      where.push('j.rule_id = ?');
      params.push(q.rule_id);
    }
    if (q.q) {
      where.push('(j.title like ? or j.location like ? or c.name like ?)');
      params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
    }
    if (q.role) {
      where.push('j.matched_roles like ?');
      params.push(`%"${q.role}"%`);
    }
    if (q.status === 'open') where.push('j.closed_at is null');
    if (q.status === 'closed') where.push('j.closed_at is not null');
    if (q.notify_status) {
      where.push('j.notify_status = ?');
      params.push(q.notify_status);
    }
    if (q.skip_reason) {
      where.push('j.notify_skip_reason = ?');
      params.push(q.skip_reason);
    }
    if (q.since) {
      where.push('j.first_seen_at >= ?');
      params.push(Number(q.since));
    }
    const limit = Math.min(Number(q.limit) || 100, 1000);
    const offset = Number(q.offset) || 0;
    const sql = `select j.*, c.name as company_name from jobs j join companies c on c.id = j.company_id
      ${where.length ? 'where ' + where.join(' and ') : ''} order by ${Object.hasOwn(SORTS, q.sort) ? SORTS[q.sort] : SORTS.posted} limit ? offset ?`;
    const rows = getSqlite().prepare(sql).all(...params, limit, offset);
    return { items: rows.map((r) => ({ ...r, matched_roles: JSON.parse(r.matched_roles || '[]') })) };
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    const db = getSqlite();
    const job = db.prepare('select j.*, c.name as company_name from jobs j join companies c on c.id = j.company_id where j.id = ?').get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    const seen = db.prepare('select * from seen_jobs where company_id = ? and job_key = ?').get(job.company_id, job.job_key);
    const notifications = db.prepare('select * from notifications where company_id = ? and job_key = ? order by created_at').all(job.company_id, job.job_key);
    return { job: { ...job, matched_roles: JSON.parse(job.matched_roles || '[]') }, seen, notifications };
  });

  /** Manual resend: an explicit, separate notification (kind=resend), never automatic. */
  app.post('/api/jobs/:id/resend', async (req, reply) => {
    const db = getSqlite();
    const job = db.prepare('select * from jobs where id = ?').get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    const company = db.prepare('select discord_channel_id from companies where id = ?').get(job.company_id);
    const channelId = req.body?.channelId || company.discord_channel_id || getSettings('discord').jobsChannelId;
    if (!channelId) return reply.code(400).send({ error: 'no_channel', message: 'No Discord jobs channel configured.' });
    db.prepare("delete from notifications where company_id = ? and job_key = ? and channel_id = ? and kind = 'resend'").run(job.company_id, job.job_key, channelId);
    db.prepare("insert into notifications (id, company_id, job_key, job_id, channel_id, kind, status, attempts, created_at) values (?, ?, ?, ?, ?, 'resend', 'pending', 0, ?)").run(
      newId('ntf'), job.company_id, job.job_key, job.id, channelId, Date.now(),
    );
    req.log.info({ scope: 'audit', job_id: job.id, company_id: job.company_id }, 'job resend requested');
    return drainOutbox();
  });

  app.post('/api/discord/test', async (req) => sendTestMessage(req.body?.channelId));
}
