import { useState } from 'react';
import { api } from '../api.js';
import { navigate, useApi, useRoute } from '../hooks.js';
import { ActionButton, Badge, Card, Empty, ErrorBox, Json, Tabs, fmtAgo, fmtElapsed, fmtTime, taskDuration } from '../components/ui.jsx';
import { RoleTable } from '../components/roles.jsx';
import { RunsTable } from '../components/runs.jsx';
import { JobsTable } from '../components/jobs.jsx';
import { RuleEditor } from '../components/rule-editor.jsx';
import { TasksTable } from '../components/tasks.jsx';

const TABS = ['overview', 'roles', 'rules', 'runs', 'jobs', 'tasks'];

function ScoreLine({ score }) {
  if (!score) return null;
  const parts = ['freshness', 'completeness', 'relevance', 'stability', 'cost'].filter((k) => score[k] !== null && score[k] !== undefined).map((k) => `${k} ${score[k].toFixed(2)}`);
  return <span className="muted small">score {score.total?.toFixed(2)} ({parts.join(' · ')})</span>;
}

function LocationEditor({ company, onSaved }) {
  const [value, setValue] = useState(company.source_filters?.location || '');
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <label className="field" style={{ margin: 0, flex: 1, minWidth: 260 }}>
        <span>Location: used as the portal filter, and only jobs here are kept and sent ("United States" also matches USA, US and state codes)</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="United States" data-testid="company-location-edit" />
      </label>
      <ActionButton
        onClick={async () => {
          await api.put(`/api/companies/${company.id}`, { source_filters: { ...(company.source_filters || {}), location: value.trim() || undefined } });
          await api.post('/api/maintenance/cleanup');
          onSaved();
        }}
        testId="company-location-save"
      >
        Save location
      </ActionButton>
    </div>
  );
}

function AgeEditor({ company, onSaved }) {
  const [value, setValue] = useState(company.notify_filters?.maxJobAgeDays ?? '');
  return (
    <div className="row">
      <input type="number" min="1" style={{ width: 90 }} value={value} onChange={(e) => setValue(e.target.value)} placeholder="global" data-testid="company-age-edit" /> days
      <ActionButton
        onClick={async () => {
          const nf = { ...(company.notify_filters || {}) };
          if (value === '' || value === null) delete nf.maxJobAgeDays;
          else nf.maxJobAgeDays = Number(value);
          await api.put(`/api/companies/${company.id}`, { notify_filters: nf });
          await api.post('/api/maintenance/cleanup');
          onSaved();
        }}
        testId="company-age-save"
      >
        Save
      </ActionButton>
    </div>
  );
}

function RuleCard({ title, rule, actions, testId }) {
  if (!rule) return null;
  return (
    <Card title={title} actions={actions} testId={testId}>
      <p>
        <a className="mono" href={`#/rules/${rule.id}`}>{rule.id}</a> · {rule.strategy}/{rule.type} · v{rule.version} · by {rule.created_by} · {fmtAgo(rule.created_at)} <ScoreLine score={rule.score} />
        {rule.type === 'script' && !rule.approved_at && <> · <Badge value="needs_review" /> not approved</>}
      </p>
      <Json value={rule.spec} testId={`${testId}-json`} />
    </Card>
  );
}

