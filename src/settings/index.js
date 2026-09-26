import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { SettingsSections, SECTION_NAMES, sectionDefaults } from '../schema/settings.js';
import { maskSecret, isMasked } from '../log/redact.js';
import { config } from '../config.js';

export const settingsEvents = new EventEmitter();

const cache = new Map();

function load(section) {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, section)).get();
  const parsed = SettingsSections[section].safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : sectionDefaults(section);
}

/** Returns a settings section with defaults applied (cached). */
export function getSettings(section) {
  if (!SettingsSections[section]) throw new Error(`unknown settings section: ${section}`);
  if (!cache.has(section)) cache.set(section, load(section));
  return cache.get(section);
}

export function getAllSettings() {
  return Object.fromEntries(SECTION_NAMES.map((s) => [s, getSettings(s)]));
}

/** The API key actually used: Settings first, .env as bootstrap fallback. */
export function getAnthropicApiKey() {
  return getSettings('ai').apiKey || config.anthropicApiKeyEnv || '';
}

/** Merges a patch into a section, validates, saves and emits 'change'. Masked secrets keep their stored value. */
export function updateSettings(section, patch) {
  const current = getSettings(section);
  const merged = { ...current, ...unmask(section, patch, current) };
  const parsed = SettingsSections[section].parse(merged);
  const now = Date.now();
  getDb()
    .insert(schema.settings)
    .values({ key: section, value: parsed, updated_at: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: parsed, updated_at: now } })
    .run();
  cache.set(section, parsed);
  settingsEvents.emit('change', { section, value: parsed });
  return parsed;
}

function unmask(section, patch, current) {
  const out = { ...patch };
  if (section === 'ai' && isMasked(out.apiKey)) out.apiKey = current.apiKey;
  if (section === 'discord' && Array.isArray(out.channels)) {
    out.channels = out.channels.map((ch) => {
      if (!isMasked(ch.webhookUrl)) return ch;
      const prev = current.channels.find((c) => c.id === ch.id);
      return { ...ch, webhookUrl: prev?.webhookUrl ?? '' };
    });
  }
  return out;
}

/** Settings safe to send to the browser (secrets masked). */
export function publicSettings() {
  const all = structuredClone(getAllSettings());
  all.ai.apiKey = maskSecret(all.ai.apiKey);
  all.ai.apiKeySource = getSettings('ai').apiKey ? 'settings' : config.anthropicApiKeyEnv ? 'env' : 'none';
  all.discord.channels = all.discord.channels.map((c) => ({ ...c, webhookUrl: maskSecret(c.webhookUrl) }));
  return all;
}

export function clearSettingsCache() {
  cache.clear();
}

/** Human-readable warnings about missing configuration, shown on the dashboard. */
export function configWarnings() {
  const warnings = [];
  if (!getAnthropicApiKey()) warnings.push({ id: 'no_api_key', message: 'No Anthropic API key set. Discovery and verification are disabled until you add one in Settings → AI.' });
  const d = getSettings('discord');
  const jobs = d.channels.find((c) => c.id === d.jobsChannelId);
  if (!jobs?.webhookUrl) warnings.push({ id: 'no_jobs_webhook', message: 'No Discord jobs channel configured. New jobs are stored but not sent (Settings → Discord).' });
  const alerts = d.channels.find((c) => c.id === d.alertsChannelId);
  if (!alerts?.webhookUrl) warnings.push({ id: 'no_alerts_webhook', message: 'No Discord alerts channel configured (Settings → Discord).' });
  return warnings;
}
