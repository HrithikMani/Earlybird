import crypto from 'node:crypto';
import { generateText, isStepCount } from 'ai';
import { getSettings } from '../settings/index.js';
import { emitTaskEvent, clip } from '../tasks/events.js';
import { providerOptionsFor } from './model.js';

/** Raised when a guard stops the agent (step/time/cost limit, loop detected). */
export class GuardTripped extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

export class TaskCancelled extends Error {
  constructor(reason) {
    super(reason || 'cancelled');
    this.type = 'Cancelled';
  }
}

/** Dollar cost of one step. Cache reads bill at ~0.1x and cache writes at 1.25x the input price. */
/** Short hash of a tool result, ignoring timestamps and generated snapshot file names. */
function fingerprintOutput(output) {
  if (output === undefined) return '-';
  const text = (typeof output === 'string' ? output : JSON.stringify(output) ?? '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.-]+Z?/g, '')
    .replace(/[\w-]+\.(yml|png|jpe?g)/g, '');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export function costOf(modelId, input, output, { cacheRead = 0, cacheWrite = 0 } = {}) {
  const p = getSettings('ai').prices[modelId];
  if (!p) return 0;
  const plain = Math.max(0, input - cacheRead - cacheWrite);
  return (plain * p.input + cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25 + output * p.output) / 1e6;
}

/**
 * Shared state for one task across agent turns (attempts): counts steps, tokens, cost; detects loops.
 */
export function createAgentState({ taskId, modelId, onProgress, log }) {
  const ai = getSettings('ai');
  return {
    taskId,
    modelId,
    limits: { maxSteps: ai.maxSteps, maxCostUsd: ai.maxCostUsd, maxWallMs: ai.maxWallTimeMin * 60000, repeat: ai.loopRepeatLimit, noProgress: ai.noProgressSteps },
    startedAt: Date.now(),
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    signatures: new Map(),
    lastProgressStep: 0,
    onProgress,
    log,
    phase: null,
    byPhase: {},
    failedCalls: [],
  };
}

/** Diagnostics for prompt tuning: where the steps/money went, and which tool calls failed. */
export function agentDiagnostics(state) {
  const round = (n) => Number(n.toFixed(4));
  return {
    by_phase: Object.fromEntries(Object.entries(state.byPhase).map(([k, v]) => [k, { ...v, cost_usd: round(v.cost_usd) }])),
    failed_calls: state.failedCalls,
    totals: { steps: state.steps, cost_usd: round(state.costUsd), input_tokens: state.inputTokens, output_tokens: state.outputTokens, cache_read_tokens: state.cacheReadTokens || 0, duration_ms: Date.now() - state.startedAt },
  };
}

/** Returns an error message when a tool result represents a failure (MCP isError, run_rule ok:false), else null. */
function toolErrorOf(output) {
  if (!output || typeof output !== 'object') return null;
  if (output.isError) {
    const text = (output.content || []).map((c) => c.text || '').join(' ');
    return text.replace(/^###\s*Error\s*/i, '').slice(0, 800) || 'tool reported an error';
  }
  if (output.ok === false) return `${output.error_type ? `${output.error_type}: ` : ''}${output.message || 'failed'}`;
  return null;
}

/**
 * Runs one agent turn with generateText + tools, enforcing the guards and streaming task events.
 * `signal` is the task's abort signal (Stop/Kill). Returns { text, responseMessages }.
 */
export async function runAgentTurn({ state, model, system, messages, tools, signal }) {
  const controller = new AbortController();
  let guard = null;
  const trip = (type, message) => {
    if (guard) return;
    guard = { type, message };
    emitTaskEvent(state.taskId, 'guard', { guard: type, message }, 'error');
    controller.abort(type);
  };
  const onTaskAbort = () => controller.abort(signal.reason || 'cancelled');
  if (signal?.aborted) throw new TaskCancelled(String(signal.reason || 'cancelled'));
  signal?.addEventListener('abort', onTaskAbort, { once: true });
  const remainingWall = state.limits.maxWallMs - (Date.now() - state.startedAt);
  if (remainingWall <= 0) throw new GuardTripped('timed_out', `wall time limit (${state.limits.maxWallMs / 60000} min) reached`);
  const wallTimer = setTimeout(() => trip('timed_out', `wall time limit (${state.limits.maxWallMs / 60000} min) reached`), remainingWall);
  const remainingSteps = state.limits.maxSteps - state.steps;
  if (remainingSteps <= 0) throw new GuardTripped('max_steps', `step limit (${state.limits.maxSteps}) reached`);

  const onStepFinish = (step) => {
    state.steps++;
    const inT = step.usage?.inputTokens ?? 0;
    const outT = step.usage?.outputTokens ?? 0;
    state.inputTokens += inT;
    state.outputTokens += outT;
    const details = step.usage?.inputTokenDetails ?? {};
    const stepCost = costOf(state.modelId, inT, outT, { cacheRead: details.cacheReadTokens ?? 0, cacheWrite: details.cacheWriteTokens ?? 0 });
    state.costUsd += stepCost;
    state.cacheReadTokens = (state.cacheReadTokens || 0) + (details.cacheReadTokens ?? 0);

    // The phase this step belongs to (the agent reports phases with report_phase).
    for (const tc of step.toolCalls || []) if (tc.toolName === 'report_phase' && tc.input?.phase) state.phase = tc.input.phase;
    const phase = state.phase || 'start';
    const bucket = (state.byPhase[phase] ??= { steps: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, tool_calls: 0, failed_calls: 0 });
    bucket.steps++;
    bucket.cost_usd += stepCost;
    bucket.input_tokens += inT;
    bucket.output_tokens += outT;

    const tools = (step.toolCalls || []).filter((tc) => tc.toolName !== 'report_phase').map((tc) => tc.toolName);
    bucket.tool_calls += tools.length;
    emitTaskEvent(state.taskId, 'step', { step: state.steps, phase, tools, input_tokens: inT, output_tokens: outT, cache_read_tokens: details.cacheReadTokens ?? 0, step_cost_usd: Number(stepCost.toFixed(4)), cost_usd: Number(state.costUsd.toFixed(4)), finish: step.finishReason });
    state.log?.info({ task_id: state.taskId, step: state.steps, phase, tools, input_tokens: inT, output_tokens: outT, cache_read_tokens: details.cacheReadTokens ?? 0, step_cost_usd: Number(stepCost.toFixed(4)), total_cost_usd: Number(state.costUsd.toFixed(4)) }, `agent step ${state.steps} (${phase})${tools.length ? `: ${tools.join(', ')}` : ''}`);
    if (step.text?.trim()) emitTaskEvent(state.taskId, 'model_text', { text: clip(step.text, 3000) });
    let progressed = false;
    // A call only counts as a repeat when the input AND the result are identical: observing a page that changed
    // (snapshot after typing, network log after a click) is progress, asking the same question for the same answer is not.
    const outputs = new Map((step.toolResults || []).map((tr) => [tr.toolCallId, tr.output]));
    const inputs = new Map((step.toolCalls || []).map((tc) => [tc.toolCallId, tc.input]));
    for (const tc of step.toolCalls || []) {
      const sig = `${tc.toolName}:${JSON.stringify(tc.input)}:${fingerprintOutput(outputs.get(tc.toolCallId))}`;
      const n = (state.signatures.get(sig) || 0) + 1;
      state.signatures.set(sig, n);
      if (n === 1) progressed = true;
      if (tc.toolName !== 'report_phase') emitTaskEvent(state.taskId, 'tool_call', { tool: tc.toolName, input: clip(tc.input, 1500), repeat: n, step: state.steps, phase });
      if (n >= state.limits.repeat) trip('loop_detected', `the agent called ${tc.toolName} with identical input and got the identical result ${n} times`);
    }
    const recordFailure = (toolName, input, error) => {
      bucket.failed_calls++;
      const f = { step: state.steps, phase, tool: toolName, input: clip(input, 600), error: String(error).slice(0, 800) };
      if (state.failedCalls.length < 100) state.failedCalls.push(f);
      state.log?.warn({ task_id: state.taskId, ...f }, `agent tool call failed at step ${state.steps} (${phase}): ${toolName}`);
      return f;
    };
    for (const tr of step.toolResults || []) {
      if (tr.toolName === 'report_phase') continue;
      const err = toolErrorOf(tr.output);
      if (err) recordFailure(tr.toolName, inputs.get(tr.toolCallId), err);
      emitTaskEvent(state.taskId, 'tool_result', { tool: tr.toolName, output: clip(tr.output, 2500), error: err || undefined, step: state.steps, phase }, err ? 'warn' : 'info');
    }
    // Tool calls that threw or had invalid input (AI SDK tool-error parts).
    for (const part of step.content || []) {
      if (part.type !== 'tool-error') continue;
      const f = recordFailure(part.toolName, part.input, part.error?.message ?? part.error);
      emitTaskEvent(state.taskId, 'tool_result', { tool: part.toolName, error: f.error, step: state.steps, phase }, 'warn');
    }
    if (progressed) state.lastProgressStep = state.steps;
    else if (state.steps - state.lastProgressStep >= state.limits.noProgress) trip('loop_detected', `no new tool calls in ${state.limits.noProgress} steps`);
    if (state.costUsd > state.limits.maxCostUsd) trip('cost_limit', `cost $${state.costUsd.toFixed(3)} exceeded the $${state.limits.maxCostUsd} limit`);
    state.onProgress?.(state);
  };

  try {
    const result = await generateText({
      model,
      system,
      messages,
      tools,
      stopWhen: isStepCount(remainingSteps),
      // Near the step budget, take the tools away so the agent commits what it has already tested
      // instead of running out mid-exploration.
      prepareStep: () => {
        const left = state.limits.maxSteps - state.steps;
        if (left > 2) return undefined;
        if (!state.budgetWarned) {
          state.budgetWarned = true;
          emitTaskEvent(state.taskId, 'guard', { guard: 'step_budget', message: `${left} step(s) left: asking the agent to answer now` }, 'warn');
        }
        return {
          toolChoice: 'none',
          system: `${system}\n\nYou are out of tool steps (${left} left). Do not call any tools. Reply now with the final JSON, using only rules you have already tested successfully with run_rule.`,
        };
      },
      abortSignal: controller.signal,
      providerOptions: providerOptionsFor(state.modelId),
      onStepFinish,
      maxRetries: 2,
    });
    const text = result.text || result.steps?.at?.(-1)?.text || '';
    const responseMessages = result.responseMessages ?? result.response?.messages ?? [];
    if (!text.trim() && state.steps >= state.limits.maxSteps) throw new GuardTripped('max_steps', `step limit (${state.limits.maxSteps}) reached before a final answer`);
    return { text, responseMessages };
  } catch (err) {
    if (guard) throw new GuardTripped(guard.type, guard.message);
    if (signal?.aborted) throw new TaskCancelled(String(signal.reason || 'cancelled'));
    throw err;
  } finally {
    clearTimeout(wallTimer);
    signal?.removeEventListener('abort', onTaskAbort);
  }
}
