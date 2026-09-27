import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { getDb, schema, tx } from '../db/index.js';
import { getSettings } from '../settings/index.js';
import { childLogger } from '../log/logger.js';
import { now } from '../runtime.js';

const log = childLogger('discord');
const N = schema.notifications;
const MAX_ATTEMPTS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function channelById(id) {
  if (!id) return null;
  return getSettings('discord').channels.find((c) => c.id === id) || null;
}

/** POSTs a payload to a webhook (?wait=true). Retries 429 (honouring retry_after) and 5xx a few times. */
export async function postWebhook(webhookUrl, payload, { attempts = 4 } = {}) {
  if (!/^https?:\/\//.test(webhookUrl || '')) return { ok: false, error: 'webhook URL is not set or invalid' };
  const url = webhookUrl + (webhookUrl.includes('?') ? '&' : '?') + 'wait=true';
  let last;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    } catch (e) {
      last = { ok: false, error: `network: ${e.cause?.code || e.message}` };
      await sleep(500 * 2 ** i);
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      let id;
      try {
        id = JSON.parse(text).id;
      } catch {
        // 204 without body
      }
      return { ok: true, id, status: res.status };
    }
    if (res.status === 429) {
      let retryAfter = Number(res.headers.get('retry-after') || 1);
      try {
        retryAfter = JSON.parse(text).retry_after ?? retryAfter;
      } catch {
        // keep header value
      }
      last = { ok: false, status: 429, error: `rate limited (retry_after ${retryAfter}s)`, retryAfter };
      log.warn({ status: 429, retry_after: retryAfter, attempt: i + 1 }, 'discord rate limited, retrying');
      await sleep(Math.min(retryAfter * 1000, 10000) + 50);
      continue;
    }
    last = { ok: false, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    if (res.status < 500) break;
    await sleep(500 * 2 ** i);
  }
  return last;
}

