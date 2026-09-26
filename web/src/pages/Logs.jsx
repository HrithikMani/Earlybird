import { useEffect, useMemo, useState } from 'react';
import { subscribe } from '../api.js';
import { useApi, useRoute } from '../hooks.js';
import { Card, ErrorBox, Json } from '../components/ui.jsx';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const CONTEXT_KEYS = ['company_id', 'rule_id', 'run_id', 'task_id'];

export function LogLine({ e }) {
  const [open, setOpen] = useState(false);
  const ts = e.ts ? new Date(e.ts) : new Date(e.time);
  const data = e.data ?? Object.fromEntries(Object.entries(e).filter(([k]) => !['level', 'levelName', 'time', 'msg', 'app', 'scope'].includes(k)));
  const hasData = data && Object.keys(data).length > 0;
  const lvl = e.levelName || e.level;
  return (
    <div data-testid="log-line">
      <div className="log-line" onClick={() => hasData && setOpen(!open)} style={{ cursor: hasData ? 'pointer' : 'default' }}>
        <span className="muted">{ts.toLocaleTimeString()}</span>
        <span className={`lvl-${lvl}`}>{lvl}</span>
        <span className="muted">{e.scope}</span>
        <span>
          {e.msg}
          {CONTEXT_KEYS.filter((k) => e[k]).map((k) => (
            <span key={k} className="muted"> {k.replace('_id', '')}={e[k]}</span>
          ))}
          {hasData && !open && <span className="muted"> …</span>}
        </span>
      </div>
      {open && <Json value={data} />}
    </div>
  );
}

export default function Logs() {
  const { query } = useRoute();
  const [filters, setFilters] = useState({ level: 'info', scope: '', q: '', ...Object.fromEntries(CONTEXT_KEYS.map((k) => [k, query[k] || ''])) });
  const [live, setLive] = useState(false);
  const [liveLines, setLiveLines] = useState([]);
  const qs = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString(), [filters]);
  const { data, error, reload } = useApi(`/api/logs?${qs}`);

  useEffect(() => {
    if (!live) return undefined;
    setLiveLines([]);
    return subscribe(`/api/logs/stream?${qs}`, { log: (e) => setLiveLines((ls) => [e, ...ls].slice(0, 500)) });
  }, [live, qs]);

  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  const lines = live ? liveLines : data?.items || [];
  return (
    <div>
      <h1>Logs</h1>
      <Card>
        <div className="row">
          <select value={filters.level} onChange={set('level')} data-testid="logs-level">
            {LEVELS.map((l) => <option key={l}>{l}</option>)}
          </select>
          <input placeholder="scope (run, task, discord…)" value={filters.scope} onChange={set('scope')} data-testid="logs-scope" />
          <input placeholder="search" value={filters.q} onChange={set('q')} data-testid="logs-search" />
          {CONTEXT_KEYS.map((k) => (
            <input key={k} placeholder={k} value={filters[k]} onChange={set(k)} style={{ width: 130 }} data-testid={`logs-${k}`} />
          ))}
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} data-testid="logs-live" /> Live tail
          </label>
          {!live && <button className="btn" onClick={reload}>Refresh</button>}
        </div>
      </Card>
      <ErrorBox error={error} />
      <Card>
        <div className="log-scroll" data-testid="logs-list">
          {lines.length === 0 && <p className="empty">No log entries match.</p>}
          {lines.map((e, i) => <LogLine key={e.id ?? `${e.time}-${i}`} e={e} />)}
        </div>
      </Card>
    </div>
  );
}
