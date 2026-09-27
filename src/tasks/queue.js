import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb, newId, schema } from '../db/index.js';
import { getSettings } from '../settings/index.js';
import { childLogger, errorDetail } from '../log/logger.js';
import { runtime } from '../runtime.js';
import { onTick } from '../worker/scheduler.js';
import { getCompany, updateCompany } from '../store/companies.js';
import { raiseAlert, resolveAlerts } from '../store/alerts.js';
import * as registry from './registry.js';
import { emitTaskEvent, forgetTask } from './events.js';

const T = schema.tasks;
const log = childLogger('task');
const ACTIVE = ['queued', 'running', 'cancelling'];

const HANDLERS = {
  discovery: async (...a) => (await import('../agents/discovery.js')).runDiscovery(...a),
  verify: async (...a) => (await import('../agents/verify.js')).runVerification(...a),
  synonyms: async (...a) => (await import('../agents/synonyms.js')).runSynonyms(...a),
};

const MODEL_SETTING = { discovery: 'discoveryModel', verify: 'verifyModel', synonyms: 'discoveryModel' };

export function getTask(id) {
  return getDb().select().from(T).where(eq(T.id, id)).get();
}

function patchTask(id, patch) {
  getDb().update(T).set(patch).where(eq(T.id, id)).run();
}

/** Adds a task to the queue (and starts it right away if there is room). */
export function enqueueTask(kind, { companyId = null, ruleId = null, input = {}, parentTaskId = null, attempt = 1, operatorNote = null } = {}) {
  if (!HANDLERS[kind]) throw new Error(`unknown task kind ${kind}`);
  const id = newId('tsk');
  getDb()
    .insert(T)
    .values({ id, kind, company_id: companyId, rule_id: ruleId, parent_task_id: parentTaskId, attempt, status: 'queued', input, operator_note: operatorNote, created_at: Date.now() })
    .run();
  emitTaskEvent(id, 'status', { status: 'queued', kind, attempt, operator_note: operatorNote ?? undefined });
  log.info({ task_id: id, kind, company_id: companyId, rule_id: ruleId, attempt }, `task queued: ${kind}`);
  setImmediate(() => drainTasks().catch(() => {}));
  return getTask(id);
}

export function enqueueDiscovery(companyId, { operatorNote, parentTaskId, attempt } = {}) {
  const existing = getDb().select().from(T).where(and(eq(T.company_id, companyId), eq(T.kind, 'discovery'), inArray(T.status, ACTIVE))).get();
  if (existing) return existing;
  updateCompany(companyId, { status: 'pending_discovery' });
  return enqueueTask('discovery', { companyId, operatorNote, parentTaskId, attempt });
}

const inflight = new Map();
let draining = null;

/** Starts queued tasks up to the agent pool limit. In test mode, `wait` resolves when they finish. */
export async function drainTasks({ wait = false } = {}) {
  draining ??= (async () => {
    const limit = getSettings('scheduling').agentPool;
    runtime.pools.agent.limit = limit;
    const queued = getDb().select().from(T).where(eq(T.status, 'queued')).orderBy(asc(T.created_at)).all();
    const { llmAvailable } = await import('../agents/model.js');
    let started = 0;
    for (const task of queued) {
      if (inflight.size >= limit) break;
      if (!llmAvailable(getSettings('ai')[MODEL_SETTING[task.kind]])) continue; // waits for an API key
      inflight.set(task.id, runTask(task).finally(() => inflight.delete(task.id)));
      started++;
    }
    runtime.pools.agent.active = inflight.size;
    runtime.pools.agent.pending = queued.length - started;
    return started;
  })().finally(() => {
    draining = null;
  });
  const started = await draining;
  if (wait) {
    while (inflight.size) await Promise.allSettled([...inflight.values()]);
  }
  return { started };
}

