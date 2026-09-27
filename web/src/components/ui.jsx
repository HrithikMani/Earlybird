import { useState } from 'react';

export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
}

export function fmtAgo(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 0) return `in ${fmtDur(-s)}`;
  if (s < 5) return 'just now';
  return `${fmtDur(s)} ago`;
}

/** "5m 24s" style duration from ms. */
export function fmtElapsed(ms) {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Duration of a task: finished − started, or so far when still running. */
export function taskDuration(t) {
  if (!t?.started_at) return null;
  return (t.finished_at || Date.now()) - t.started_at;
}

export function fmtDur(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const STATUS_TONE = {
  active: 'ok', ok: 'ok', sent: 'ok', succeeded: 'ok', healthy: 'ok', open: 'info',
  pending_discovery: 'info', discovering: 'info', queued: 'info', running: 'info', pending: 'info', cancelling: 'warn',
  degraded: 'warn', needs_review: 'warn', missing_recent: 'warn', stale: 'warn', inconclusive: 'warn', skipped: 'muted', interrupted: 'warn',
  failing: 'bad', error: 'bad', failed: 'bad', broken: 'bad', killed: 'bad', timed_out: 'bad',
  paused: 'muted', cancelled: 'muted', closed: 'muted', retired: 'muted', candidate: 'muted', fallback: 'info', resolved: 'muted',
};

export function Badge({ value, testId }) {
  if (!value) return null;
  return (
    <span className={`badge tone-${STATUS_TONE[value] || 'muted'}`} data-testid={testId}>
      {String(value).replaceAll('_', ' ')}
    </span>
  );
}

export function Card({ title, actions, children, testId }) {
  return (
    <section className="card" data-testid={testId}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert" data-testid="error-box">
      {error.message || String(error)}
    </div>
  );
}

export function Json({ value, testId }) {
  return (
    <pre className="json" data-testid={testId}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Button that runs an async action, shows busy state and errors. */
export function ActionButton({ onClick, children, variant = '', testId, disabled, confirm }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [armed, setArmed] = useState(false);
  const run = async () => {
    if (confirm && !armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    setBusy(true);
    setErr(null);
    try {
      await onClick();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="action">
      <button className={`btn ${variant}`} onClick={run} disabled={busy || disabled} data-testid={testId}>
        {busy ? '…' : armed ? `Click again: ${confirm}` : children}
      </button>
      {err && <span className="inline-error" data-testid={testId ? `${testId}-error` : undefined}>{err.message}</span>}
    </span>
  );
}

export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t} role="tab" aria-selected={value === t} className={value === t ? 'tab active' : 'tab'} onClick={() => onChange(t)} data-testid={`tab-${t}`}>
          {t}
        </button>
      ))}
    </div>
  );
}
