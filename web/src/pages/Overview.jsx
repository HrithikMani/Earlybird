import { useApi } from '../hooks.js';
import { Badge, Card, fmtAgo } from '../components/ui.jsx';

function Stat({ label, value, testId }) {
  return (
    <div className="stat" data-testid={testId}>
      <div className="label">{label}</div>
      <div className="value">{value ?? '—'}</div>
    </div>
  );
}

export default function Overview({ health }) {
  const h = health.data;
  const stats = useApi('/api/stats', { intervalMs: 15000 });
  const s = stats.data;
  return (
    <div>
      <h1>Overview</h1>
      {h?.warnings?.map((w) => (
        <div key={w.id} className="banner warn" data-testid={`warning-${w.id}`}>
          {w.message}
        </div>
      ))}
      <div className="stats">
        <Stat label="Companies" value={s?.companies} testId="stat-companies" />
        <Stat label="Open jobs" value={s?.openJobs} testId="stat-open-jobs" />
        <Stat label="New jobs (24h)" value={s?.newJobs24h} testId="stat-new-jobs" />
        <Stat label="Sent to Discord (24h)" value={s?.notified24h} testId="stat-notified" />
        <Stat label="Running tasks" value={s?.runningTasks} testId="stat-running-tasks" />
        <Stat label="Open alerts" value={s?.openAlerts} testId="stat-open-alerts" />
      </div>
      <Card title="System" testId="system-card">
        {h ? (
          <table>
            <tbody>
              <tr><th>Status</th><td><Badge value={h.ok ? 'ok' : 'error'} testId="system-status" /></td></tr>
              <tr><th>Scheduler</th><td data-testid="scheduler-last-tick">{h.scheduler.running ? `last tick ${fmtAgo(h.scheduler.lastTickAt)}` : 'not running'}{h.scheduler.stalled && ' (stalled)'}</td></tr>
              <tr><th>Due backlog</th><td>{h.scheduler.dueBacklog}</td></tr>
              <tr><th>Pools</th><td>{Object.entries(h.pools).map(([k, p]) => `${k} ${p.active}/${p.limit}${p.pending ? ` (+${p.pending} queued)` : ''}`).join(' · ')}</td></tr>
              <tr><th>Database</th><td>{h.db.ok ? 'ok' : h.db.error}</td></tr>
              <tr><th>Version</th><td>{h.version} · up {Math.round(h.uptimeSec / 60)} min · {h.memoryMb} MB</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="empty">Loading…</p>
        )}
      </Card>
      {s?.attention?.length > 0 && (
        <Card title="Needs attention" testId="attention-card">
          <table>
            <tbody>
              {s.attention.map((c) => (
                <tr key={c.id}>
                  <td><a href={`#/companies/${c.id}`}>{c.name}</a></td>
                  <td><Badge value={c.status} /></td>
                  <td className="muted">{c.health_note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
