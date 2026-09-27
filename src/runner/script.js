import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScriptJobSchema } from '../schema/job.js';
import { Cancelled, InvalidRule, ScriptError, Timeout } from './errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const SANDBOX = path.join(here, 'script-sandbox.mjs');

/** Writes script code to a temp file (content-addressed) when no file path is given. */
export function materializeScript(code) {
  const dir = path.join(os.tmpdir(), 'earlybird-scripts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash('sha256').update(code).digest('hex').slice(0, 16)}.mjs`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, code);
  return file;
}

export function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/** Minimal env for the sandbox: no secrets. */
function sandboxEnv() {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'PLAYWRIGHT_BROWSERS_PATH'];
  return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
}

/**
 * Runs a script rule in a restricted child process. Returns { raw, baseUrl } where raw items use the
 * runner field names (id/title/url/location/department/posted_at).
 */
export async function runScript(rule, ctx, terms) {
  const scriptPath = ctx.scriptPath || (ctx.scriptCode ? materializeScript(ctx.scriptCode) : null);
  if (!scriptPath || !fs.existsSync(scriptPath)) throw new InvalidRule('script rule has no code (scriptPath/scriptCode missing)');

  const execArgv = [`--max-old-space-size=${ctx.scriptMemoryMb || 256}`, '--permission'];
  if (rule.uses_browser) {
    // Browser scripts need Chromium: allow reading everything, writing temp, and spawning the browser.
    execArgv.push('--allow-fs-read=*', `--allow-fs-write=${os.tmpdir()}`, '--allow-child-process');
  } else {
    execArgv.push(`--allow-fs-read=${SANDBOX}`, `--allow-fs-read=${scriptPath}`, `--allow-fs-read=${path.join(ROOT, 'node_modules')}`, `--allow-fs-read=${path.join(ROOT, 'package.json')}`);
  }

  const started = Date.now();
  const child = fork(SANDBOX, [], { execArgv, env: sandboxEnv(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: os.tmpdir() });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-4000)));
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  ctx.meta.script_logs = [];

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill('SIGKILL');
      fn(v);
    };
    const timeoutMs = ctx.scriptTimeoutMs || 90000;
    const timer = setTimeout(() => finish(reject, new Timeout(`script exceeded ${timeoutMs} ms`, { detail: { stderr, stdout } })), timeoutMs);
    const onAbort = () => {
      child.send?.({ type: 'abort' });
      finish(reject, new Cancelled('script cancelled'));
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('message', (m) => {
      if (m.type === 'log') {
        if (ctx.meta.script_logs.length < 200) ctx.meta.script_logs.push({ level: m.level, msg: m.msg, data: m.data });
        ctx.log?.[m.level === 'error' ? 'warn' : 'debug']?.({ script: true, data: m.data }, `script: ${m.msg}`);
      } else if (m.type === 'result') finish(resolve, m.jobs);
      else if (m.type === 'error') finish(reject, new ScriptError(`script threw: ${m.message}`, { detail: { name: m.name, stack: m.stack, stderr, stdout } }));
    });
    child.on('error', (e) => finish(reject, new ScriptError(`sandbox failed: ${e.message}`, { detail: { stderr } })));
    child.on('exit', (code) => finish(reject, new ScriptError(`sandbox exited (code ${code}) without a result`, { detail: { stderr, stdout } })));
    child.send({ scriptPath, terms, mode: ctx.mode, usesBrowser: rule.uses_browser, userAgent: ctx.userAgent, actionTimeoutMs: ctx.actionTimeoutMs });
  });
  ctx.meta.script_ms = Date.now() - started;
  ctx.meta.pages++;

  if (!Array.isArray(result)) throw new ScriptError(`script must return an array of jobs (got ${result?.notArray ?? typeof result})`);
  const raw = [];
  const invalid = [];
  for (const item of result) {
    const p = ScriptJobSchema.safeParse(item);
    if (!p.success) {
      invalid.push({ item, error: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      continue;
    }
    const j = p.data;
    raw.push({ id: j.external_id === undefined ? undefined : String(j.external_id), title: j.title, url: j.url, location: j.location ?? undefined, department: j.department ?? undefined, posted_at: j.posted_at ?? undefined, _term: j.search_term });
  }
  ctx.meta.script_invalid = invalid.slice(0, 5);
  ctx.meta.invalid_count = (ctx.meta.invalid_count || 0) + invalid.length;
  return { raw, baseUrl: rule.url_prefix };
}
