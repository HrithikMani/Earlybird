import { useEffect, useState } from 'react';
import { api, subscribe } from '../api.js';
import { navigate, useApi } from '../hooks.js';
import { ActionButton, Badge, Card, ErrorBox, Json, fmtElapsed, fmtTime, taskDuration } from '../components/ui.jsx';
import { ACTIVE } from '../components/tasks.jsx';
import { StepLog } from '../components/step-log.jsx';

const PHASES = ['explore', 'analyze', 'build', 'test', 'commit'];
const PHASE_LABEL = { explore: 'Explore', analyze: 'Analyze', build: 'Build rules', test: 'Test rules', commit: 'Commit', verify: 'Verify' };

function Event({ ev }) {
  const d = ev.data || {};
  const [open, setOpen] = useState(false);
  let body;
  switch (ev.type) {
    case 'phase':
      body = <><strong>{PHASE_LABEL[d.phase] || d.phase}</strong> — {d.note}</>;
      break;
    case 'tool_call':
      body = <><strong>→ {d.tool}</strong>{d.repeat > 1 && <span className="inline-error"> (repeat #{d.repeat})</span>} <span className="mono small muted">{JSON.stringify(d.input).slice(0, 220)}</span></>;
      break;
    case 'tool_result':
      body = d.error ? (
        <><strong className="inline-error">← {d.tool} failed</strong> <span className="small inline-error">{d.error.slice(0, 300)}</span></>
      ) : (
        <><strong>← {d.tool}</strong> <span className="mono small muted">{JSON.stringify(d.output).slice(0, 220)}</span></>
      );
      break;
    case 'model_text':
      body = <span style={{ whiteSpace: 'pre-wrap' }}>{d.text}</span>;
      break;
    case 'step':
      body = <span className="muted small">step {d.step} · {d.input_tokens}+{d.output_tokens} tokens · ${d.cost_usd}</span>;
      break;
    case 'guard':
      body = <strong className="inline-error">Guard: {d.guard} — {d.message}</strong>;
      break;
    case 'validation':
      body = <>Validated <strong>{d.strategy}/{d.type}</strong>: <Badge value={d.passed ? 'ok' : 'failed'} /> {d.job_count} jobs, score {d.score?.total?.toFixed?.(2)} {d.errors?.length ? <span className="inline-error">{d.errors.join('; ')}</span> : null}</>;
      break;
    case 'status':
      body = <>Status: <Badge value={d.status || 'running'} /> {d.message || d.summary || ''} {d.error_type ? <span className="inline-error">{d.error_type}</span> : null}</>;
      break;
    default:
      body = <>{d.message || JSON.stringify(d).slice(0, 200)}</>;
  }
  const expandable = ['tool_call', 'tool_result', 'validation', 'result'].includes(ev.type);
  return (
    <div className={`event ${ev.type}`} data-testid={`event-${ev.type}`} onClick={() => expandable && setOpen(!open)} style={{ cursor: expandable ? 'pointer' : 'default' }}>
      <span className="muted small">{new Date(ev.ts).toLocaleTimeString()} </span>
      {body}
      {open && <Json value={d} />}
    </div>
  );
}

/** Where the steps and money went (per phase) and which tool calls failed: for tuning the prompt. */
function Diagnostics({ task, events }) {
  const stored = task.result?.diagnostics;
  // While running, derive the same numbers from the live step events.
  const byPhase = stored?.by_phase ?? {};
  const failed = stored?.failed_calls ?? [];
  if (!stored) {
    for (const e of events) {
      if (e.type === 'step') {
        const b = (byPhase[e.data.phase || 'start'] ??= { steps: 0, cost_usd: 0, tool_calls: 0, failed_calls: 0, input_tokens: 0, output_tokens: 0 });
        b.steps++;
        b.cost_usd += e.data.step_cost_usd || 0;
        b.tool_calls += (e.data.tools || []).length;
        b.input_tokens += e.data.input_tokens || 0;
        b.output_tokens += e.data.output_tokens || 0;
      }
      if (e.type === 'tool_result' && e.data.error) {
        failed.push({ step: e.data.step, phase: e.data.phase, tool: e.data.tool, error: e.data.error });
        if (byPhase[e.data.phase || 'start']) byPhase[e.data.phase || 'start'].failed_calls++;
      }
    }
  }
  const phases = Object.entries(byPhase);
  if (!phases.length) return null;
  const totalCost = phases.reduce((s, [, v]) => s + v.cost_usd, 0) || 1;
  return (
    <Card title="Diagnostics (for prompt tuning)" testId="task-diagnostics">
      <table>
        <thead><tr><th>Phase</th><th>Steps</th><th>Tool calls</th><th>Failed calls</th><th>Tokens (in/out)</th><th>Cost</th><th>Share</th></tr></thead>
        <tbody>
          {phases.map(([p, v]) => (
            <tr key={p} data-testid={`diag-phase-${p}`}>
              <td>{PHASE_LABEL[p] || p}</td>
              <td>{v.steps}</td>
              <td>{v.tool_calls}</td>
              <td className={v.failed_calls ? 'inline-error' : ''}>{v.failed_calls}</td>
              <td className="small">{v.input_tokens.toLocaleString()} / {v.output_tokens.toLocaleString()}</td>
              <td>${v.cost_usd.toFixed(3)}</td>
              <td>{Math.round((v.cost_usd / totalCost) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Failed tool calls ({failed.length})</h3>
      {failed.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <table data-testid="diag-failed-calls">
          <thead><tr><th>Step</th><th>Phase</th><th>Tool</th><th>Error</th></tr></thead>
          <tbody>
            {failed.map((f, i) => (
              <tr key={i}>
                <td>{f.step}</td>
                <td>{PHASE_LABEL[f.phase] || f.phase}</td>
                <td className="mono small">{f.tool}{f.input ? <div className="muted">{JSON.stringify(f.input).slice(0, 160)}</div> : null}</td>
                <td className="small inline-error">{f.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function TaskDetail({ params }) {
  const { data, error, reload } = useApi(`/api/tasks/${params.id}`, { intervalMs: 4000 });
  const [live, setLive] = useState([]);
  const [note, setNote] = useState('');
  const task = data?.task;
  const lastSeq = data?.events?.at(-1)?.seq ?? 0;
  const isActive = task && ACTIVE.includes(task.status);

  useEffect(() => {
    if (!isActive) return undefined;
    setLive([]);
    return subscribe(`/api/tasks/${params.id}/stream?after=${lastSeq}`, { event: (ev) => setLive((l) => [...l, ev]) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, isActive, data?.events?.length]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="empty">Loading…</p>;
  const events = [...data.events, ...live.filter((e) => e.seq > lastSeq)];
  const reached = new Set(events.filter((e) => e.type === 'phase').map((e) => e.data.phase));
  const summary = task.result?.summary;

  return (
    <div>
      <div className="spread">
        <h1>
          {task.kind} task <span className="mono">{task.id}</span> <Badge value={task.status} testId="task-detail-status" />
        </h1>
        <div className="row">
          {isActive && <ActionButton onClick={async () => { await api.post(`/api/tasks/${task.id}/stop`); reload(); }} testId="task-stop">Stop</ActionButton>}
          {isActive && task.status !== 'queued' && <ActionButton variant="danger" onClick={async () => { await api.post(`/api/tasks/${task.id}/kill`); reload(); }} testId="task-kill">Kill</ActionButton>}
        </div>
      </div>
      {task.kind !== 'synonyms' && (
        <div className="row" style={{ marginBottom: 12 }} data-testid="phase-bar">
          {(task.kind === 'verify' ? ['verify', 'commit'] : PHASES).map((p) => (
            <span key={p} className={`badge ${reached.has(p) ? 'tone-ok' : 'tone-muted'}`} data-testid={`phase-${p}`}>{PHASE_LABEL[p]}</span>
          ))}
        </div>
      )}
      {summary && <div className="banner" style={{ background: 'var(--ok-bg)', color: 'var(--ok)' }} data-testid="task-summary">{summary}<div className="small" style={{ marginTop: 4 }} data-testid="task-summary-usage">Took {fmtElapsed(taskDuration(task))} · {task.steps} steps · ${(task.cost_usd || 0).toFixed(2)}</div></div>}
      {task.error_message && <div className="banner bad" data-testid="task-error">{task.error_type}: {task.error_message}</div>}
      <Card>
        <table>
          <tbody>
            <tr><th>Company</th><td>{data.company ? <a href={`#/companies/${data.company.id}`}>{data.company.name}</a> : '—'}</td></tr>
            <tr><th>Model</th><td className="mono">{task.model || '—'}</td></tr>
            <tr><th>Prompt</th><td className="mono small">{task.prompt_file ? `${task.prompt_file} @ ${task.prompt_hash}` : '—'}</td></tr>
            <tr>
              <th>Usage</th>
              <td data-testid="task-usage">
                <strong>{fmtElapsed(taskDuration(task))}</strong> · {task.steps} steps · {(task.input_tokens + task.output_tokens).toLocaleString()} tokens · <strong>${(task.cost_usd || 0).toFixed(2)}</strong>{' '}
                <span className="muted small">(limit ${data.limits?.maxCostUsd ?? '—'} per task, {data.limits?.maxSteps ?? '—'} steps, {data.limits?.maxWallTimeMin ?? '—'} min · Settings → AI)</span>
              </td>
            </tr>
            <tr><th>Attempt</th><td>#{task.attempt}{data.retry_chain.length > 0 && <> · retry of {data.retry_chain.map((t) => <a key={t.id} className="mono" href={`#/tasks/${t.id}`}> {t.id}</a>)}</>}{data.retries.length > 0 && <> · retried as {data.retries.map((t) => <a key={t.id} className="mono" href={`#/tasks/${t.id}`}> {t.id}</a>)}</>}</td></tr>
            {task.operator_note && <tr><th>Operator note</th><td>{task.operator_note}</td></tr>}
            <tr><th>Timing</th><td>created {fmtTime(task.created_at)}{task.started_at && ` · started ${fmtTime(task.started_at)}`}{task.finished_at && ` · finished ${fmtTime(task.finished_at)}`}</td></tr>
          </tbody>
        </table>
      </Card>
      {!isActive && (
        <Card title="Retry">
          <div className="row">
            <input style={{ flex: 1, minWidth: 280 }} placeholder="Optional note for the agent, e.g. 'the jobs are behind the Engineering tab'" value={note} onChange={(e) => setNote(e.target.value)} data-testid="retry-note" />
            <ActionButton variant="primary" onClick={async () => { const r = await api.post(`/api/tasks/${task.id}/retry`, { note: note || undefined }); navigate(`/tasks/${r.task.id}`); }} testId="task-retry">Retry</ActionButton>
          </div>
        </Card>
      )}
      {task.kind !== 'synonyms' && <StepLog taskId={task.id} live={isActive} />}
      <Diagnostics task={task} events={events} />
      <Card title={`Live activity (${events.length} events)`} testId="task-events" actions={<a className="btn small" href={`/api/tasks/${task.id}/transcript`} data-testid="task-transcript">Download transcript (JSON)</a>}>
        {events.map((ev) => <Event key={ev.seq} ev={ev} />)}
      </Card>
      {task.result && (
        <Card title="Result">
          <Json value={task.result} testId="task-result" />
        </Card>
      )}
    </div>
  );
}
