import { logBus } from './logger.js';
import { getSqlite } from '../db/index.js';

const DETAIL_SCOPES = new Set(['run', 'task', 'cli', 'discord', 'discovery', 'verify', 'audit', 'scheduler']);
const SKIP_KEYS = new Set(['level', 'time', 'msg', 'scope', 'company_id', 'rule_id', 'run_id', 'task_id', 'app', 'pid', 'hostname', 'levelName']);

let buffer = [];
let timer;
let stmt;

function shouldStore(e) {
  if (e.noDb) return false;
  if (e.level >= 40) return true;
  return e.level >= 30 && DETAIL_SCOPES.has(e.scope);
}

function flush() {
  timer = undefined;
  if (!buffer.length) return;
  const rows = buffer;
  buffer = [];
  try {
    const sqlite = getSqlite();
    stmt ??= sqlite.prepare(
      'INSERT INTO logs (ts, level, msg, scope, company_id, rule_id, run_id, task_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    sqlite.transaction(() => {
      for (const r of rows) stmt.run(r);
    })();
  } catch {
    // DB closed or busy: logs still exist in stdout/files.
  }
}

/** Persists selected log entries to the `logs` table (batched). */
export function attachDbSink() {
  logBus.on('entry', (e) => {
    if (!shouldStore(e)) return;
    const data = {};
    for (const [k, v] of Object.entries(e)) if (!SKIP_KEYS.has(k)) data[k] = v;
    buffer.push([
      Date.parse(e.time) || Date.now(),
      e.levelName,
      e.msg ?? null,
      e.scope ?? 'server',
      e.company_id ?? null,
      e.rule_id ?? null,
      e.run_id ?? null,
      e.task_id ?? null,
      Object.keys(data).length ? JSON.stringify(data) : null,
    ]);
    if (buffer.length >= 200) flush();
    else timer ??= setTimeout(flush, 300);
  });
}

export function flushDbSink() {
  if (timer) clearTimeout(timer);
  flush();
}
