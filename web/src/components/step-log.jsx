import { useState } from 'react';
import { useApi } from '../hooks.js';
import { Card, Json } from './ui.jsx';

const PHASE_LABEL = { start: 'Start', explore: 'Explore', analyze: 'Analyze', build: 'Build', test: 'Test', commit: 'Commit', verify: 'Verify' };

function StepRow({ s }) {
  const [open, setOpen] = useState(false);
  const flagged = s.flags.some((f) => f.code !== 'no_action');
  return (
    <>
      <tr className="clickable" onClick={() => setOpen(!open)} style={flagged ? { background: 'var(--warn-bg)' } : undefined} data-testid="step-row">
        <td className="mono">{s.n}</td>
        <td>{PHASE_LABEL[s.phase] || s.phase}</td>
        <td className="small muted">{s.seconds != null ? `+${s.seconds}s` : ''}</td>
        <td>
          {s.reported_phase && (
            <div className="small">
              <strong>Reported phase: {PHASE_LABEL[s.reported_phase.phase] || s.reported_phase.phase}</strong>: {s.reported_phase.note}
            </div>
          )}
          {s.text && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>💬 {s.text.length > 240 && !open ? `${s.text.slice(0, 240)}…` : s.text}</div>}
          {s.calls.map((c, i) => (
            <div key={i} className="small" data-testid="step-call">
              <span className={c.ok ? '' : 'inline-error'}>{c.ok ? '✔' : '✖'} {c.description}</span>
              {c.result && (
                <div className={`muted ${c.ok ? '' : 'inline-error'}`} style={{ marginLeft: 16 }}>
                  → {open ? c.result : c.result.slice(0, 160)}
                  {c.output_chars > 0 && <span className="muted"> ({c.output_chars.toLocaleString()} chars)</span>}
                </div>
              )}
            </div>
          ))}
          {!s.calls.length && !s.text && !s.reported_phase && <span className="muted small">(no tool call)</span>}
          {open && s.calls.map((c, i) => <Json key={`j${i}`} value={{ tool: c.tool, input: c.input }} />)}
        </td>
        <td className="small">{s.cost_usd != null ? `$${s.cost_usd.toFixed(4)}` : ''}<div className="muted">{s.input_tokens?.toLocaleString()} in</div></td>
        <td>
          <div className="chips">
            {s.flags.map((f) => (
              <span key={f.code} className={`badge ${f.code === 'no_action' ? 'tone-muted' : 'tone-warn'}`} title={f.detail || ''} data-testid={`flag-${f.code}`}>
                {f.label}
              </span>
            ))}
          </div>
        </td>
      </tr>
    </>
  );
}

/** Step-by-step AI log with flags and prompt suggestions (for prompt tuning). */
export function StepLog({ taskId, live }) {
  const { data } = useApi(`/api/tasks/${taskId}/review`, { intervalMs: live ? 4000 : undefined });
  const [showOnlyFlagged, setShowOnlyFlagged] = useState(false);
  if (!data || !data.steps.length) return null;
  const steps = showOnlyFlagged ? data.steps.filter((s) => s.flags.some((f) => f.code !== 'no_action')) : data.steps;
  const t = data.totals;
  return (
    <>
      <Card title="What to change in the prompt" testId="prompt-findings">
        <p className="small">
          {t.steps} steps in {t.seconds}s for ${t.cost_usd.toFixed(2)}. <strong>{t.flagged_steps} steps</strong> were flagged as avoidable (<strong>${t.flagged_cost_usd.toFixed(2)}</strong>).
          Prompt: <span className="mono">{data.prompt_file || '—'}</span> @ <span className="mono">{data.prompt_hash || '—'}</span>
        </p>
        <table>
          <thead><tr><th>Phase</th><th>Steps</th><th>Budget</th><th>Time</th><th>Cost</th><th>Flagged</th></tr></thead>
          <tbody>
            {data.phases.map((p) => (
              <tr key={p.phase} data-testid={`review-phase-${p.phase}`}>
                <td>{PHASE_LABEL[p.phase] || p.phase}</td>
                <td className={p.over_budget ? 'inline-error' : ''}>{p.steps}</td>
                <td className="muted">{p.budget ?? '—'}</td>
                <td>{p.seconds}s</td>
                <td>${p.cost_usd.toFixed(3)}</td>
                <td>{p.flagged}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.findings.filter((f) => f.code !== 'no_action').length === 0 ? (
          <p className="muted small">No avoidable steps found.</p>
        ) : (
          <table style={{ marginTop: 10 }} data-testid="findings-table">
            <thead><tr><th>Problem</th><th>Steps</th><th>Example</th><th>Suggested prompt change</th></tr></thead>
            <tbody>
              {data.findings.filter((f) => f.code !== 'no_action').map((f) => (
                <tr key={f.code} data-testid={`finding-${f.code}`}>
                  <td><strong>{f.label}</strong></td>
                  <td className="mono small">{f.steps.join(', ')}</td>
                  <td className="small muted">{f.examples[0] || ''}</td>
                  <td className="small">{f.advice}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card
        title={`Step-by-step AI log (${data.steps.length} steps)`}
        testId="step-log"
        actions={
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={showOnlyFlagged} onChange={(e) => setShowOnlyFlagged(e.target.checked)} data-testid="step-log-flagged-only" /> only flagged steps
          </label>
        }
      >
        <p className="muted small">Click a step to see the full text and the exact tool input. Yellow rows are steps the prompt should prevent.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Phase</th><th>Time</th><th>What the AI did → what it got back</th><th>Cost</th><th>Flags</th></tr></thead>
            <tbody>{steps.map((s) => <StepRow key={s.n} s={s} />)}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
