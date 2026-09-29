import { useRoute, useApi } from './hooks.js';
import Overview from './pages/Overview.jsx';
import Settings from './pages/Settings.jsx';
import Logs from './pages/Logs.jsx';
import { pages } from './pages/registry.js';

const NAV = [
  ['/', 'Overview', 'nav-overview'],
  ['/companies', 'Companies', 'nav-companies'],
  ['/roles', 'Roles', 'nav-roles'],
  ['/jobs', 'Jobs', 'nav-jobs'],
  ['/tasks', 'Tasks', 'nav-tasks'],
  ['/logs', 'Logs', 'nav-logs'],
  ['/settings', 'Settings', 'nav-settings'],
];

function resolve(path) {
  if (path === '/') return [Overview, {}];
  if (path === '/settings') return [Settings, {}];
  if (path === '/logs') return [Logs, {}];
  for (const [pattern, Comp] of pages) {
    const m = path.match(pattern);
    if (m) return [Comp, m.groups || {}];
  }
  return [NotFound, {}];
}

function NotFound() {
  return <p className="empty">Page not found.</p>;
}

export default function App() {
  const { path, query } = useRoute();
  const health = useApi('/api/health', { intervalMs: 15000 });
  const me = useApi('/api/auth/me');
  const [Page, params] = resolve(path);
  const section = '/' + (path.split('/')[1] || '');
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">🐦 Earlybird</div>
        <nav className="nav">
          {NAV.map(([to, label, id]) => (
            <a key={to} href={`#${to}`} className={section === to ? 'active' : ''} data-testid={id}>
              {label}
            </a>
          ))}
        </nav>
        {me.data?.user && (
          <div className="small muted" style={{ padding: '16px 10px 0', borderTop: '1px solid var(--border)', marginTop: 16 }} data-testid="signed-in">
            Signed in as <strong>{me.data.user}</strong>
            <div>
              <button
                className="btn small"
                style={{ marginTop: 8 }}
                data-testid="logout"
                onClick={async () => {
                  await fetch('/logout', { method: 'POST' });
                  window.location.href = '/login';
                }}
              >
                Log out
              </button>
            </div>
          </div>
        )}
      </aside>
      <main className="main">
        {health.data?.scheduler?.stalled && (
          <div className="banner bad" data-testid="scheduler-stalled-banner">
            The scheduler hasn't run for over 3 minutes. Check the Logs page.
          </div>
        )}
        {health.error && (
          <div className="banner bad" data-testid="server-down-banner">
            Can't reach the Earlybird server: {health.error.message}
          </div>
        )}
        <Page params={params} query={query} health={health} />
      </main>
    </div>
  );
}