function trunc(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function jobEmbed(job, company) {
  const fields = [{ name: 'Company', value: trunc(company?.name || '—', 1024), inline: true }];
  const roles = Array.isArray(job.matched_roles) ? job.matched_roles : [];
  if (roles.length) fields.push({ name: 'Role', value: trunc(roles.join(', '), 1024), inline: true });
  if (job.location) fields.push({ name: 'Location', value: trunc(job.location, 1024), inline: true });
  if (job.department) fields.push({ name: 'Department', value: trunc(job.department, 1024), inline: true });
  if (job.posted_at) fields.push({ name: 'Posted', value: `<t:${Math.floor(job.posted_at / 1000)}:R>`, inline: true });
  fields.push({ name: 'First seen', value: `<t:${Math.floor(job.first_seen_at / 1000)}:R>`, inline: true });
  return {
    title: trunc(job.title, 256),
    url: job.url,
    color: 0x2563eb,
    fields,
    footer: { text: trunc(`Earlybird · ${job.rule_id || ''}`, 2048) },
    timestamp: new Date(job.first_seen_at).toISOString(),
  };
}

let draining = null;

/** Sends pending notifications (exactly once per job+channel). Safe to call concurrently. */
export function drainOutbox() {
  draining ??= doDrain().finally(() => {
    draining = null;
  });
  return draining;
}

async function doDrain() {
  const db = getDb();
  const t = now();
  const pending = db
    .select()
    .from(N)
    .where(and(eq(N.status, 'pending'), or(isNull(N.next_attempt_at), lte(N.next_attempt_at, t))))
    .orderBy(asc(N.created_at))
    .limit(500)
    .all();
  if (!pending.length) return { sent: 0, failed: 0 };
  const { batchSize } = getSettings('discord');
  const byChannel = new Map();
  for (const n of pending) {
    if (!byChannel.has(n.channel_id)) byChannel.set(n.channel_id, []);
    byChannel.get(n.channel_id).push(n);
  }
  let sent = 0;
  let failed = 0;
  const companies = new Map();
  const companyOf = (id) => {
    if (!companies.has(id)) companies.set(id, db.select().from(schema.companies).where(eq(schema.companies.id, id)).get());
    return companies.get(id);
  };

  for (const [channelId, list] of byChannel) {
    const channel = channelById(channelId);
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const jobs = db.select().from(schema.jobs).where(inArray(schema.jobs.id, batch.map((n) => n.job_id).filter(Boolean))).all();
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const usable = batch.filter((n) => byId.has(n.job_id));
      const orphaned = batch.filter((n) => !byId.has(n.job_id));
      for (const n of orphaned) db.update(N).set({ status: 'failed', last_error: 'job no longer exists' }).where(eq(N.id, n.id)).run();
      if (!usable.length) continue;
      const embeds = usable.map((n) => {
        const j = byId.get(n.job_id);
        return jobEmbed(j, companyOf(j.company_id));
      });
      const res = channel?.webhookUrl ? await postWebhook(channel.webhookUrl, { username: 'Earlybird', embeds }) : { ok: false, error: `channel ${channelId} has no webhook configured` };
      const ts = now();
      if (res.ok) {
        tx(() => {
          for (const n of usable) {
            db.update(N).set({ status: 'sent', sent_at: ts, discord_message_id: res.id ?? null, attempts: n.attempts + 1, last_error: null }).where(eq(N.id, n.id)).run();
            const j = byId.get(n.job_id);
            db.update(schema.jobs).set({ notify_status: 'sent', notify_skip_reason: null }).where(eq(schema.jobs.id, j.id)).run();
            db.update(schema.seenJobs).set({ notified_at: ts }).where(and(eq(schema.seenJobs.company_id, j.company_id), eq(schema.seenJobs.job_key, j.job_key))).run();
          }
        });
        sent += usable.length;
        log.info({ channel: channel.name, count: usable.length, message_id: res.id, job_ids: usable.map((n) => n.job_id) }, 'sent jobs to discord');
      } else {
        for (const n of usable) {
          const attempts = n.attempts + 1;
          const giveUp = attempts >= MAX_ATTEMPTS;
          db.update(N)
            .set({ status: giveUp ? 'failed' : 'pending', attempts, last_error: res.error, next_attempt_at: ts + Math.min(30000 * 2 ** (attempts - 1), 3600000) })
            .where(eq(N.id, n.id))
            .run();
        }
        failed += usable.length;
        log.error({ channel: channel?.name ?? channelId, count: usable.length, error: res.error, status: res.status }, 'discord send failed; will retry');
      }
    }
  }
  return { sent, failed };
}

const ALERT_ICON = { error: '🔴', warn: '🟠', info: '🟢' };

/** Posts an alert to the alerts channel. Returns true when delivered. */
export async function sendAlertToDiscord({ kind, message, companyId, level = 'warn' }) {
  const d = getSettings('discord');
  const channel = channelById(d.alertsChannelId);
  if (!channel?.webhookUrl) return false;
  let company;
  if (companyId) company = getDb().select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
  const res = await postWebhook(channel.webhookUrl, {
    username: 'Earlybird alerts',
    embeds: [{ title: `${ALERT_ICON[level] || '🟠'} ${kind.replaceAll('_', ' ')}${company ? ` · ${company.name}` : ''}`.slice(0, 256), description: message.slice(0, 4000), color: level === 'error' ? 0xb42318 : level === 'info' ? 0x067647 : 0xb54708, timestamp: new Date().toISOString() }],
  });
  if (!res.ok) log.error({ kind, error: res.error }, 'failed to send alert');
  return !!res.ok;
}

export async function sendTestMessage(channelId) {
  const channel = channelById(channelId);
  if (!channel) throw Object.assign(new Error(`unknown channel ${channelId}`), { statusCode: 404 });
  const res = await postWebhook(channel.webhookUrl, { username: 'Earlybird', content: `✅ Earlybird test message for channel "${channel.name}"` });
  log.info({ channel: channel.name, ok: res.ok, error: res.error }, 'discord test message');
  if (!res.ok) throw Object.assign(new Error(res.error), { statusCode: 400 });
  return res;
}
