import { test, expect, configureDiscord } from '../fixtures/index.js';
import { addGlobalRole, nextTick } from '../fixtures/seed.js';

const useModel = (api, name, extra = {}) => api.put('/api/settings/ai', { discoveryModel: `mock:${name}`, verifyModel: `mock:${name}`, ...extra });

async function addCompanyInUi(page, portalUrl, name = 'Acme') {
  await page.goto('/#/companies');
  await page.getByTestId('company-name').fill(name);
  await page.getByTestId('company-url').fill(`${portalUrl}/spa/acme`);
  await page.getByTestId('company-add').click();
  await expect(page.getByTestId('company-title')).toContainText(name);
  return page.url().split('/companies/')[1].split('?')[0];
}

test.describe('discovery (scripted mock LLM)', () => {
  test.setTimeout(120_000);

  test('adding a company runs discovery end to end: explore → analyze → build → test → commit, then new jobs reach Discord', async ({ page, api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await addGlobalRole(api, 'Software Engineer');
    await addGlobalRole(api, 'DevOps Engineer');
    await useModel(api, 'discover-acme');

    const companyId = await addCompanyInUi(page, mocks.portal.url);
    await api.drainTasks();

    await page.getByTestId('tab-tasks').click();
    await page.getByTestId('task-row').first().click();
    await expect(page.getByTestId('task-detail-status')).toHaveText('succeeded');
    await expect(page.getByTestId('task-summary')).toContainText('Rules committed and ready for scheduled runs');
    for (const p of ['explore', 'analyze', 'build', 'test', 'commit']) await expect(page.getByTestId(`phase-${p}`)).toHaveClass(/tone-ok/);
    await expect(page.getByTestId('event-tool_call').filter({ hasText: 'browser_navigate' })).toBeVisible();
    await expect(page.getByTestId('event-validation')).toHaveCount(2);

    const d = await api.get(`/api/companies/${companyId}`);
    expect(d.company.status).toBe('active');
    expect(d.active_rule.strategy).toBe('url'); // cheaper API rule wins when both are fresh + complete
    expect(d.fallback_rule.strategy).toBe('playwright');
    expect(d.active_rule.score.total).toBeGreaterThan(d.fallback_rule.score.total);
    expect(d.runs[0].trigger).toBe('baseline');
    expect(await discordInbox.embeds()).toHaveLength(0);

    await mockPortal.addJob('acme', { id: 'n1', title: 'Senior DevOps Engineer' });
    await mockPortal.addJob('acme', { id: 'n2', title: 'Office Manager' });
    await nextTick(api);
    expect((await discordInbox.embeds()).map((e) => e.title)).toEqual(['Senior DevOps Engineer']);
  });

  test('when no candidate passes, the company needs review, an alert is sent, and a retry with a note succeeds', async ({ page, api, mocks, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await useModel(api, 'discover-bad');
    const companyId = await addCompanyInUi(page, mocks.portal.url);
    await api.drainTasks();
    const d = await api.get(`/api/companies/${companyId}`);
    expect(d.company.status).toBe('needs_review');
    expect(d.tasks[0].status).toBe('failed');
    expect(d.tasks[0].error_type).toBe('no_valid_rule');
    expect((await discordInbox.embeds()).some((e) => e.webhook === 'alerts' && e.title.includes('discovery failed'))).toBe(true);

    await useModel(api, 'discover-acme');
    await page.goto(`/#/tasks/${d.tasks[0].id}`);
    await expect(page.getByTestId('event-validation').first()).toContainText('failed');
    await page.getByTestId('retry-note').fill('Use the JSON search API, not the HTML page');
    await page.getByTestId('task-retry').click();
    await expect(page.getByTestId('task-detail-status')).toBeVisible();
    await api.drainTasks();
    await page.reload();
    await expect(page.getByTestId('task-detail-status')).toHaveText('succeeded');
    await expect(page.getByText('Use the JSON search API, not the HTML page')).toBeVisible();
    const d2 = await api.get(`/api/companies/${companyId}`);
    expect(d2.company.status).toBe('active');
    expect(d2.tasks[0].attempt).toBe(2);
    expect(d2.alerts.filter((a) => a.kind === 'discovery_failed' && a.state === 'open')).toHaveLength(0);
    await expect(page.getByTestId('task-summary-usage')).toContainText('steps');
  });

  test('validation feedback lets the agent fix its rule within the same task', async ({ api, mocks }) => {
    await useModel(api, 'discover-fix');
    const { company } = await api.post('/api/companies', { name: 'Fixy', careers_url: `${mocks.portal.url}/html/acme` });
    await api.drainTasks();
    const d = await api.get(`/api/companies/${company.id}`);
    expect(d.tasks[0].status).toBe('succeeded');
    const t = await api.get(`/api/tasks/${d.tasks[0].id}`);
    const validations = t.events.filter((e) => e.type === 'validation').map((e) => e.data.passed);
    expect(validations).toEqual([false, true]);
    expect(d.active_rule.type).toBe('html');
  });

  test('a script rule can be generated, waits for approval when required, and runs in the sandbox', async ({ page, api, mocks }) => {
    await useModel(api, 'discover-script');
    await api.put('/api/settings/scripts', { requireApproval: true });
    const { company } = await api.post('/api/companies', { name: 'Tokenco', careers_url: `${mocks.portal.url}/token/acme/jobs`, role_mode: 'all_jobs' });
    await api.drainTasks();
    let d = await api.get(`/api/companies/${company.id}`);
    expect(d.company.status).toBe('needs_review');
    expect(d.tasks[0].result.summary).toContain('waiting for approval');
    const ruleId = d.tasks[0].result.pending_approval_rule_id;

    await page.goto(`/#/rules/${ruleId}`);
    await expect(page.getByTestId('rule-code-view')).toContainText('x-session-token');
    await page.getByTestId('rule-approve').click();
    await expect(page.getByTestId('rule-slot')).toHaveText('active');
    const tick = await api.tick();
    expect(tick.runs[0].status).toBe('ok');
    d = await api.get(`/api/companies/${company.id}`);
    expect(d.company.open_jobs).toBe(25);
  });
});