async function runTask(task) {
  const reg = registry.register(task.id, { kind: 'task', task_kind: task.kind, company_id: task.company_id, label: `${task.kind} ${task.company_id ?? ''}` });
  const tlog = childLogger('task', { task_id: task.id, company_id: task.company_id, rule_id: task.rule_id });
  const { createAgentState, agentDiagnostics } = await import('../agents/loop.js');
  const modelId = getSettings('ai')[MODEL_SETTING[task.kind]];
  let lastFlush = 0;
  const state = createAgentState({
    taskId: task.id,
    modelId,
    log: tlog,
    onProgress: (s) => {
      if (Date.now() - lastFlush < 500) return;
      lastFlush = Date.now();
      patchTask(task.id, { steps: s.steps, input_tokens: s.inputTokens, output_tokens: s.outputTokens, cost_usd: s.costUsd });
    },
  });
  patchTask(task.id, { status: 'running', started_at: Date.now(), model: modelId });
  emitTaskEvent(task.id, 'status', { status: 'running', model: modelId });
  tlog.info({ kind: task.kind, model: modelId }, `task started: ${task.kind}`);
  let status = 'succeeded';
  let result = null;
  let error = null;
  try {
    result = await HANDLERS[task.kind](getTask(task.id), {
      signal: reg.signal,
      state,
      onKill: reg.onKill,
      log: tlog,
      setTaskMeta: (meta) => patchTask(task.id, meta),
    });
  } catch (err) {
    error = err;
    const entry = registry.get(task.id);
    if (entry?.killRequested) status = 'killed';
    else if (entry?.stopRequested || err.type === 'Cancelled') status = 'cancelled';
    else if (err.type === 'timed_out') status = 'timed_out';
    else status = 'failed';
  } finally {
    reg.done();
  }
  const diagnostics = agentDiagnostics(state);
  const finished = { status, finished_at: Date.now(), steps: state.steps, input_tokens: state.inputTokens, output_tokens: state.outputTokens, cost_usd: state.costUsd };
  if (error) {
    const d = errorDetail(error);
    Object.assign(finished, { error_type: error.type || error.name || 'Error', error_message: error.message, result: { error: d, detail: error.detail, diagnostics } });
    emitTaskEvent(task.id, 'status', { status, error_type: finished.error_type, message: error.message }, status === 'cancelled' ? 'warn' : 'error');
    tlog[status === 'cancelled' ? 'warn' : 'error']({ status, error_type: finished.error_type, err: d, steps: state.steps, cost_usd: state.costUsd }, `task ${status}: ${error.message}`);
    await onTaskFailed(task, status, error);
  } else {
    finished.result = { ...result, diagnostics };
    if (task.kind === 'discovery' && task.company_id) await resolveAlerts(task.company_id, ['discovery_failed']);
    emitTaskEvent(task.id, 'status', { status, summary: result?.summary });
    tlog.info({ steps: state.steps, cost_usd: Number(state.costUsd.toFixed(4)), tokens: state.inputTokens + state.outputTokens, by_phase: diagnostics.by_phase, failed_calls: diagnostics.failed_calls.length }, `task succeeded: ${result?.summary ?? task.kind}`);
  }
  patchTask(task.id, finished);
  forgetTask(task.id);
  setImmediate(() => drainTasks().catch(() => {}));
}

async function onTaskFailed(task, status, error) {
  if (task.kind !== 'discovery' || !task.company_id) return;
  const company = getCompany(task.company_id);
  if (!company) return;
  // A company that already has a working rule keeps running it; otherwise it needs a human.
  const next = company.active_rule_id ? (company.status === 'discovering' ? 'active' : company.status) : 'needs_review';
  updateCompany(company.id, { status: next, health_note: `Discovery ${status}: ${error.message}` });
  if (status === 'failed' || status === 'timed_out') {
    await raiseAlert({ companyId: company.id, kind: 'discovery_failed', level: 'error', message: `${company.name}: discovery ${status} (${error.type || 'error'}: ${error.message}). Open the task to see what the agent did, then retry with a note.` });
  }
}

export function stopTask(id) {
  const t = getTask(id);
  if (!t) return null;
  if (t.status === 'queued') {
    patchTask(id, { status: 'cancelled', finished_at: Date.now(), error_type: 'Cancelled', error_message: 'cancelled before it started' });
    emitTaskEvent(id, 'status', { status: 'cancelled' }, 'warn');
    if (t.kind === 'discovery') onTaskFailed(t, 'cancelled', { message: 'cancelled before it started' });
    return getTask(id);
  }
  if (registry.stop(id, 'stopped by user')) {
    patchTask(id, { status: 'cancelling' });
    emitTaskEvent(id, 'status', { status: 'cancelling' }, 'warn');
  }
  return getTask(id);
}

export function killTask(id) {
  const t = getTask(id);
  if (!t) return null;
  if (t.status === 'queued') return stopTask(id);
  if (registry.kill(id, { graceMs: 5000 })) emitTaskEvent(id, 'status', { status: 'killing' }, 'warn');
  return getTask(id);
}

/** Retries a finished task as a new task (same input), optionally with an operator note for the agent. */
export function retryTask(id, { operatorNote } = {}) {
  const t = getTask(id);
  if (!t) return null;
  if (ACTIVE.includes(t.status)) throw Object.assign(new Error('task is still running; stop it first'), { statusCode: 409 });
  const note = operatorNote ?? t.operator_note;
  if (t.kind === 'discovery') return enqueueDiscovery(t.company_id, { operatorNote: note, parentTaskId: t.id, attempt: t.attempt + 1 });
  return enqueueTask(t.kind, { companyId: t.company_id, ruleId: t.rule_id, input: t.input, parentTaskId: t.id, attempt: t.attempt + 1, operatorNote: note });
}

export function startTaskQueue() {
  onTick(() => drainTasks());
}
