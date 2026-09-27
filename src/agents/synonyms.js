import { getSettings } from '../settings/index.js';
import { SynonymsSchema, extractJson } from '../schema/agent.js';
import { getRole } from '../roles/store.js';
import { emitTaskEvent } from '../tasks/events.js';
import { buildModel } from './model.js';
import { loadPrompt } from './prompts.js';
import { runAgentTurn } from './loop.js';

/** Suggests title synonyms / search terms for a role. The human accepts or edits them. */
export async function runSynonyms(task, { signal, state, setTaskMeta }) {
  const role = getRole(task.input.role_id);
  if (!role) throw new Error('role not found');
  const ai = getSettings('ai');
  const prompt = loadPrompt('suggest-synonyms', { role_name: role.name, current_synonyms: role.synonyms.join(', ') || '(none)', current_search_terms: role.search_terms.join(', ') });
  setTaskMeta({ prompt_file: prompt.file, prompt_hash: prompt.hash, model: ai.discoveryModel });
  const model = await buildModel(ai.discoveryModel, { vars: { role_name: role.name } });
  const { text } = await runAgentTurn({ state, model, system: 'Reply with only the requested JSON object.', messages: [{ role: 'user', content: prompt.text }], tools: {}, signal });
  const out = SynonymsSchema.parse(extractJson(text));
  emitTaskEvent(task.id, 'result', out);
  return { summary: `${out.synonyms.length} synonyms suggested for ${role.name}`, role_id: role.id, ...out };
}
