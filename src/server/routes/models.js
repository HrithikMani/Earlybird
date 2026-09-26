import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicApiKey } from '../../settings/index.js';
import { DEFAULT_PRICES } from '../../schema/settings.js';

const FALLBACK = Object.keys(DEFAULT_PRICES).map((id) => ({ id, display_name: id }));
let cache = { at: 0, key: '', models: null };
const TTL = 24 * 60 * 60 * 1000;

/** Lists Claude models from the Anthropic Models API (cached 24h), falling back to a built-in list. */
export async function listModels({ refresh = false } = {}) {
  const key = getAnthropicApiKey();
  if (!key) return { source: 'builtin', models: FALLBACK };
  if (!refresh && cache.models && cache.key === key && Date.now() - cache.at < TTL) return { source: 'api', models: cache.models };
  try {
    const client = new Anthropic({ apiKey: key, timeout: 10000, maxRetries: 1 });
    const models = [];
    for await (const m of client.models.list({ limit: 100 })) models.push({ id: m.id, display_name: m.display_name });
    cache = { at: Date.now(), key, models };
    return { source: 'api', models };
  } catch (e) {
    return { source: 'builtin', models: FALLBACK, error: e.message };
  }
}

export default async function modelRoutes(app) {
  app.get('/api/models', async (req) => listModels({ refresh: req.query.refresh === '1' }));
}
