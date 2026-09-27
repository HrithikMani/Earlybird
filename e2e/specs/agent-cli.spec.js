import fs from 'node:fs';
import path from 'node:path';
import { test, expect, configureDiscord } from '../fixtures/index.js';
import { ruleFor, seedCompany, nextTick } from '../fixtures/seed.js';

test.describe('Agent CLI (npm run eb) while the app is running', () => {
  test.setTimeout(120_000);

  const draft = (app, name, content) => {
    const file = path.join(app.dataDir, 'drafts', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return file;
  };

  test('company add/list/show and schema', async ({ cli }) => {
    const add = await cli(['company', 'add', '--name', 'Tesla', '--url', 'https://www.tesla.com/careers/search', '--roles', 'AI Engineer, Infrastructure Engineer']);
    expect(add.code).toBe(0);
    const id = add.json.company.id;
    const show = await cli(['company', 'show', id]);
    expect(show.json.search_terms).toEqual(['AI Engineer', 'Infrastructure Engineer']);
    const list = await cli(['company', 'list']);
    expect(list.json.items.map((c) => c.name)).toContain('Tesla');
    const schema = await cli(['schema', 'rule']);
    expect(schema.code).toBe(0);
    expect(JSON.stringify(schema.json)).toContain('item_selector');
  });

  test('rule test → import --activate is picked up by the running app without a restart', async ({ cli, app, api, mocks, mockPortal, discordInbox, page }) => {
    await configureDiscord(api, discordInbox);
    const { company } = await api.post('/api/companies', { name: 'Acme', careers_url: `${mocks.portal.url}/html/acme`, discover: false, role_mode: 'all_jobs' });
    const file = draft(app, 'acme.json', ruleFor('html', mocks.portal.url));

    const t = await cli(['rule', 'test', '--file', file, '--company', company.id]);
    expect(t.code).toBe(0);
    expect(t.json.job_count).toBe(25);

    const imp = await cli(['rule', 'import', '--file', file, '--company', company.id, '--activate']);
    expect(imp.code).toBe(0);
    expect(imp.json.activated).toBe(true);
    await page.goto(`/#/companies/${company.id}?tab=rules`);
    await expect(page.getByTestId('active-rule')).toContainText(imp.json.rule.id);

    await api.tick(); // silent baseline
    expect(await discordInbox.embeds()).toHaveLength(0);
    await mockPortal.addJob('acme', { id: 'cli1', title: 'Compiler Engineer' });
    await nextTick(api);
    expect((await discordInbox.embeds()).map((e) => e.title)).toEqual(['Compiler Engineer']);
    const logs = await api.get('/api/logs?scope=cli');
    expect(logs.items.some((l) => l.msg === 'rule imported (cli)')).toBe(true);
  });

  test('a failing import never changes the active rule', async ({ cli, app, api, mocks }) => {
    const { company, rule } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    const bad = draft(app, 'bad.json', { type: 'html', url: `${mocks.portal.url}/html/acme`, item_selector: 'li.nope', fields: { title: 'a', url: 'a@href' } });
    const res = await cli(['rule', 'import', '--file', bad, '--company', company.id, '--activate']);
    expect(res.code).toBe(1);
    expect(res.json.error).toContain('validation failed');
    const invalid = draft(app, 'invalid.json', '{ not json');
    expect((await cli(['rule', 'import', '--file', invalid, '--company', company.id])).code).toBe(1);
    expect((await api.get(`/api/companies/${company.id}`)).company.active_rule_id).toBe(rule.id);
  });

  test('a worse rule needs --force --reason; rollback restores the previous one', async ({ cli, app, api, mocks }) => {
    const { company, rule } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    const worse = draft(app, 'spa.json', ruleFor('spa', mocks.portal.url, 'acme', { search: { mode: 'none' } }));
    const refused = await cli(['rule', 'import', '--file', worse, '--company', company.id, '--activate']);
    expect(refused.code).toBe(1);
    expect(refused.json.error).toContain('scores');
    const forced = await cli(['rule', 'import', '--file', worse, '--company', company.id, '--activate', '--force', '--reason', 'testing the browser rule']);
    expect(forced.code).toBe(0);
    const back = await cli(['rule', 'rollback', company.id]);
    expect(back.json.rule.id).toBe(rule.id);
    expect((await api.get(`/api/companies/${company.id}`)).company.active_rule_id).toBe(rule.id);
  });

  test('a script rule can be tested and imported from a .mjs file', async ({ cli, app, api, mocks }) => {
    const { company } = await api.post('/api/companies', { name: 'Tokenco', careers_url: `${mocks.portal.url}/token/acme/jobs`, discover: false, role_mode: 'all_jobs' });
    const code = `export default async function fetchJobs({ fetch }) {
  const base = '${mocks.portal.url}/token/acme';
  const { token } = await (await fetch(base + '/session')).json();
  const d = await (await fetch(base + '/jobs', { headers: { 'x-session-token': token } })).json();
  return d.data.items.map((it) => ({ external_id: it.key, title: it.label, url: '${mocks.portal.url}' + it.link, location: it.where, posted_at: it.ts }));
}\n`;
    const file = draft(app, 'token.mjs', code);
    const t = await cli(['rule', 'test', '--file', file, '--company', company.id]);
    expect(t.json.job_count).toBe(25);
    const imp = await cli(['rule', 'import', '--file', file, '--company', company.id, '--activate']);
    expect(imp.code).toBe(0);
    expect(imp.json.rule.type).toBe('script');
    expect((await api.tick()).runs[0].status).toBe('ok');
  });

  test('verify precheck + save stores an external verification like an in-app one', async ({ cli, app, api, mocks, page }) => {
    const { rule } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    const pre = await cli(['verify', 'precheck', rule.id, '--window', '24h']);
    expect(pre.json.full.ok).toBe(true);
    expect(pre.json.full.job_count).toBe(25);
    const report = draft(app, 'report.json', { verdict: 'healthy', window: '24h', notes: 'checked from Copilot', portal_recent_jobs: [], missing: [], suggested_action: 'none' });
    const saved = await cli(['verify', 'save', rule.id, '--file', report, '--window', '24h']);
    expect(saved.code).toBe(0);
    await page.goto(`/#/rules/${rule.id}`);
    await expect(page.getByTestId('rule-verifications')).toContainText('cli');
    await expect(page.getByTestId('verification-verdict')).toHaveText('healthy');
    const badReport = draft(app, 'bad-report.json', { verdict: 'great' });
    expect((await cli(['verify', 'save', rule.id, '--file', badReport])).code).toBe(1);
  });

  test('task commands talk to the running app', async ({ cli, api, mocks }) => {
    await api.put('/api/settings/ai', { discoveryModel: 'mock:discover-bad' });
    await api.post('/api/companies', { name: 'Bad', careers_url: `${mocks.portal.url}/html/acme` });
    await api.drainTasks();
    const list = await cli(['task', 'list']);
    expect(list.json.items[0].status).toBe('failed');
    await api.put('/api/settings/ai', { discoveryModel: 'mock:discover-acme' });
    const retry = await cli(['task', 'retry', list.json.items[0].id, '--note', 'from the CLI']);
    expect(retry.code).toBe(0);
    await api.drainTasks();
    const show = await cli(['task', 'show', retry.json.task.id]);
    expect(show.json.task.status).toBe('succeeded');
    expect(show.json.task.operator_note).toBe('from the CLI');
  });
});
