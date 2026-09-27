import { getSqlite, newId } from '../db/index.js';
import { getSettings } from '../settings/index.js';
import { matchRoles, filterReason, inWantedLocation, wantedLocations } from '../roles/match.js';
import { jobKeys } from './dedupe.js';
import { now } from '../runtime.js';

/**
 * Stores a run's jobs and decides which are new + notifiable, in ONE transaction:
 * insert/refresh listings, upsert seen_jobs, queue notifications (outbox), close missing jobs on full sweeps.
 * See CLAUDE.md "Seen jobs".
 */
export function ingestJobs({ company, rule, jobs, mode, baseline, queries = [''], capped = false, roles = [] }) {
  const db = getSqlite();
  const t = now();
  const dedupe = getSettings('dedupe');
  const globalFilters = getSettings('filters');
  const filters = { ...globalFilters, ...(company.notify_filters || {}) };
  const channelId = company.discord_channel_id || getSettings('discord').jobsChannelId;
  // User preference: only jobs posted within N days matter (per-company override in notify_filters).
  const cutoff = t - (filters.maxJobAgeDays ?? globalFilters.maxJobAgeDays) * 86400000;
  const wanted = wantedLocations(company, globalFilters);
  const renotifyMs = dedupe.renotifyRepostedAfterDays ? dedupe.renotifyRepostedAfterDays * 86400000 : null;

  const baselinedTerms = new Set(db.prepare('select term from company_terms where company_id = ?').all(company.id).map((r) => r.term.toLowerCase()));
  const termNotifyExisting = new Map();
  for (const r of roles) for (const term of r.search_terms?.length ? r.search_terms : [r.name]) termNotifyExisting.set(term.toLowerCase(), !!r.notify_existing);

  const q = {
    listingByKey: db.prepare('select * from jobs where company_id = ? and job_key = ?'),
    deleteListing: db.prepare('delete from jobs where id = ?'),
    listingByAlt: db.prepare('select * from jobs where company_id = ? and (canonical_url = ? or fingerprint = ?) limit 10'),
    seenByKey: db.prepare('select * from seen_jobs where company_id = ? and job_key = ?'),
    seenByAlt: db.prepare('select * from seen_jobs where company_id = ? and (canonical_url = ? or fingerprint = ?) order by first_seen_at limit 10'),
    refresh: db.prepare(`update jobs set last_seen_at = ?, seen_count = seen_count + 1, missing_sweeps = 0, closed_at = null, rule_id = ?,
      title = ?, url = ?, canonical_url = ?, location = ?, department = ?, posted_at = coalesce(?, posted_at), posted_at_raw = coalesce(?, posted_at_raw), matched_roles = ? where id = ?`),
    insertJob: db.prepare(`insert into jobs (id, company_id, rule_id, job_key, external_id, canonical_url, fingerprint, title, url, location, department, posted_at, posted_at_raw,
      matched_roles, search_term, first_seen_at, last_seen_at, seen_count, missing_sweeps, closed_at, notify_status, notify_skip_reason)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, null, ?, ?)`),
    insertSeen: db.prepare(`insert into seen_jobs (company_id, job_key, external_id, canonical_url, fingerprint, aliases, title, first_seen_at, last_seen_at, first_rule_id, notified_at, posted_at)
      values (?, ?, ?, ?, ?, null, ?, ?, ?, ?, null, ?)`),
    touchSeen: db.prepare('update seen_jobs set last_seen_at = ?, posted_at = coalesce(?, posted_at) where company_id = ? and job_key = ?'),
    aliasSeen: db.prepare('update seen_jobs set aliases = ?, last_seen_at = ? where company_id = ? and job_key = ?'),
    insertNotif: db.prepare(`insert or ignore into notifications (id, company_id, job_key, job_id, channel_id, kind, status, attempts, created_at)
      values (?, ?, ?, ?, ?, 'job', 'pending', 0, ?)`),
    insertTerm: db.prepare('insert or ignore into company_terms (company_id, term, baselined_at) values (?, ?, ?)'),
  };

  const stats = { fetched: jobs.length, new: 0, already_seen: 0, refreshed: 0, reopened: 0, rekeyed: 0, queued: 0, skipped: {}, closed: 0 };
  const skip = (reason) => (stats.skipped[reason] = (stats.skipped[reason] || 0) + 1);

  // A URL match is always the same job. A title+location fingerprint match only counts when ids can't tell them
  // apart (either side has no id) or the id scheme may have changed (it was recorded by a different rule).
  const pickAlt = (rows, keys, job, ruleOf) =>
    rows.find((r) => r.canonical_url === keys.canonical_url) ||
    rows.find((r) => r.fingerprint === keys.fingerprint && (!job.external_id || !r.external_id || ruleOf(r) !== rule.id));

  db.transaction(() => {
    const seenThisRun = new Set();
    for (const job of jobs) {
      const keys = jobKeys(job, company.id, dedupe.trackingParams);
      if (seenThisRun.has(keys.job_key)) continue;
      seenThisRun.add(keys.job_key);
      // Older than the user's window, or outside the wanted locations: remember it (so it can never count as new)
      // but don't list or send it.
      const tooOld = job.posted_at && job.posted_at < cutoff;
      if (tooOld || !inWantedLocation(job, wanted)) {
        const old = q.listingByKey.get(company.id, keys.job_key);
        if (old) q.deleteListing.run(old.id);
        const seenOld = q.seenByKey.get(company.id, keys.job_key);
        if (seenOld) q.touchSeen.run(t, job.posted_at ?? null, company.id, keys.job_key);
        else q.insertSeen.run(company.id, keys.job_key, job.external_id ?? null, keys.canonical_url, keys.fingerprint, job.title, t, t, rule.id, job.posted_at ?? null);
        skip(tooOld ? 'too_old' : 'other_location');
        continue;
      }
      const matched = matchRoles(job.title, roles);
      const matchedJson = JSON.stringify(matched);

      // 1. Already a current listing? Refresh it.
      const listing = q.listingByKey.get(company.id, keys.job_key) || pickAlt(q.listingByAlt.all(company.id, keys.canonical_url, keys.fingerprint), keys, job, (r) => r.rule_id);
      if (listing) {
        if (listing.closed_at) stats.reopened++;
        if (listing.job_key !== keys.job_key) stats.rekeyed++;
        q.refresh.run(t, rule.id, job.title, job.url, keys.canonical_url, job.location ?? null, job.department ?? null, job.posted_at ?? null, job.posted_at_raw ?? null, matchedJson, listing.id);
        q.touchSeen.run(t, job.posted_at ?? null, company.id, listing.job_key);
        stats.refreshed++;
        continue;
      }

      // 2. Seen before (by any key)?
      let seen = q.seenByKey.get(company.id, keys.job_key);
      if (!seen) {
        seen = pickAlt(q.seenByAlt.all(company.id, keys.canonical_url, keys.fingerprint), keys, job, (r) => r.first_rule_id);
        if (seen) {
          const aliases = new Set(JSON.parse(seen.aliases || '[]'));
          aliases.add(keys.job_key);
          q.aliasSeen.run(JSON.stringify([...aliases]), t, company.id, seen.job_key);
          stats.rekeyed++;
        }
      }
      const repost = seen && renotifyMs && seen.last_seen_at < t - renotifyMs;
      const jobKey = seen ? seen.job_key : keys.job_key;

      // 3. Decide whether to notify.
      let reason = null;
      if (seen && !repost) reason = 'already_seen';
      else if (baseline) reason = 'baseline';
      else if (job.search_term && !baselinedTerms.has(job.search_term.toLowerCase()) && !termNotifyExisting.get(job.search_term.toLowerCase())) reason = 'baseline';
      else if (company.role_mode !== 'all_jobs' && roles.length > 0 && matched.length === 0) reason = 'role_mismatch';
      else if (filterReason(job, filters)) reason = 'filtered';
      else if (!channelId) reason = 'no_channel';

      const jobId = newId('job');
      q.insertJob.run(jobId, company.id, rule.id, jobKey, job.external_id ?? null, keys.canonical_url, keys.fingerprint, job.title, job.url, job.location ?? null, job.department ?? null,
        job.posted_at ?? null, job.posted_at_raw ?? null, matchedJson, job.search_term ?? null, t, t, reason ? 'skipped' : 'pending', reason);
      if (seen) {
        q.touchSeen.run(t, job.posted_at ?? null, company.id, seen.job_key);
        stats.already_seen++;
      } else {
        q.insertSeen.run(company.id, jobKey, job.external_id ?? null, keys.canonical_url, keys.fingerprint, job.title, t, t, rule.id, job.posted_at ?? null);
        stats.new++;
      }
      if (reason) skip(reason);
      else {
        q.insertNotif.run(newId('ntf'), company.id, jobKey, jobId, channelId, t);
        stats.queued++;
      }
    }

    // 4. Remember which search terms have had their silent baseline.
    for (const term of queries) if (term) q.insertTerm.run(company.id, term, t);

    // 5. A baseline for a new rule replaces the listing: anything the new rule did not return came from an older
    //    rule or configuration (e.g. worldwide jobs before a US-only rule). They stay in seen_jobs, so never re-sent.
    if (baseline && jobs.length > 0) {
      stats.removed_old_rule = db.prepare('delete from jobs where company_id = ? and last_seen_at < ?').run(company.id, t).changes;
    }

    // 6. Full sweeps close listings that disappeared (2 consecutive misses).
    if (mode === 'full' && jobs.length > 0 && !capped) {
      const all = queries.includes('');
      const lower = new Set(queries.filter(Boolean).map((x) => x.toLowerCase()));
      const missing = db.prepare('select id, search_term, missing_sweeps from jobs where company_id = ? and closed_at is null and last_seen_at < ?').all(company.id, t);
      const upd = db.prepare('update jobs set missing_sweeps = ?, closed_at = ? where id = ?');
      for (const m of missing) {
        if (!all && m.search_term && !lower.has(m.search_term.toLowerCase())) continue;
        const n = m.missing_sweeps + 1;
        const close = n >= 2;
        upd.run(n, close ? t : null, m.id);
        if (close) stats.closed++;
      }
    }
  })();
  return stats;
}
