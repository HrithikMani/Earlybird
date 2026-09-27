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

export function costOf(modelId, input, output) {
  const p = getSettings('ai').prices[modelId];
  if (!p) return 0;
  return (input * p.input + output * p.output) / 1e6;
}

/**
 * Shared state for one task across agent turns (attempts): counts steps, tokens, cost; detects loops.
 */
export function createAgentState({ taskId, modelId, onProgress }) {
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
  };
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
    state.costUsd = costOf(state.modelId, state.inputTokens, state.outputTokens);
    emitTaskEvent(state.taskId, 'step', { step: state.steps, input_tokens: inT, output_tokens: outT, cost_usd: Number(state.costUsd.toFixed(4)), finish: step.finishReason });
    if (step.text?.trim()) emitTaskEvent(state.taskId, 'model_text', { text: clip(step.text, 3000) });
    let progressed = false;
    for (const tc of step.toolCalls || []) {
      const sig = `${tc.toolName}:${JSON.stringify(tc.input)}`;
      const n = (state.signatures.get(sig) || 0) + 1;
      state.signatures.set(sig, n);
      if (n === 1) progressed = true;
      if (tc.toolName !== 'report_phase') emitTaskEvent(state.taskId, 'tool_call', { tool: tc.toolName, input: clip(tc.input, 1500), repeat: n });
      if (n >= state.limits.repeat) trip('loop_detected', `the agent called ${tc.toolName} with identical input ${n} times`);
    }
    for (const tr of step.toolResults || []) {
      if (tr.toolName === 'report_phase') continue;
      emitTaskEvent(state.taskId, 'tool_result', { tool: tr.toolName, output: clip(tr.output, 2500) });
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
