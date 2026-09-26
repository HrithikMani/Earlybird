import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../support/app-server.mjs';
import { startMockPortal } from '../support/mock-portal/server.mjs';
import { startMockDiscord } from '../support/mock-discord.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class Api {
  constructor(base) {
    this.base = base;
  }
  async req(method, url, body) {
    const res = await fetch(this.base + url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`${method} ${url} -> ${res.status}: ${text}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }
  get(url) { return this.req('GET', url); }
  post(url, body = {}) { return this.req('POST', url, body); }
  put(url, body = {}) { return this.req('PUT', url, body); }
  del(url) { return this.req('DELETE', url); }
  sql(sql, params = []) { return this.post('/api/test/sql', { sql, params }); }
  tick() { return this.post('/api/test/tick'); }
  drainTasks() { return this.post('/api/test/drain-tasks'); }
  drainOutbox() { return this.post('/api/test/drain-outbox'); }
  advanceClock(ms) { return this.post('/api/test/advance-clock', { ms }); }
}

class MockPortal {
  constructor(url) {
    this.url = url;
  }
  async control(pathname, method = 'POST', body) {
    const res = await fetch(`${this.url}/_control${pathname}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  }
  reset() { return this.control('/reset'); }
  board(name, patch = {}) { return this.control(`/boards/${name}`, 'POST', patch); }
  addJob(name, job) { return this.control(`/boards/${name}/jobs`, 'POST', job); }
  removeJob(name, id) { return this.control(`/boards/${name}/jobs/${id}`, 'DELETE'); }
  hits() { return this.control('/hits', 'GET'); }
  pageUrl(kind, name, suffix = '') { return `${this.url}/${kind}/${name}${suffix}`; }
}

class DiscordInbox {
  constructor(mock) {
    this.mock = mock;
  }
  webhookUrl(name) { return this.mock.webhookUrl(name); }
  async messages() {
    return (await fetch(`${this.mock.url}/_control/messages`)).json();
  }
  /** All embeds sent, flattened: [{title, fields, webhook, ...}] */
  async embeds() {
    return (await this.messages()).flatMap((m) => (m.payload.embeds || []).map((e) => ({ ...e, webhook: m.webhook })));
  }
  reset() { return fetch(`${this.mock.url}/_control/reset`, { method: 'POST' }); }
  fail(opts) { return fetch(`${this.mock.url}/_control/fail`, { method: 'POST', body: JSON.stringify(opts) }); }
}

export const test = base.extend({
  mocks: [
    async ({}, use) => {
      const portal = await startMockPortal();
      const discord = await startMockDiscord();
      await use({ portal, discord });
      await portal.close();
      await discord.close();
    },
    { scope: 'worker' },
  ],
  app: [
    async ({ mocks }, use, workerInfo) => {
      const app = await startApp({ port: 3100 + workerInfo.parallelIndex, env: { EARLYBIRD_MOCK_PORTAL_URL: mocks.portal.url } });
      await use(app);
      await app.dispose();
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  baseURL: async ({ app }, use) => use(app.url),
  api: async ({ app }, use) => use(new Api(app.url)),
  mockPortal: async ({ mocks }, use) => use(new MockPortal(mocks.portal.url)),
  discordInbox: async ({ mocks }, use) => use(new DiscordInbox(mocks.discord)),
  cli: async ({ app }, use) => {
    /** Runs `eb <args> --json` against this worker's app. Resolves {code, json, stdout, stderr}. */
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(root, 'src', 'cli', 'eb.js'), ...args, '--json'], {
          cwd: root,
          env: { ...process.env, DATA_DIR: app.dataDir, EARLYBIRD_TEST: '1', EARLYBIRD_SKIP_DOTENV: '1', EARLYBIRD_API_URL: app.url, LOG_LEVEL: 'warn' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => {
          let json;
          try {
            json = JSON.parse(stdout);
          } catch {
            json = undefined;
          }
          resolve({ code, json, stdout, stderr });
        });
      });
    await use(run);
  },
  // Every test starts from a clean DB, clean mock portal and empty Discord inbox.
  cleanState: [
    async ({ api, mockPortal, discordInbox }, use) => {
      await api.post('/api/test/reset');
      await mockPortal.reset();
      await discordInbox.reset();
      await use();
    },
    { auto: true },
  ],
});

export { expect };

/** Configures Discord channels pointing at the mock Discord. */
export async function configureDiscord(api, discordInbox) {
  await api.put('/api/settings/discord', {
    channels: [
      { id: 'ch_jobs', name: 'jobs', webhookUrl: discordInbox.webhookUrl('jobs') },
      { id: 'ch_alerts', name: 'alerts', webhookUrl: discordInbox.webhookUrl('alerts') },
    ],
    jobsChannelId: 'ch_jobs',
    alertsChannelId: 'ch_alerts',
  });
}
