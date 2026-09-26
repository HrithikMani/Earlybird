// Runs migrations and (optionally) asks for the API key, Discord webhooks and first roles.
import readline from 'node:readline/promises';
import { ensureDataDirs } from '../src/config.js';
import { openDb, closeDb } from '../src/db/index.js';
import { getSettings, updateSettings, getAnthropicApiKey } from '../src/settings/index.js';
import { listRoles, createRole } from '../src/roles/store.js';
import { ok, warn } from './lib.mjs';

const yes = process.argv.includes('--yes');

ensureDataDirs();
openDb();
ok('Database ready (migrations applied)');

if (!yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim();
  console.log('\nOptional: press Enter to skip any question. Everything can be changed later in the dashboard.\n');

  if (!getAnthropicApiKey()) {
    const key = await ask('Anthropic API key (sk-ant-…): ');
    if (key) {
      updateSettings('ai', { apiKey: key });
      ok('API key saved');
    }
  }

  const discord = getSettings('discord');
  if (!discord.jobsChannelId) {
    const jobs = await ask('Discord webhook URL for NEW JOBS: ');
    const alerts = await ask('Discord webhook URL for ALERTS (Enter = same as jobs): ');
    if (jobs) {
      const channels = [{ id: 'ch_jobs', name: 'jobs', webhookUrl: jobs }];
      if (alerts && alerts !== jobs) channels.push({ id: 'ch_alerts', name: 'alerts', webhookUrl: alerts });
      updateSettings('discord', { channels, jobsChannelId: 'ch_jobs', alertsChannelId: alerts && alerts !== jobs ? 'ch_alerts' : 'ch_jobs' });
      ok('Discord channels saved');
    }
  }

  if (listRoles({ scope: 'global' }).length === 0) {
    const roles = await ask('Roles to track, comma separated (e.g. Software Engineer, DevOps Engineer): ');
    for (const name of roles.split(',').map((s) => s.trim()).filter(Boolean)) {
      createRole({ name, scope: 'global' });
    }
    if (roles) ok('Roles saved');
  }
  rl.close();
} else {
  warn('Skipped questions (--yes). Configure the API key, Discord and roles in the dashboard.');
}
closeDb();
