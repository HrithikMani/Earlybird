import { test, expect, configureDiscord } from '../fixtures/index.js';
import { seedCompany } from '../fixtures/seed.js';

test.describe('verification (scripted mock LLM)', () => {
  test.setTimeout(120_000);

  test('Verify from the company page produces a healthy verdict shown on the rule page', async ({ page, api, mocks }) => {
    await api.put('/api/settings/ai', { verifyModel: 'mock:verify-healthy' });
    const { company, rule } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await page.goto(`/#/companies/${company.id}`);
    await page.getByTestId('verify').click();
    await api.drainTasks();
    await page.goto(`/#/rules/${rule.id}`);
    await expect(page.getByTestId('verification-verdict')).toHaveText('healthy');
    const tasks = await api.get(`/api/tasks?company_id=${company.id}`);
    const t = await api.get(`/api/tasks/${tasks.items[0].id}`);
    expect(t.events.some((e) => e.type === 'tool_result' && e.data.tool === 'precheck')).toBe(true);
    expect(t.events.some((e) => e.type === 'tool_call' && e.data.tool === 'get_recent_jobs')).toBe(true);
  });

  test('a missing_recent verdict raises an alert with the missing job', async ({ api, mocks, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await api.put('/api/settings/ai', { verifyModel: 'mock:verify-missing' });
    const { rule } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.post(`/api/rules/${rule.id}/verify`, { window: '10m' });
    await api.drainTasks();
    const r = await api.get(`/api/rules/${rule.id}`);
    expect(r.verifications[0].verdict).toBe('missing_recent');
    expect(r.verifications[0].window).toBe('10m');
    const alert = (await discordInbox.embeds()).find((e) => e.webhook === 'alerts');
    expect(alert.description).toContain('Quantum Engineer');
  });

  test('role synonyms can be suggested by the AI', async ({ api }) => {
    await api.put('/api/settings/ai', { discoveryModel: 'mock:synonyms' });
    const { role } = await api.post('/api/roles', { name: 'DevOps Engineer', scope: 'global' });
    const { task } = await api.post(`/api/roles/${role.id}/suggest-synonyms`);
    await api.drainTasks();
    const t = (await api.get(`/api/tasks/${task.id}`)).task;
    expect(t.status).toBe('succeeded');
    expect(t.result.synonyms).toContain('SRE');
  });
});
