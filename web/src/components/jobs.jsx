import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ActionButton, Badge, Empty, Json, fmtAgo, fmtTime } from './ui.jsx';

function JobDetail({ id, onClose }) {
  const { data } = useApi(`/api/jobs/${id}`);
  if (!data) return null;
  const { job, seen, notifications } = data;
  return (
    <tr>
      <td colSpan={8}>
        <div className="card" data-testid="job-detail">
          <div className="spread">
            <strong>{job.title}</strong>
            <div className="row">
              <ActionButton onClick={async () => { await api.post(`/api/jobs/${job.id}/resend`); }} testId="job-resend">Resend to Discord</ActionButton>
              <button className="btn small" onClick={onClose}>Close</button>
            </div>
          </div>
          <table>
            <tbody>
              <tr><th>URL</th><td><a href={job.url} target="_blank" rel="noreferrer">{job.url}</a><div className="muted small mono">{job.canonical_url}</div></td></tr>
              <tr><th>Job key</th><td className="mono">{job.job_key}{job.external_id ? ` (portal id ${job.external_id})` : ''}</td></tr>
              <tr><th>Posted</th><td>{job.posted_at ? fmtTime(job.posted_at) : '—'} <span className="muted">raw: {job.posted_at_raw || '—'}</span></td></tr>
              <tr><th>Seen</th><td>first {fmtTime(job.first_seen_at)} · last {fmtTime(job.last_seen_at)} · {job.seen_count}× {seen?.first_seen_at && seen.first_seen_at < job.first_seen_at ? `(remembered since ${fmtTime(seen.first_seen_at)})` : ''}</td></tr>
              <tr><th>Found by</th><td className="mono">{job.rule_id} {job.search_term ? `· search "${job.search_term}"` : ''}</td></tr>
              <tr><th>Notify</th><td><Badge value={job.notify_status} /> {job.notify_skip_reason && <span className="muted">{job.notify_skip_reason.replaceAll('_', ' ')}</span>}</td></tr>
              <tr>
                <th>Discord</th>
                <td>
                  {notifications.length === 0 && <span className="muted">never queued</span>}
                  {notifications.map((n) => (
                    <div key={n.id} className="small">
                      <Badge value={n.status} /> {n.kind} → {n.channel_id} {n.sent_at ? `at ${fmtTime(n.sent_at)}` : ''} {n.discord_message_id ? `· message ${n.discord_message_id}` : ''} {n.last_error && <span className="inline-error">{n.last_error}</span>}
                    </div>
                  ))}
                </td>
              </tr>
            </tbody>
          </table>
          {seen?.aliases && <Json value={{ aliases: JSON.parse(seen.aliases) }} />}
        </div>
      </td>
    </tr>
  );
}

const REASONS = ['', 'already_seen', 'baseline', 'role_mismatch', 'filtered', 'too_old', 'no_channel'];

export function JobsTable({ companyId, ruleId, showCompany = true }) {
  const [f, setF] = useState({ q: '', status: 'open', notify_status: '', skip_reason: '' });
  const [open, setOpen] = useState(null);
  const qs = useMemo(() => {
    const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    if (companyId) p.set('company_id', companyId);
    if (ruleId) p.set('rule_id', ruleId);
    p.set('limit', '200');
    return p.toString();
  }, [f, companyId, ruleId]);
  const { data } = useApi(`/api/jobs?${qs}`, { intervalMs: 15000 });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input placeholder="search title, location, company" value={f.q} onChange={set('q')} data-testid="jobs-search" />
        <select value={f.status} onChange={set('status')} data-testid="jobs-status">
          <option value="">open + closed</option>
          <option value="open">open</option>
          <option value="closed">closed</option>
        </select>
        <select value={f.notify_status} onChange={set('notify_status')} data-testid="jobs-notify-status">
          <option value="">any notify status</option>
          <option value="sent">sent</option>
          <option value="pending">pending</option>
          <option value="skipped">skipped</option>
        </select>
        <select value={f.skip_reason} onChange={set('skip_reason')} data-testid="jobs-skip-reason">
          {REASONS.map((r) => <option key={r} value={r}>{r ? r.replaceAll('_', ' ') : 'any skip reason'}</option>)}
        </select>
      </div>
      <div className="table-wrap">
        <table data-testid="jobs-table">
          <thead>
            <tr><th>Title</th>{showCompany && <th>Company</th>}<th>Roles</th><th>Location</th><th>Posted</th><th>First seen</th><th>Discord</th><th></th></tr>
          </thead>
          <tbody>
            {(data?.items || []).map((j) => [
              <tr key={j.id} className="clickable" onClick={() => setOpen(open === j.id ? null : j.id)} data-testid="job-row">
                <td><a href={j.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{j.title}</a>{j.closed_at && <> <Badge value="closed" /></>}</td>
                {showCompany && <td>{j.company_name}</td>}
                <td><div className="chips">{j.matched_roles.map((r) => <span className="chip" key={r}>{r}</span>)}</div></td>
                <td>{j.location}</td>
                <td>{j.posted_at ? fmtAgo(j.posted_at) : <span className="muted">{j.posted_at_raw || '—'}</span>}</td>
                <td>{fmtAgo(j.first_seen_at)}</td>
                <td><Badge value={j.notify_status} testId="job-notify-status" />{j.notify_skip_reason && <div className="muted small" data-testid="job-skip-reason">{j.notify_skip_reason.replaceAll('_', ' ')}</div>}</td>
                <td className="muted small">{j.seen_count}×</td>
              </tr>,
              open === j.id && <JobDetail key={`${j.id}-d`} id={j.id} onClose={() => setOpen(null)} />,
            ])}
          </tbody>
        </table>
        {data && data.items.length === 0 && <Empty>No jobs match.</Empty>}
      </div>
    </div>
  );
}
