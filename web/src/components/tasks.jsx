import { api } from '../api.js';
import { navigate } from '../hooks.js';
import { ActionButton, Badge, Empty, fmtAgo } from './ui.jsx';

export const ACTIVE = ['queued', 'running', 'cancelling'];

export function TaskActions({ task, onChange }) {
  const active = ACTIVE.includes(task.status);
  return (
    <div className="row" onClick={(e) => e.stopPropagation()}>
      {active && <ActionButton variant="small" onClick={async () => { await api.post(`/api/tasks/${task.id}/stop`); onChange?.(); }} testId={`task-stop-${task.id}`}>Stop</ActionButton>}
      {active && task.status !== 'queued' && <ActionButton variant="small danger" onClick={async () => { await api.post(`/api/tasks/${task.id}/kill`); onChange?.(); }} testId={`task-kill-${task.id}`}>Kill</ActionButton>}
      {!active && <ActionButton variant="small" onClick={async () => { const r = await api.post(`/api/tasks/${task.id}/retry`, {}); onChange?.(); navigate(`/tasks/${r.task.id}`); }} testId={`task-retry-${task.id}`}>Retry</ActionButton>}
    </div>
  );
}

export function TasksTable({ tasks, onChange, showCompany = false }) {
  if (!tasks?.length) return <Empty>No tasks yet.</Empty>;
  return (
    <div className="table-wrap">
      <table data-testid="tasks-table">
        <thead>
          <tr><th>Task</th><th>Kind</th>{showCompany && <th>Company</th>}<th>Status</th><th>Attempt</th><th>Steps</th><th>Cost</th><th>Created</th><th>Error</th><th></th></tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => navigate(`/tasks/${t.id}`)} data-testid="task-row">
              <td className="mono small">{t.id}</td>
              <td>{t.kind}</td>
              {showCompany && <td>{t.company_name || t.company_id}</td>}
              <td><Badge value={t.status} testId="task-status" /></td>
              <td>{t.attempt}</td>
              <td>{t.steps}</td>
              <td>${(t.cost_usd || 0).toFixed(3)}</td>
              <td>{fmtAgo(t.created_at)}</td>
              <td className="small">{t.error_type ? `${t.error_type}: ${(t.error_message || '').slice(0, 100)}` : ''}</td>
              <td><TaskActions task={t} onChange={onChange} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
