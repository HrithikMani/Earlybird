import { useState } from 'react';
import { api } from '../api.js';
import { ActionButton, Json } from './ui.jsx';

const EXAMPLE = {
  type: 'api',
  url: 'https://boards-api.greenhouse.io/v1/boards/TOKEN/jobs',
  jobs_path: 'jobs',
  fields: { id: 'id', title: 'title', url: 'absolute_url', location: 'location.name', posted_at: 'updated_at' },
};

/** JSON rule editor with dry-run and validated save (saves as a new version). */
export function RuleEditor({ companyId, initial, initialCode, onSaved }) {
  const [text, setText] = useState(() => JSON.stringify(initial || EXAMPLE, null, 2));
  const [code, setCode] = useState(initialCode || '');
  const [result, setResult] = useState(null);
  const [saveResult, setSaveResult] = useState(null);
  const [activate, setActivate] = useState(true);
  const [force, setForce] = useState(false);
  const [reason, setReason] = useState('');
  let spec;
  let parseError;
  try {
    spec = JSON.parse(text);
  } catch (e) {
    parseError = e.message;
  }
  const isScript = spec?.type === 'script';

  const test = async () => {
    setResult(null);
    setResult(await api.post('/api/rules/test', { companyId, spec, code: isScript ? code : undefined }));
  };
  const save = async () => {
    setSaveResult(null);
    try {
      const res = await api.post('/api/rules', { companyId, spec, code: isScript ? code : undefined, activate, force, reason: reason || undefined });
      setSaveResult({ ok: true, ...res });
      onSaved?.(res);
    } catch (e) {
      setSaveResult({ ok: false, message: e.message, validation: e.body?.validation });
    }
  };

  return (
    <div data-testid="rule-editor">
      <textarea rows={18} value={text} onChange={(e) => setText(e.target.value)} data-testid="rule-json" spellCheck={false} />
      {parseError && <div className="inline-error">JSON: {parseError}</div>}
      {isScript && (
        <>
          <h3>Script code</h3>
          <textarea rows={14} value={code} onChange={(e) => setCode(e.target.value)} placeholder="export default async function fetchJobs({ terms, mode, fetch, cheerio, page, log }) { return [] }" data-testid="rule-code" spellCheck={false} />
        </>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <ActionButton onClick={test} disabled={!!parseError} testId="rule-test">Test (dry run)</ActionButton>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} data-testid="rule-activate" /> make active</label>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> force</label>
        {force && <input placeholder="reason (logged)" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <ActionButton variant="primary" onClick={save} disabled={!!parseError} testId="rule-save">Validate &amp; save</ActionButton>
      </div>
      {result && (
        <div className="card" style={{ marginTop: 10 }} data-testid="rule-test-result">
          {result.ok ? (
            <>
              <strong data-testid="rule-test-count">{result.count} jobs</strong> <span className="muted">({result.meta.pages} pages, {result.meta.requests.length} requests, {result.meta.duration_ms} ms{result.terms?.length ? `, terms: ${result.terms.join(', ')}` : ''})</span>
              {result.meta.invalid_count > 0 && <div className="inline-error">{result.meta.invalid_count} invalid jobs: {result.meta.invalid_samples[0]?.error}</div>}
              <table>
                <tbody>
                  {result.jobs.slice(0, 15).map((j) => (
                    <tr key={j.url}><td>{j.title}</td><td className="muted">{j.location}</td><td className="muted small">{j.external_id}</td><td className="muted small">{j.posted_at ? new Date(j.posted_at).toLocaleString() : j.posted_at_raw}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="error-box" data-testid="rule-test-error">{result.error.type}: {result.error.message}</div>
          )}
        </div>
      )}
      {saveResult && (
        <div className="card" style={{ marginTop: 10 }} data-testid="rule-save-result">
          {saveResult.ok ? (
            <span>Saved <a className="mono" href={`#/rules/${saveResult.rule.id}`}>{saveResult.rule.id}</a> (score {saveResult.validation.score.total.toFixed(2)}){saveResult.needsApproval ? ' · waiting for approval' : ''}</span>
          ) : (
            <>
              <div className="error-box">{saveResult.message}</div>
              {saveResult.validation && <Json value={{ errors: saveResult.validation.errors, score: saveResult.validation.score, runs: saveResult.validation.runs }} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}
