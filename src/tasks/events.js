import { EventEmitter } from 'node:events';
import { getSqlite } from '../db/index.js';

/** Live task events for SSE subscribers: bus.on(taskId, event). */
export const taskBus = new EventEmitter();
taskBus.setMaxListeners(200);

const seqs = new Map();

function nextSeq(taskId) {
  if (!seqs.has(taskId)) {
    const row = getSqlite().prepare('select max(seq) m from task_events where task_id = ?').get(taskId);
    seqs.set(taskId, row?.m ?? 0);
  }
  const n = seqs.get(taskId) + 1;
  seqs.set(taskId, n);
  return n;
}

const clip = (v, n = 4000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return v;
  return s.length > n ? (typeof v === 'string' ? s.slice(0, n) + '…' : { truncated: true, preview: s.slice(0, n) + '…' }) : v;
};

/** Records one task event (DB + live bus). type: status|phase|step|tool_call|tool_result|model_text|guard|log|result */
export function emitTaskEvent(taskId, type, data = {}, level = 'info') {
  const ev = { task_id: taskId, ts: Date.now(), seq: nextSeq(taskId), level, type, data: clip(data, 8000) };
  try {
    getSqlite().prepare('insert into task_events (task_id, ts, seq, level, type, data) values (?, ?, ?, ?, ?, ?)').run(ev.task_id, ev.ts, ev.seq, ev.level, ev.type, JSON.stringify(ev.data));
  } catch {
    // DB closing
  }
  taskBus.emit(taskId, ev);
  taskBus.emit('*', ev);
  return ev;
}

export function forgetTask(taskId) {
  seqs.delete(taskId);
}

export { clip };
