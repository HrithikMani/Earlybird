import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ActionButton, Badge, Card, Empty, fmtAgo } from '../components/ui.jsx';
import { TasksTable } from '../components/tasks.jsx';

function Running({ items, onChange }) {
  const runs = items.filter((i) => i.kind === 'run');
  if (!runs.length) return <Empty>No scrape runs in progress.</Empty>;
  return (
    <table>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} data-testid="running-run">
            <td className="mono small"><a href={`#/runs/${r.id}`}>{r.id}</a></td>
            <td>{r.label}</td>
            <td>{fmtAgo(r.startedAt)}</td>
            <td>{r.aborted ? <Badge value="cancelling" /> : <Badge value="running" />}</td>
            <td className="row">
              <ActionButton variant="small" onClick={async () => { await api.post(`/api/running/${r.id}/stop`); onChange(); }}>Stop</ActionButton>
              <ActionButton variant="small danger" onClick={async () => { await api.post(`/api/running/${r.id}/kill`); onChange(); }}>Kill</ActionButton>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Tasks() {
  const active = useApi('/api/tasks?status=active', { intervalMs: 3000 });
  const recent = useApi('/api/tasks?limit=100', { intervalMs: 8000 });
  const running = useApi('/api/running', { intervalMs: 3000 });
  const reload = () => {
    active.reload();
    recent.reload();
    running.reload();
  };
  return (
    <div>
      <h1>Tasks</h1>
      <p className="muted">Discovery, verification and other agent tasks, plus scrape runs in progress. Open a task to watch it live; stop, kill or retry it from here.</p>
      <Card title="Active agent tasks" testId="active-tasks">
        <TasksTable tasks={active.data?.items} onChange={reload} showCompany />
      </Card>
      <Card title="Scrape runs in progress" testId="running-runs">
        <Running items={running.data?.items || []} onChange={reload} />
      </Card>
      <Card title="Recent tasks" testId="recent-tasks">
        <TasksTable tasks={recent.data?.items} onChange={reload} showCompany />
      </Card>
    </div>
  );
}
