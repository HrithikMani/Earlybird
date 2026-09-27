import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from '../db/index.js';
import { getSettings } from '../settings/index.js';
import { childLogger } from '../log/logger.js';
import { config } from '../config.js';
import { now } from '../runtime.js';
import { runtime } from '../runtime.js';

const log = childLogger('scheduler');
const DAY = 86400000;

/** Deletes stale jobs and old runs/logs/events/artifacts per Settings → Retention. Seen jobs stay (dedupe memory). */
export function runCleanup() {
  const r = getSettings('retention');
  const db = getSqlite();
  const t = now();
  const res = {};
  db.transaction(() => {
    res.closedJobs = db.prepare('delete from jobs where closed_at is not null and closed_at < ?').run(t - r.closedJobDays * DAY).changes;
    res.oldJobs = db.prepare('delete from jobs where first_seen_at < ?').run(t - r.maxJobAgeDays * DAY).changes;
    res.seenJobs = db.prepare('delete from seen_jobs where last_seen_at < ?').run(t - r.seenJobDays * DAY).changes;
    res.notifications = db.prepare("delete from notifications where status in ('sent','failed') and created_at < ?").run(t - 30 * DAY).changes;
    res.runs = db.prepare("delete from runs where started_at < ? and status != 'running'").run(t - r.runDays * DAY).changes;
    res.logs = db.prepare('delete from logs where ts < ?').run(Date.now() - r.logDays * DAY).changes;
    res.taskEvents = db.prepare('delete from task_events where ts < ?').run(Date.now() - r.taskEventDays * DAY).changes;
  })();
  let artifacts = 0;
  try {
    for (const d of fs.readdirSync(config.paths.artifacts)) {
      const p = path.join(config.paths.artifacts, d);
      if (fs.statSync(p).mtimeMs < Date.now() - r.artifactDays * DAY) {
        fs.rmSync(p, { recursive: true, force: true });
        artifacts++;
      }
    }
  } catch {
    // no artifacts dir yet
  }
  res.artifacts = artifacts;
  if (new Date().getDay() === 0) db.exec('VACUUM');
  runtime.scheduler.lastCleanupAt = Date.now();
  log.info(res, 'cleanup finished');
  return res;
}
