import { navigate } from '../hooks.js';
import { Badge, Empty, fmtAgo } from './ui.jsx';

export function RunsTable({ runs, showRule = true }) {
  if (!runs?.length) return <Empty>No runs yet.</Empty>;
  return (
    <div className="table-wrap">
      <table data-testid="runs-table">
        <thead>
          <tr><th>Started</th><th>Status</th><th>Mode</th><th>Trigger</th>{showRule && <th>Rule</th>}<th>Jobs</th><th>New</th><th>Sent</th><th>Closed</th><th>Duration</th><th>Error</th></tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)} data-testid="run-row">
              <td>{fmtAgo(r.started_at)}</td>
              <td><Badge value={r.status} testId="run-status" /></td>
              <td>{r.mode}</td>
              <td>{r.trigger}</td>
              {showRule && <td className="mono small">{r.rule_id}</td>}
              <td>{r.job_count ?? '—'}</td>
              <td>{r.new_job_count ?? '—'}</td>
              <td>{r.notified_count ?? '—'}</td>
              <td>{r.closed_job_count ?? '—'}</td>
              <td>{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
              <td className="small" data-testid="run-error">{r.error_type ? <><strong>{r.error_type}</strong>: {r.error_message?.slice(0, 120)}</> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
