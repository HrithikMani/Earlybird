import { useState } from 'react';
import { api } from '../api.js';
import { navigate, useApi } from '../hooks.js';
import { ActionButton, Badge, Card, Empty, ErrorBox, fmtAgo } from '../components/ui.jsx';

function AddCompany({ onAdded, apiKeyMissing }) {
  const [f, setF] = useState({ name: '', careers_url: '', roles: '', role_mode: 'global_plus_company', location: '', maxAge: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const res = await api.post('/api/companies', {
      name: f.name,
      careers_url: f.careers_url,
      role_mode: f.role_mode,
      roles: f.roles.split(',').map((s) => s.trim()).filter(Boolean),
      source_filters: f.location ? { location: f.location } : undefined,
      notify_filters: f.maxAge ? { maxJobAgeDays: Number(f.maxAge) } : undefined,
    });
    setF({ name: '', careers_url: '', roles: '', role_mode: 'global_plus_company', location: '', maxAge: '' });
    onAdded(res);
  };
  return (
    <Card title="Add company" testId="add-company">
      <div className="form-grid">
        <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} placeholder="Tesla" data-testid="company-name" /></label>
        <label className="field"><span>Careers URL</span><input value={f.careers_url} onChange={set('careers_url')} placeholder="https://www.tesla.com/careers/search" data-testid="company-url" /></label>
        <label className="field"><span>Company-specific roles (comma separated)</span><input value={f.roles} onChange={set('roles')} placeholder="AI Engineer, Infrastructure Engineer" data-testid="company-roles" /></label>
        <label className="field">
          <span>Role mode</span>
          <select value={f.role_mode} onChange={set('role_mode')} data-testid="company-role-mode">
            <option value="global_plus_company">Global + company roles</option>
            <option value="company_only">Company roles only</option>
            <option value="all_jobs">All jobs (no role filter)</option>
          </select>
        </label>
        <label className="field"><span>Location filter at the portal (optional)</span><input value={f.location} onChange={set('location')} placeholder="Remote" data-testid="company-location" /></label>
        <label className="field"><span>Only jobs posted within (days, optional)</span><input type="number" min="1" value={f.maxAge} onChange={set('maxAge')} placeholder="global default (Settings → Filters)" data-testid="company-max-age" /></label>
      </div>
      {apiKeyMissing && <p className="muted small">No Anthropic API key yet: the company will wait in "pending discovery" until you add one, or you can paste a rule by hand on its page.</p>}
      <ActionButton variant="primary" onClick={submit} testId="company-add">Add and discover</ActionButton>
    </Card>
  );
}

export default function Companies({ health }) {
  const { data, error, reload } = useApi('/api/companies', { intervalMs: 10000 });
  const apiKeyMissing = health?.data?.warnings?.some((w) => w.id === 'no_api_key');
  return (
    <div>
      <h1>Companies</h1>
      <AddCompany apiKeyMissing={apiKeyMissing} onAdded={(res) => { reload(); navigate(`/companies/${res.company.id}`); }} />
      <ErrorBox error={error} />
      <Card title="All companies" testId="companies-list">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th>Rule</th><th>Open jobs</th><th>Last success</th><th>Last new job</th><th>Next run</th></tr>
            </thead>
            <tbody>
              {(data?.items || []).map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/companies/${c.id}`)} data-testid={`company-row-${c.name}`}>
                  <td><strong>{c.name}</strong><div className="muted small">{c.careers_url}</div></td>
                  <td><Badge value={c.status} testId="company-status" />{c.using_fallback && <span className="muted small"> (fallback)</span>}</td>
                  <td>{c.rule ? <span className="mono">{c.rule.id} · {c.rule.strategy}/{c.rule.type} v{c.rule.version}</span> : <span className="muted">—</span>}</td>
                  <td>{c.open_jobs}</td>
                  <td>{fmtAgo(c.last_success_at)}</td>
                  <td>{fmtAgo(c.last_new_job_at)}</td>
                  <td>{c.status === 'paused' ? 'paused' : c.next_run_at ? fmtAgo(c.next_run_at) : c.active_rule_id ? 'now' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 && <Empty>No companies yet. Add one above.</Empty>}
        </div>
      </Card>
    </div>
  );
}
