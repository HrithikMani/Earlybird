import { useApi } from '../hooks.js';
import { Badge, Card, ErrorBox, Json, fmtTime } from '../components/ui.jsx';
import { LogLine } from './Logs.jsx';

function artifactUrl(runId, file) {
  const name = file.split(/[\\/]/).pop();
  return `/api/artifacts/${runId}/${encodeURIComponent(name)}`;
}

export default function RunDetail({ params }) {
  const { data, error } = useApi(`/api/runs/${params.id}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="empty">Loading…</p>;
  const { run, logs, company } = data;
  const detail = run.error_detail || {};
  const artifacts = run.artifacts || detail.detail?.artifacts;
  return (
    <div>
      <h1>
        Run <span className="mono">{run.id}</span> <Badge value={run.status} testId="run-detail-status" />
      </h1>
      <Card>
        <table>
          <tbody>
            <tr><th>Company</th><td><a href={`#/companies/${company?.id}`}>{company?.name}</a></td></tr>
            <tr><th>Rule</th><td><a className="mono" href={`#/rules/${run.rule_id}`}>{run.rule_id}</a></td></tr>
            <tr><th>Mode / trigger</th><td>{run.mode} / {run.trigger}</td></tr>
            <tr><th>Started</th><td>{fmtTime(run.started_at)} · {run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(2)}s` : 'running'}</td></tr>
            <tr><th>Result</th><td>{run.job_count ?? '—'} jobs · {run.new_job_count ?? '—'} new · {run.notified_count ?? '—'} queued for Discord · {run.closed_job_count ?? '—'} closed</td></tr>
            {run.http_status && <tr><th>HTTP status</th><td>{run.http_status}</td></tr>}
          </tbody>
        </table>
      </Card>
      {run.error_type && (
        <Card title={`Error: ${run.error_type}`} testId="run-error-card">
          <p data-testid="run-error-message">{run.error_message}</p>
          {detail.detail?.action && (
            <p>Failed at browser action <strong>#{detail.detail.action_index} {detail.detail.action.do}</strong> {detail.detail.action.selector && <code>{detail.detail.action.selector}</code>} on {detail.detail.page_url}</p>
          )}
          {detail.detail?.body_snippet && (
            <>
              <h3>Response ({detail.detail.status}) from {detail.detail.url}</h3>
              <pre className="json">{detail.detail.body_snippet}</pre>
            </>
          )}
          <details>
            <summary>Full error detail</summary>
            <Json value={detail} testId="run-error-detail" />
          </details>
        </Card>
      )}
      {artifacts && (
        <Card title="Artifacts" testId="run-artifacts">
          {artifacts.screenshot && <img src={artifactUrl(run.id, artifacts.screenshot)} alt="screenshot at failure" style={{ maxWidth: '100%', border: '1px solid var(--border)' }} data-testid="run-screenshot" />}
          <div className="row">
            {artifacts.html && <a href={artifactUrl(run.id, artifacts.html)} target="_blank" rel="noreferrer">Page HTML</a>}
            {artifacts.trace && <a href={artifactUrl(run.id, artifacts.trace)}>Playwright trace</a>}
          </div>
        </Card>
      )}
      {run.stats && (
        <Card title="Stats">
          <Json value={run.stats} testId="run-stats" />
        </Card>
      )}
      <Card title="Logs" testId="run-logs">
        {logs.length === 0 ? <p className="empty">No logs stored for this run.</p> : logs.map((l) => <LogLine key={l.id} e={l} />)}
      </Card>
    </div>
  );
}
