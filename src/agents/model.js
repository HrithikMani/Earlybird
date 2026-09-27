import fs from 'node:fs';
import path from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getAnthropicApiKey, getSettings } from '../settings/index.js';
import { config, ROOT } from '../config.js';

export class NoApiKey extends Error {
  constructor() {
    super('No Anthropic API key configured (Settings → AI).');
    this.type = 'NoApiKey';
  }
}

export const isMockModel = (id) => typeof id === 'string' && id.startsWith('mock:');

/** True when agent tasks can run (API key present, or a scripted mock model in test mode). */
export function llmAvailable(modelId) {
  return (config.isTest && isMockModel(modelId)) || !!getAnthropicApiKey();
}

/** Provider options for Claude: adaptive thinking + effort where the model supports them. */
export function providerOptionsFor(modelId) {
  const { effort } = getSettings('ai');
  const legacy = /haiku|claude-3|claude-(opus|sonnet)-4-(0|1|5)\b|-20\d{6}$/.test(modelId);
  const anthropic = {};
  if (!legacy) anthropic.thinking = { type: 'adaptive' };
  if (effort !== 'default' && !/haiku|claude-3/.test(modelId)) anthropic.effort = effort;
  return Object.keys(anthropic).length ? { anthropic } : undefined;
}

/** Builds the AI SDK language model for a model id from Settings. `mock:<script>` works in test mode only. */
export async function buildModel(modelId, { vars = {} } = {}) {
  if (isMockModel(modelId)) {
    if (!config.isTest) throw new Error('mock models are only available in test mode');
    return createScriptedModel(modelId.slice(5), vars);
  }
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new NoApiKey();
  return createAnthropic({ apiKey })(modelId);
}

// ---------------------------------------------------------------------------------------------
// Scripted mock model for e2e tests: replays e2e/agent-scripts/<name>.json step by step.
// Each step: { text?, toolCalls?: [{ name, input }], delayMs?, repeat?: n, final?: object }
// Strings may contain {{portal}}, {{careers_url}}, {{company_name}}, {{attempt}} placeholders.

function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

async function createScriptedModel(name, vars) {
  const { MockLanguageModelV4 } = await import('ai/test');
  const file = path.join(ROOT, 'e2e', 'agent-scripts', `${name}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const steps = [];
  for (const s of raw.steps) for (let i = 0; i < (s.repeat || 1); i++) steps.push(s);
  let i = 0;
  let callSeq = 0;
  const allVars = { portal: config.mockPortalUrl, ...vars };
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: `mock:${name}`,
    doGenerate: async (options) => {
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      if (step.delayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, step.delayMs);
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      const content = [];
      if (step.text) content.push({ type: 'text', text: fill(step.text, allVars) });
      if (step.final) content.push({ type: 'text', text: '```json\n' + JSON.stringify(fill(step.final, allVars), null, 2) + '\n```' });
      for (const tc of step.toolCalls || []) {
        content.push({ type: 'tool-call', toolCallId: `call_${++callSeq}`, toolName: tc.name, input: JSON.stringify(fill(tc.input ?? {}, allVars)) });
      }
      const hasTools = (step.toolCalls || []).length > 0;
      return {
        content,
        finishReason: { unified: hasTools ? 'tool-calls' : 'stop', raw: hasTools ? 'tool_use' : 'end_turn' },
        usage: { inputTokens: { total: step.inputTokens ?? 1000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: step.outputTokens ?? 200, text: undefined, reasoning: undefined } },
        warnings: [],
      };
    },
  });
}
