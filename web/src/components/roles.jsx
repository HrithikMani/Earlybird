import { useState } from 'react';
import { api } from '../api.js';
import { ActionButton, Empty } from './ui.jsx';

const toList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const fromList = (a) => (a || []).join(', ');

function RoleRow({ role, onChange }) {
  const [edit, setEdit] = useState(false);
  const [flags, setFlags] = useState({ enabled: role.enabled, notify_existing: role.notify_existing });
  const toggle = (k) => async (e) => {
    const v = e.target.checked;
    setFlags((f) => ({ ...f, [k]: v }));
    await api.put(`/api/roles/${role.id}`, { [k]: v });
    onChange();
  };
  const [draft, setDraft] = useState(() => ({
    name: role.name,
    search_terms: fromList(role.search_terms),
    synonyms: fromList(role.synonyms),
    exclude_words: fromList(role.exclude_words),
  }));
  const save = async () => {
    await api.put(`/api/roles/${role.id}`, { name: draft.name, search_terms: toList(draft.search_terms), synonyms: toList(draft.synonyms), exclude_words: toList(draft.exclude_words) });
    setEdit(false);
    onChange();
  };
  if (edit) {
    return (
      <tr data-testid={`role-row-${role.name}`}>
        <td><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="role-edit-name" /></td>
        <td><input value={draft.search_terms} onChange={(e) => setDraft({ ...draft, search_terms: e.target.value })} data-testid="role-edit-terms" /></td>
        <td><input value={draft.synonyms} onChange={(e) => setDraft({ ...draft, synonyms: e.target.value })} data-testid="role-edit-synonyms" /></td>
        <td><input value={draft.exclude_words} onChange={(e) => setDraft({ ...draft, exclude_words: e.target.value })} data-testid="role-edit-exclude" /></td>
        <td colSpan={3}>
          <div className="row">
            <ActionButton variant="primary" onClick={save} testId="role-save">Save</ActionButton>
            <button className="btn" onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </td>
      </tr>
    );
  }
  return (
    <tr data-testid={`role-row-${role.name}`}>
      <td><strong>{role.name}</strong></td>
      <td><div className="chips">{(role.search_terms || []).map((t) => <span className="chip" key={t}>{t}</span>)}</div></td>
      <td><div className="chips">{(role.synonyms || []).map((t) => <span className="chip" key={t}>{t}</span>)}</div></td>
      <td><div className="chips">{(role.exclude_words || []).map((t) => <span className="chip" key={t}>{t}</span>)}</div></td>
      <td>
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={flags.enabled} onChange={toggle('enabled')} data-testid={`role-enabled-${role.name}`} /> on
        </label>
      </td>
      <td title="When this role is added, notify jobs that already match it (otherwise they are recorded silently)">
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={flags.notify_existing} onChange={toggle('notify_existing')} /> notify existing
        </label>
      </td>
      <td>
        <div className="row">
          {role.open_jobs !== undefined && <span className="muted small">{role.open_jobs} open</span>}
          <button className="btn small" onClick={() => setEdit(true)} data-testid={`role-edit-${role.name}`}>Edit</button>
          <ActionButton variant="small danger" confirm="delete" onClick={async () => { await api.del(`/api/roles/${role.id}`); onChange(); }} testId={`role-delete-${role.name}`}>Delete</ActionButton>
        </div>
      </td>
    </tr>
  );
}

/** Table of roles plus an add form. scope=global or company (with companyId). */
export function RoleTable({ roles, scope, companyId, onChange }) {
  const [name, setName] = useState('');
  const [synonyms, setSynonyms] = useState('');
  const add = async () => {
    if (!name.trim()) return;
    await api.post('/api/roles', { name: name.trim(), scope, company_id: companyId, synonyms: toList(synonyms) });
    setName('');
    setSynonyms('');
    onChange();
  };
  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Role</th><th>Search terms</th><th>Title synonyms</th><th>Exclude words</th><th>Enabled</th><th></th><th></th></tr>
          </thead>
          <tbody>
            {roles.map((r) => <RoleRow key={r.id + r.updated_at} role={r} onChange={onChange} />)}
          </tbody>
        </table>
        {roles.length === 0 && <Empty>No {scope} roles yet.</Empty>}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input placeholder="Role, e.g. DevOps Engineer" value={name} onChange={(e) => setName(e.target.value)} data-testid={`role-add-name-${scope}`} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <input placeholder="synonyms (comma separated, optional)" value={synonyms} onChange={(e) => setSynonyms(e.target.value)} style={{ minWidth: 260 }} data-testid={`role-add-synonyms-${scope}`} />
        <ActionButton onClick={add} testId={`role-add-${scope}`}>Add role</ActionButton>
      </div>
    </div>
  );
}
