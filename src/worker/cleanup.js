import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from '../db/index.js';
import { getSettings } from '../settings/index.js';
import { childLogger } from '../log/logger.js';
import { config } from '../config.js';
import { now } from '../runtime.js';
import { runtime } from '../runtime.js';
import { inWantedLocation, wantedLocations } from '../roles/match.js';

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
    res.oldJobs = db.prepare('delete from jobs where first_seen_at < ?').run(t - r.keepJobsDays * DAY).changes;
    // Listings that aged out of the "posted within N days" preference (global, or the company's override).
    const globalDays = getSettings('filters').maxJobAgeDays;
    const del = db.prepare('delete from jobs where company_id = ? and posted_at is not null and posted_at < ?');
    res.agedOut = 0;
    // Keep only each company's newest N listings (Settings → Filters → max jobs per company).
    const maxJobs = getSettings('filters').maxJobsPerCompany;
    const trim = db.prepare(`delete from jobs where company_id = ? and id not in (
      select id from jobs where company_id = ? order by coalesce(posted_at, first_seen_at) desc limit ?)`);
    res.trimmed = 0;
    res.otherLocation = 0;
    const delJob = db.prepare('delete from jobs where id = ?');
    for (const c of db.prepare('select id, notify_filters, source_filters from companies').all()) {
      const company = { ...c, notify_filters: JSON.parse(c.notify_filters || 'null'), source_filters: JSON.parse(c.source_filters || 'null') };
      const days = company.notify_filters?.maxJobAgeDays ?? globalDays;
      res.agedOut += del.run(c.id, t - days * DAY).changes;
      // Listings outside the company's wanted locations (e.g. left over from an older, worldwide rule).
      const wanted = wantedLocations(company, getSettings('filters'));
      if (wanted.length) {
        for (const j of db.prepare('select id, location from jobs where company_id = ? and location is not null').all(c.id)) {
          if (!inWantedLocation(j, wanted)) res.otherLocation += delJob.run(j.id).changes;
        }
      }
      res.trimmed += trim.run(c.id, c.id, maxJobs).changes;
    }
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