function Overview({ d }) {
  const c = d.company;
  const lastDiscovery = d.tasks.find((t) => t.kind === 'discovery');
  return (
    <>
      <Card title="Status">
        <table>
          <tbody>
            <tr><th>Status</th><td><Badge value={c.status} testId="company-detail-status" /> {c.using_fallback && <span data-testid="company-on-fallback">running on fallback rule</span>} <span className="muted">{c.health_note}</span></td></tr>
            <tr><th>Careers URL</th><td><a href={c.careers_url} target="_blank" rel="noreferrer">{c.careers_url}</a></td></tr>
            <tr><th>Active rule</th><td>{c.rule ? <a className="mono" href={`#/rules/${c.rule.id}`}>{c.rule.id}</a> : '—'} {c.rule && `· ${c.rule.strategy}/${c.rule.type} v${c.rule.version}`}</td></tr>
            <tr><th>Roles</th><td><div className="chips">{d.effective_roles.map((r) => <span className="chip" key={r.id}>{r.name}{r.scope === 'company' ? ' ★' : ''}</span>)}</div>{c.role_mode === 'all_jobs' && 'all jobs (no role filter)'}</td></tr>
            <tr><th>Last run / success</th><td>{fmtAgo(c.last_run_at)} / {fmtAgo(c.last_success_at)}</td></tr>
            <tr><th>Last full sweep</th><td>{fmtAgo(c.last_full_sweep_at)}</td></tr>
            <tr><th>Next run</th><td>{c.next_run_at ? fmtTime(c.next_run_at) : '—'}</td></tr>
            <tr><th>Open jobs</th><td>{c.open_jobs}</td></tr>
            {lastDiscovery && (
              <tr>
                <th>Last discovery</th>
                <td data-testid="last-discovery">
                  <a href={`#/tasks/${lastDiscovery.id}`}><Badge value={lastDiscovery.status} /></a> {fmtAgo(lastDiscovery.created_at)} · took {fmtElapsed(taskDuration(lastDiscovery))} · {lastDiscovery.steps} steps · ${(lastDiscovery.cost_usd || 0).toFixed(2)} · {lastDiscovery.model}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {d.alerts.length > 0 && (
        <Card title="Alerts" testId="company-alerts">
          {d.alerts.map((a) => (
            <div key={a.id} className="small" style={{ marginBottom: 4 }}>
              <Badge value={a.state} /> <strong>{a.kind.replaceAll('_', ' ')}</strong> {a.message} <span className="muted">{fmtAgo(a.created_at)}</span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

function RulesTab({ d, reload }) {
  const c = d.company;
  const [editing, setEditing] = useState(!d.active_rule);
  const others = d.rules.filter((r) => r.id !== c.active_rule_id && r.id !== c.fallback_rule_id);
  return (
    <>
      <RuleCard title="Active rule" rule={d.active_rule} testId="active-rule" actions={<button className="btn small" onClick={() => setEditing(!editing)} data-testid="rule-edit-toggle">{editing ? 'Close editor' : 'Edit (new version)'}</button>} />
      {!d.active_rule && <Card title="No active rule"><p className="muted">Paste a rule below, or run discovery to have the AI build one.</p></Card>}
      <RuleCard
        title="Fallback rule"
        rule={d.fallback_rule}
        testId="fallback-rule"
        actions={<ActionButton onClick={async () => { await api.post(`/api/rules/${c.fallback_rule_id}/activate`, { keepOldAsFallback: true }); reload(); }} testId="promote-fallback">Promote to active</ActionButton>}
      />
      {editing && (
        <Card title="Rule editor">
          <RuleEditor companyId={c.id} initial={d.active_rule?.spec} initialCode={d.active_rule?.code} onSaved={() => reload()} />
        </Card>
      )}
      <Card title="All versions & candidates" actions={<ActionButton confirm="roll back" onClick={async () => { await api.post(`/api/companies/${c.id}/rollback`); reload(); }} testId="rule-rollback">Roll back</ActionButton>}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Rule</th><th>Slot</th><th>Strategy</th><th>Version</th><th>Created</th><th>Score</th><th></th></tr></thead>
            <tbody>
              {d.rules.map((r) => (
                <tr key={r.id} data-testid={`rule-row-${r.id}`}>
                  <td><a className="mono" href={`#/rules/${r.id}`}>{r.id}</a></td>
                  <td><Badge value={r.slot} /></td>
                  <td>{r.strategy}/{r.type}</td>
                  <td>v{r.version}</td>
                  <td>{fmtAgo(r.created_at)} · {r.created_by}</td>
                  <td>{r.score?.total?.toFixed(2) ?? '—'}</td>
                  <td>
                    {others.includes(r) && (
                      <div className="row">
                        <ActionButton variant="small" onClick={async () => { await api.post(`/api/rules/${r.id}/activate`); reload(); }} testId={`activate-${r.id}`}>Activate</ActionButton>
                        <ActionButton variant="small" onClick={async () => { await api.post(`/api/rules/${r.id}/fallback`); reload(); }}>Set fallback</ActionButton>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.rules.length === 0 && <Empty>No rules yet.</Empty>}
        </div>
      </Card>
    </>
  );
}

export default function CompanyDetail({ params }) {
  const { query } = useRoute();
  const tab = TABS.includes(query.tab) ? query.tab : 'overview';
  const { data: d, error, reload } = useApi(`/api/companies/${params.id}`, { intervalMs: 8000 });
  const [lastRun, setLastRun] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!d) return <p className="empty">Loading…</p>;
  const c = d.company;
  const go = (t) => navigate(`/companies/${c.id}?tab=${t}`);
  return (
    <div>
      <div className="spread">
        <h1 data-testid="company-title">{c.name} <Badge value={c.status} /></h1>
        <div className="row">
          <ActionButton disabled={!c.active_rule_id} onClick={async () => { const r = await api.post(`/api/companies/${c.id}/run`, { mode: 'fast' }); setLastRun(r.run); reload(); }} testId="run-now">Run now</ActionButton>
          <ActionButton disabled={!c.active_rule_id} onClick={async () => { const r = await api.post(`/api/companies/${c.id}/run`, { mode: 'full' }); setLastRun(r.run); reload(); }} testId="run-full">Full sweep</ActionButton>
          <ActionButton onClick={async () => { await api.post(`/api/companies/${c.id}/discover`); reload(); go('tasks'); }} testId="rediscover">Re-run discovery</ActionButton>
          <ActionButton disabled={!c.active_rule_id} onClick={async () => { await api.post(`/api/rules/${c.active_rule_id}/verify`, { window: '1h' }); reload(); go('tasks'); }} testId="verify">Verify (1h)</ActionButton>
          {c.status === 'paused' ? (
            <ActionButton onClick={async () => { await api.post(`/api/companies/${c.id}/resume`); reload(); }} testId="resume">Resume</ActionButton>
          ) : (
            <ActionButton onClick={async () => { await api.post(`/api/companies/${c.id}/pause`); reload(); }} testId="pause">Pause</ActionButton>
          )}
          <ActionButton variant="danger" confirm="delete" onClick={async () => { await api.del(`/api/companies/${c.id}`); navigate('/companies'); }} testId="delete-company">Delete</ActionButton>
        </div>
      </div>
      {lastRun && (
        <div className={`banner ${lastRun.status === 'ok' ? 'warn' : 'bad'}`} style={lastRun.status === 'ok' ? { background: 'var(--ok-bg)', color: 'var(--ok)' } : undefined} data-testid="last-run-banner">
          Run {lastRun.status}: {lastRun.job_count ?? 0} jobs, {lastRun.new_job_count ?? 0} new, {lastRun.notified_count ?? 0} sent to Discord{lastRun.error_type ? ` · ${lastRun.error_type}: ${lastRun.error_message}` : ''} · <a href={`#/runs/${lastRun.id}`}>details</a>
        </div>
      )}
      <Tabs tabs={TABS} value={tab} onChange={go} />
      {tab === 'overview' && <Overview d={d} />}
      {tab === 'roles' && (
        <>
          <Card title="Role mode">
            <select value={c.role_mode} onChange={async (e) => { await api.put(`/api/companies/${c.id}`, { role_mode: e.target.value }); reload(); }} data-testid="company-role-mode-edit">
              <option value="global_plus_company">Global + company roles</option>
              <option value="company_only">Company roles only</option>
              <option value="all_jobs">All jobs (no role filter)</option>
            </select>
            <p className="muted small">Search terms sent to the portal: {d.search_terms.join(', ') || '(none: fetch all jobs)'}</p>
            <LocationEditor company={c} onSaved={reload} />
          </Card>
          <Card title="Only jobs posted within">
            <p className="muted small">Leave empty to use the global setting (Settings → Filters).</p>
            <AgeEditor company={c} onSaved={reload} />
          </Card>
          <Card title={`Roles only for ${c.name}`} testId="company-roles">
            <RoleTable roles={d.company_roles} scope="company" companyId={c.id} onChange={reload} />
          </Card>
        </>
      )}
      {tab === 'rules' && <RulesTab d={d} reload={reload} />}
      {tab === 'runs' && <Card title="Recent runs"><RunsTable runs={d.runs} /></Card>}
      {tab === 'jobs' && <Card title="Jobs"><JobsTable companyId={c.id} showCompany={false} /></Card>}
      {tab === 'tasks' && <Card title="Discovery & verification tasks"><TasksTable tasks={d.tasks} onChange={reload} /></Card>}
    </div>
  );
}
