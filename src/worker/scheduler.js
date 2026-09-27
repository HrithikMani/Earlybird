import { Cron } from 'croner';
import pLimit from 'p-limit';
import { and, inArray, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getSettings, settingsEvents } from '../settings/index.js';
import { childLogger, errorDetail } from '../log/logger.js';
import { config } from '../config.js';
import { runtime, now } from '../runtime.js';
import { intervalMinFor, isDue, updateCompany } from '../store/companies.js';
import { currentRuleFor } from '../store/rules.js';
import { executeRun } from './scrape.js';
import { drainOutbox } from '../notify/discord.js';
import { runCleanup } from './cleanup.js';

const log = childLogger('scheduler');
const jobs = [];
const pools = {};
const extraTicks = []; // other services (task queue) hook into the cron here
let ticking = null;

function makePools() {
  const s = getSettings('scheduling');
  pools.api = pLimit(s.apiPool);
  pools.browser = pLimit(s.browserPool);
  runtime.pools.api.limit = s.apiPool;
  runtime.pools.browser.limit = s.browserPool;
}

function syncPoolStats() {
  for (const k of ['api', 'browser']) {
    if (!pools[k]) continue;
    runtime.pools[k].active = pools[k].activeCount;
    runtime.pools[k].pending = pools[k].pendingCount;
  }
}

export function poolFor(rule) {
  const browser = rule.type === 'browser' || (rule.type === 'script' && rule.spec?.uses_browser);
  return browser ? pools.browser : pools.api;
}

/** Runs a company now through the right pool (used by "Run now"). */
export function runNow(companyId, opts = {}) {
  const company = getDb().select().from(schema.companies).all().find((c) => c.id === companyId);
  const rule = company && currentRuleFor(company);
  const pool = rule ? poolFor(rule) : pools.api;
  return pool(async () => {
    syncPoolStats();
    try {
      return await executeRun(companyId, { trigger: 'manual', ...opts });
    } finally {
      syncPoolStats();
    }
  });
}

/** One scheduler tick: start every due company. In test mode, waits for the runs to finish. */
export async function tick() {
  if (ticking) return ticking;
  ticking = (async () => {
    const started = Date.now();
    const s = getSettings('scheduling');
    const companies = getDb()
      .select()
      .from(schema.companies)
      .where(and(inArray(schema.companies.status, ['active', 'degraded', 'failing']), isNotNull(schema.companies.active_rule_id)))
      .all();
    const t = now();
    const due = companies.filter((c) => isDue(c, t));
    runtime.scheduler.dueBacklog = due.length;
    const started_runs = [];
    for (const c of due) {
      const rule = currentRuleFor(c);
      if (!rule) continue;
      const intervalMs = intervalMinFor(c, rule, s) * 60000;
      const jitter = config.isTest ? 0 : Math.floor(Math.random() * s.jitterSec * 1000);
      updateCompany(c.id, { next_run_at: t + intervalMs + jitter });
      const pool = poolFor(rule);
      const p = new Promise((resolve) => setTimeout(resolve, jitter)).then(() =>
        pool(async () => {
          syncPoolStats();
          try {
            if (runtime.shuttingDown) return null;
            return await executeRun(c.id, { trigger: 'schedule' });
          } catch (err) {
            log.error({ err: errorDetail(err), company_id: c.id }, 'scheduled run crashed');
            return null;
          } finally {
            syncPoolStats();
          }
        }),
      );
      started_runs.push(p);
    }
    for (const fn of extraTicks) {
      try {
        await fn();
      } catch (err) {
        log.error({ err: errorDetail(err) }, 'tick hook failed');
      }
    }
    runtime.scheduler.lastTickAt = now();
    runtime.scheduler.lastTickDurationMs = Date.now() - started;
    if (due.length) log.debug({ due: due.length }, 'scheduler tick');
    if (config.isTest) {
      const runs = await Promise.all(started_runs);
      await drainOutbox();
      return { ran: runs.filter(Boolean).length, runs: runs.filter(Boolean).map((r) => ({ id: r.id, status: r.status, company_id: r.company_id })) };
    }
    Promise.all(started_runs).then(() => drainOutbox()).catch(() => {});
    return { ran: due.length };
  })().finally(() => {
    ticking = null;
  });
  return ticking;
}

export function onTick(fn) {
  extraTicks.push(fn);
}

function schedule() {
  for (const j of jobs.splice(0)) j.stop();
  const s = getSettings('scheduling');
  // In test mode the harness drives ticks explicitly (/api/test/tick).
  if (config.isTest && process.env.EARLYBIRD_TEST_CRON !== '1') return;
  const safe = (name, fn) => async () => {
    try {
      await fn();
    } catch (err) {
      log.error({ err: errorDetail(err), job: name }, `${name} failed`);
    }
  };
  jobs.push(new Cron(s.scrapeCron, { protect: true, name: 'scrape' }, safe('scrape tick', tick)));
  jobs.push(new Cron('*/15 * * * * *', { protect: true, name: 'outbox' }, safe('outbox', drainOutbox)));
  jobs.push(new Cron(s.cleanupCron, { protect: true, name: 'cleanup' }, safe('cleanup', runCleanup)));
  log.info({ scrape: s.scrapeCron, cleanup: s.cleanupCron }, 'cron jobs scheduled');
}

export function startScheduler() {
  makePools();
  runtime.scheduler.running = true;
  runtime.scheduler.lastTickAt = now();
  schedule();
  settingsEvents.on('change', ({ section }) => {
    if (section === 'scheduling') {
      makePools();
      schedule();
    }
  });
}

export function stopScheduler() {
  for (const j of jobs.splice(0)) j.stop();
  runtime.scheduler.running = false;
}
