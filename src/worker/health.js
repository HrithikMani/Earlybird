import { raiseAlert, resolveAlerts } from '../store/alerts.js';
import { updateCompany } from '../store/companies.js';
import { getSettings } from '../settings/index.js';

const FAILURE_KINDS = ['failing', 'blocked', 'zero_jobs', 'job_drop', 'fallback_in_use'];

/**
 * Updates a company's health after a run and raises/resolves alerts (code only, no LLM).
 * Returns the patch applied.
 */
export async function updateHealthAfterRun(company, rule, { ok, error, jobCount, mode, onFallback }) {
  const scheduling = getSettings('scheduling');
  const patch = {};
  const name = company.name;

  if (!ok) {
    const failures = (company.consecutive_failures || 0) + 1;
    patch.consecutive_failures = failures;
    const type = error?.type;
    const status = error?.status;
    let failing = failures >= 3;
    let note = `${type || 'Error'}: ${error?.message || 'unknown error'}`;

    if (type === 'Blocked') {
      const base = company.interval_min || rule?.spec?.interval_min || scheduling.defaultIntervalMin;
      const next = Math.min(60, Math.max(base, (company.effective_interval_min || base) * 2));
      patch.effective_interval_min = next;
      patch.next_run_at = (company.last_run_at || Date.now()) + next * 60000;
      note = `Blocked (${status || 'captcha'}); interval raised to ${next} min`;
      await raiseAlert({ companyId: company.id, ruleId: rule?.id, kind: 'blocked', message: `${name}: ${error.message}. Backing off to every ${next} min.` });
    }
    if ((type === 'HttpError' && status === 404) || type === 'SelectorNotFound' || type === 'InvalidRule' || type === 'RobotsDisallowed') failing = true;

    if (failing) {
      patch.status = 'failing';
      const canFallback = company.fallback_rule_id && !company.using_fallback && !onFallback;
      if (canFallback) {
        patch.using_fallback = true;
        patch.next_run_at = null; // try the fallback right away
        note += ' → switching to fallback rule';
      }
      await raiseAlert({
        companyId: company.id,
        ruleId: rule?.id,
        kind: 'failing',
        level: 'error',
        message: `${name}: rule ${rule?.id} is failing (${note}).${canFallback ? ` Trying fallback rule ${company.fallback_rule_id}.` : ' Consider re-running discovery.'}`,
      });
    } else if (company.status === 'active') {
      patch.status = 'degraded';
    }
    patch.health_note = note;
    updateCompany(company.id, patch);
    return patch;
  }

  // Successful run.
  patch.consecutive_failures = 0;
  patch.last_success_at = Date.now();
  patch.effective_interval_min = null;
  let status = 'active';
  let note = null;
  const prev = company.last_job_count;

  if (jobCount === 0 && (prev ?? 0) > 0) {
    patch.consecutive_zero_runs = (company.consecutive_zero_runs || 0) + 1;
    if (patch.consecutive_zero_runs >= 2) {
      status = 'degraded';
      note = `0 jobs in ${patch.consecutive_zero_runs} consecutive runs (previously ${prev})`;
      await raiseAlert({ companyId: company.id, ruleId: rule?.id, kind: 'zero_jobs', message: `${name}: ${note}. The portal may have changed.` });
    }
  } else {
    patch.consecutive_zero_runs = 0;
    if (jobCount > 0 || prev === null || prev === undefined) patch.last_job_count = jobCount;
  }
  if (mode === 'full') {
    const prevFull = company.last_full_job_count;
    if (prevFull && jobCount < prevFull * 0.2 && jobCount > 0) {
      status = 'degraded';
      note = `job count dropped ${prevFull} → ${jobCount} (−${Math.round((1 - jobCount / prevFull) * 100)}%)`;
      await raiseAlert({ companyId: company.id, ruleId: rule?.id, kind: 'job_drop', message: `${name}: ${note}.` });
    }
    patch.last_full_job_count = jobCount;
  }

  if (onFallback) {
    note = note || `running on fallback rule ${rule.id}`;
    await raiseAlert({ companyId: company.id, ruleId: rule.id, kind: 'fallback_in_use', message: `${name}: the active rule failed, the fallback rule ${rule.id} works. Promote it or re-run discovery.` });
  }

  patch.status = status;
  patch.health_note = note;
  const wasUnhealthy = ['failing', 'degraded'].includes(company.status);
  if (status === 'active') {
    const kinds = onFallback ? FAILURE_KINDS.filter((k) => k !== 'fallback_in_use') : FAILURE_KINDS;
    await resolveAlerts(company.id, kinds, { announce: wasUnhealthy ? `${name} is healthy again (rule ${rule.id}).` : undefined });
  }
  updateCompany(company.id, patch);
  return patch;
}
