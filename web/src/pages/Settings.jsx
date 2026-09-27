import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useRoute, navigate } from '../hooks.js';
import { ActionButton, Card, ErrorBox, Tabs } from '../components/ui.jsx';

const list = (v) => (Array.isArray(v) ? v.join(', ') : '');
const unlist = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

// Field specs per section: [key, label, type, options]
const FIELDS = {
  ai: [
    ['apiKey', 'Anthropic API key', 'password'],
    ['discoveryModel', 'Discovery model', 'model'],
    ['verifyModel', 'Verification model', 'model'],
    ['effort', 'Effort', 'select', ['default', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['maxSteps', 'Max agent steps per task', 'number'],
    ['maxWallTimeMin', 'Max wall time per task (min)', 'number'],
    ['maxCostUsd', 'Max cost per task (USD)', 'number'],
    ['maxAttempts', 'Discovery attempts', 'number'],
    ['loopRepeatLimit', 'Loop detection: identical tool calls', 'number'],
    ['noProgressSteps', 'Loop detection: steps without progress', 'number'],
    ['prices', 'Model prices ($ per 1M tokens)', 'json'],
    ['scheduledVerify', 'Scheduled verification', 'json'],
  ],
  scheduling: [
    ['defaultIntervalMin', 'Default interval (min)', 'number'],
    ['minIntervalApiMin', 'Minimum interval, API/HTML rules (min)', 'number'],
    ['minIntervalBrowserMin', 'Minimum interval, browser/script rules (min)', 'number'],
    ['fullSweepEveryMin', 'Full sweep every (min)', 'number'],
    ['jitterSec', 'Jitter (sec)', 'number'],
    ['apiPool', 'API/HTML concurrency', 'number'],
    ['browserPool', 'Browser concurrency', 'number'],
    ['agentPool', 'Concurrent agent tasks', 'number'],
    ['scrapeCron', 'Scrape tick cron', 'text'],
    ['discoveryCron', 'Task queue cron', 'text'],
    ['cleanupCron', 'Cleanup cron', 'text'],
  ],
  roles: [['maxTermsPerRun', 'Max search terms per run', 'number']],
  filters: [
    ['maxJobAgeDays', 'Only care about jobs posted within (days): older ones are not stored, shown or sent', 'number'],
    ['maxJobsPerCompany', 'Max jobs per company: rules read only the newest N, and only N listings are kept', 'number'],
    ['excludeKeywords', 'Exclude keywords (comma separated)', 'list'],
    ['locations', 'Locations (comma separated, empty = any)', 'list'],
  ],
  dedupe: [
    ['renotifyRepostedAfterDays', 'Re-notify reposted jobs after (days, empty = never)', 'nullnumber'],
    ['trackingParams', 'URL params stripped for dedupe', 'list'],
  ],
  retention: [
    ['closedJobDays', 'Delete closed jobs after (days)', 'number'],
    ['keepJobsDays', 'Delete listings first seen more than (days) ago', 'number'],
    ['seenJobDays', 'Remember seen jobs for (days)', 'number'],
    ['runDays', 'Keep runs (days)', 'number'],
    ['logDays', 'Keep logs (days)', 'number'],
    ['taskEventDays', 'Keep task events (days)', 'number'],
    ['artifactDays', 'Keep screenshots/artifacts (days)', 'number'],
  ],
  logging: [
    ['level', 'Log level', 'select', ['trace', 'debug', 'info', 'warn', 'error']],
    ['saveTraces', 'Save Playwright traces on failure', 'bool'],
  ],
  scraping: [
    ['userAgent', 'User agent', 'text'],
    ['respectRobots', 'Respect robots.txt', 'bool'],
    ['requestTimeoutMs', 'Request timeout (ms)', 'number'],
    ['actionTimeoutMs', 'Browser action timeout (ms)', 'number'],
  ],
  scripts: [
    ['allow', 'Allow AI-generated script rules', 'bool'],
    ['requireApproval', 'Script rules need approval before going live', 'bool'],
    ['timeoutMs', 'Script timeout (ms)', 'number'],
    ['memoryMb', 'Script memory limit (MB)', 'number'],
  ],
  mcp: [
    ['playwright', 'Playwright MCP options', 'json'],
    ['servers', 'Extra MCP servers', 'json'],
  ],
};

const TABS = ['ai', 'discord', 'scheduling', 'roles', 'filters', 'dedupe', 'retention', 'logging', 'scraping', 'scripts', 'mcp'];

function Field({ spec, value, onChange, models }) {
  const [key, label, type, options] = spec;
  const id = `setting-${key}`;
  const [jsonText, setJsonText] = useState(() => JSON.stringify(value, null, 2));
  const [jsonErr, setJsonErr] = useState(null);
  if (type === 'bool') {
    return (
      <label className="check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} data-testid={id} /> {label}
      </label>
    );
  }
  let input;
  if (type === 'select') {
    input = (
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={id}>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  } else if (type === 'model') {
    input = (
      <>
        <input list="model-list" value={value} onChange={(e) => onChange(e.target.value)} data-testid={id} />
        <datalist id="model-list">{models.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</datalist>
      </>
    );
  } else if (type === 'number' || type === 'nullnumber') {
    input = (
      <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? (type === 'nullnumber' ? null : 0) : Number(e.target.value))} data-testid={id} />
    );
  } else if (type === 'list') {
    input = <input value={list(value)} onChange={(e) => onChange(unlist(e.target.value))} data-testid={id} />;
  } else if (type === 'json') {
    input = (
      <>
        <textarea
          value={jsonText}
          rows={Math.min(14, jsonText.split('\n').length + 1)}
          onChange={(e) => {
            setJsonText(e.target.value);
            try {
              onChange(JSON.parse(e.target.value));
              setJsonErr(null);
            } catch (err) {
              setJsonErr(err.message);
            }
          }}
          data-testid={id}
        />
        {jsonErr && <span className="inline-error">{jsonErr}</span>}
      </>
    );
  } else {
    input = <input type={type === 'password' ? 'password' : 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} data-testid={id} autoComplete="off" />;
  }
  return (
    <label className="field">
      <span>{label}</span>
      {input}
    </label>
  );
}

function DiscordEditor({ value, onChange }) {
  const channels = value.channels || [];
  const setCh = (i, patch) => onChange({ ...value, channels: channels.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div>
      <h3>Channels</h3>
      {channels.map((c, i) => (
        <div className="row" key={c.id} style={{ marginBottom: 8 }}>
          <input placeholder="name" value={c.name} onChange={(e) => setCh(i, { name: e.target.value })} data-testid={`channel-name-${i}`} />
          <input placeholder="https://discord.com/api/webhooks/…" style={{ flex: 1, minWidth: 260 }} value={c.webhookUrl} onChange={(e) => setCh(i, { webhookUrl: e.target.value })} data-testid={`channel-webhook-${i}`} />
          <ActionButton testId={`channel-test-${i}`} onClick={async () => { await api.post('/api/discord/test', { channelId: c.id }); }}>Send test</ActionButton>
          <button className="btn small danger" onClick={() => onChange({ ...value, channels: channels.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      <button
        className="btn"
        data-testid="channel-add"
        onClick={() => onChange({ ...value, channels: [...channels, { id: `ch_${Math.random().toString(36).slice(2, 8)}`, name: channels.length ? `channel-${channels.length + 1}` : 'jobs', webhookUrl: '' }] })}
      >
        Add channel
      </button>
      <div className="form-grid" style={{ marginTop: 12 }}>
        {[['jobsChannelId', 'Default jobs channel'], ['alertsChannelId', 'Alerts channel']].map(([k, label]) => (
          <label className="field" key={k}>
            <span>{label}</span>
            <select value={value[k] ?? ''} onChange={(e) => onChange({ ...value, [k]: e.target.value || null })} data-testid={`setting-${k}`}>
              <option value="">(none)</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        ))}
        <label className="field">
          <span>Embeds per message</span>
          <input type="number" value={value.batchSize} onChange={(e) => onChange({ ...value, batchSize: Number(e.target.value) })} />
        </label>
      </div>
    </div>
  );
}

export default function Settings() {
  const { query } = useRoute();
  const tab = TABS.includes(query.tab) ? query.tab : 'ai';
  const { data, error, reload } = useApi('/api/settings');
  const models = useApi('/api/models');
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setDraft(structuredClone(data[tab]));
  }, [data, tab]);
  useEffect(() => setSaved(false), [tab]);

  const save = async () => {
    await api.put(`/api/settings/${tab}`, draft);
    await reload();
    setSaved(true);
  };

  return (
    <div>
      <h1>Settings</h1>
      <Tabs tabs={TABS} value={tab} onChange={(t) => navigate(`/settings?tab=${t}`)} />
      <ErrorBox error={error} />
      {draft && (
        <Card key={tab} testId={`settings-${tab}`}>
          {tab === 'ai' && data?.ai?.apiKeySource === 'env' && <p className="muted small">Using the API key from .env. Saving one here overrides it.</p>}
          {tab === 'roles' && <p className="muted small">Roles themselves are managed on the <a href="#/roles">Roles page</a>.</p>}
          {tab === 'retention' && <ActionButton onClick={async () => { await api.post('/api/maintenance/cleanup'); }} testId="run-cleanup">Run cleanup now</ActionButton>}
          {tab === 'discord' ? (
            <DiscordEditor value={draft} onChange={setDraft} />
          ) : (
            <div className="form-grid">
              {(FIELDS[tab] || []).map((spec) => (
                <Field key={spec[0]} spec={spec} value={draft[spec[0]]} models={models.data?.models || []} onChange={(v) => { setDraft({ ...draft, [spec[0]]: v }); setSaved(false); }} />
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <ActionButton variant="primary" onClick={save} testId="settings-save">Save</ActionButton>
            {saved && <span className="muted" data-testid="settings-saved">Saved</span>}
          </div>
        </Card>
      )}
    </div>
  );
}
