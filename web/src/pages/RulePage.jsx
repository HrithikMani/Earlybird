import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ActionButton, Badge, Card, ErrorBox, Json, fmtAgo } from '../components/ui.jsx';
import { RunsTable } from '../components/runs.jsx';
import { JobsTable } from '../components/jobs.jsx';

export default function RulePage({ params }) {
  const { data, error, reload } = useApi(`/api/rules/${params.id}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="empty">Loading…</p>;
  const { rule, company, versions, runs, verifications } = data;
  return (
    <div>
      <h1>
        Rule <span className="mono">{rule.id}</span> <Badge value={rule.slot} testId="rule-slot" />
      </h1>
      <Card
        actions={
          <div className="row">
            {rule.slot !== 'active' && <ActionButton onClick={async () => { await api.post(`/api/rules/${rule.id}/activate`); reload(); }} testId="rule-page-activate">Activate</ActionButton>}
            {rule.type === 'script' && !rule.approved_at && <ActionButton variant="primary" onClick={async () => { await api.post(`/api/rules/${rule.id}/approve`); reload(); }} testId="rule-approve">Approve & activate</ActionButton>}
            <ActionButton onClick={async () => { await api.post(`/api/rules/${rule.id}/verify`, { window: '1h' }); }} testId="rule-page-verify">Verify (1h)</ActionButton>
          </div>
        }
      >
        <table>
          <tbody>
            <tr><th>Company</th><td><a href={`#/companies/${company.id}`}>{company.name}</a></td></tr>
            <tr><th>Strategy</th><td>{rule.strategy} / {rule.type}</td></tr>
            <tr><th>Version</th><td>v{rule.version} of {rule.rule_key} · {versions.length} version(s)</td></tr>
            <tr><th>Created</th><td>{fmtAgo(rule.created_at)} by {rule.created_by}{rule.source_task_id && <> (task <a className="mono" href={`#/tasks/${rule.source_task_id}`}>{rule.source_task_id}</a>)</>}</td></tr>
            <tr><th>Score</th><td>{rule.score ? <Json value={rule.score} /> : '—'}</td></tr>
            {rule.notes && <tr><th>Notes</th><td>{rule.notes}</td></tr>}
          </tbody>
        </table>
      </Card>
      <Card title="Rule JSON"><Json value={rule.spec} testId="rule-page-json" /></Card>
      {rule.code && <Card title="Script code"><pre className="json" data-testid="rule-code-view">{rule.code}</pre></Card>}
      <Card title="Verifications" testId="rule-verifications">
        {verifications.length === 0 ? <p className="empty">Not verified yet.</p> : verifications.map((v) => (
          <div key={v.id} style={{ marginBottom: 8 }}>
            <Badge value={v.verdict} testId="verification-verdict" /> window {v.window} · {v.source} · {fmtAgo(v.created_at)} — {v.report?.notes}
            {v.report?.missing?.length > 0 && <div className="small">Missing: {v.report.missing.map((m) => m.title).join(', ')}</div>}
          </div>
        ))}
      </Card>
      <Card title="Runs"><RunsTable runs={runs} showRule={false} /></Card>
      <Card title="Jobs found by this rule"><JobsTable ruleId={rule.id} showCompany={false} /></Card>
    </div>
  );
}
