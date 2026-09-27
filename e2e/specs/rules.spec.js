import { test, expect, configureDiscord } from '../fixtures/index.js';
import { ruleFor, seedCompany, nextTick } from '../fixtures/seed.js';

test.describe('companies and rules in the dashboard', () => {
  test('add a company with a hand-written rule, test it, save it, and run it', async ({ page, api, mocks, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await page.goto('/#/companies');
    await page.getByTestId('company-name').fill('Acme');
    await page.getByTestId('company-url').fill(`${mocks.portal.url}/html/acme`);
    await page.getByTestId('company-roles').fill('Site Reliability Engineer, Platform Engineer');
    await page.getByTestId('company-add').click();
    await expect(page.getByTestId('company-title')).toContainText('Acme');

    await page.getByTestId('tab-roles').click();
    await expect(page.getByTestId('company-roles')).toContainText('Site Reliability Engineer');

    await page.getByTestId('tab-rules').click();
    await page.getByTestId('rule-json').fill(JSON.stringify(ruleFor('html', mocks.portal.url), null, 2));
    await page.getByTestId('rule-test').click();
    await expect(page.getByTestId('rule-test-count')).toHaveText('25 jobs');
    await page.getByTestId('rule-save').click();
    await expect(page.getByTestId('rule-save-result')).toContainText('Saved');
    await expect(page.getByTestId('active-rule')).toContainText('url/html');

    await page.getByTestId('run-full').click();
    await expect(page.getByTestId('last-run-banner')).toContainText('Run ok: 25 jobs');
    await page.getByTestId('tab-jobs').click();
    await expect(page.getByTestId('job-row')).toHaveCount(25);
  });

  test('invalid rules are rejected with a clear error and nothing is saved', async ({ page, api, mocks }) => {
    const { company } = await api.post('/api/companies', { name: 'Broken', careers_url: `${mocks.portal.url}/html/acme`, discover: false });
    await page.goto(`/#/companies/${company.id}?tab=rules`);
    await page.getByTestId('rule-json').fill(JSON.stringify({ type: 'html', url: `${mocks.portal.url}/html/acme`, item_selector: 'li.nope', fields: { title: 'a', url: 'a@href' } }));
    await page.getByTestId('rule-save').click();
    await expect(page.getByTestId('rule-save-result')).toContainText('validation');
    await expect(page.getByTestId('rule-save-result')).toContainText('SelectorNotFound');
    await page.getByTestId('rule-json').fill('{"type":"bogus"}');
    await page.getByTestId('rule-test').click();
    await expect(page.getByTestId('rule-test-error').or(page.getByTestId('rule-test-button-error')).or(page.locator('.inline-error'))).toBeVisible();
    const d = await api.get(`/api/companies/${company.id}`);
    expect(d.rules).toHaveLength(0);
  });

  test('a worse rule cannot replace the active one without force; rollback restores the previous version', async ({ api, mocks }) => {
    const { company, rule } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    const worse = ruleFor('spa', mocks.portal.url, 'acme', { search: { mode: 'none' } });
    const res = await fetch(`${api.base}/api/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyId: company.id, spec: worse, activate: true }) });
    expect(res.status).toBe(409);
    const forced = await api.post('/api/rules', { companyId: company.id, spec: worse, activate: true, force: true, reason: 'testing' });
    expect((await api.get(`/api/companies/${company.id}`)).company.active_rule_id).toBe(forced.rule.id);
    const back = await api.post(`/api/companies/${company.id}/rollback`);
    expect(back.rule.id).toBe(rule.id);
    expect((await api.get(`/api/companies/${company.id}`)).company.active_rule_id).toBe(rule.id);
  });

  test('pause stops scheduled runs; resume restarts them', async ({ page, api, mocks }) => {
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await page.goto(`/#/companies/${company.id}`);
    await page.getByTestId('pause').click();
    await expect(page.getByTestId('resume')).toBeVisible();
    expect((await nextTick(api)).ran).toBe(0);
    await page.getByTestId('resume').click();
    await expect(page.getByTestId('pause')).toBeVisible();
    expect((await api.tick()).ran).toBe(1);
  });

  test('global roles can be added, edited and disabled from the Roles page', async ({ page, api }) => {
    await page.goto('/#/roles');
    await page.getByTestId('role-add-name-global').fill('DevOps Engineer');
    await page.getByTestId('role-add-synonyms-global').fill('SRE, Site Reliability Engineer');
    await page.getByTestId('role-add-global').click();
    await expect(page.getByTestId('role-row-DevOps Engineer')).toContainText('SRE');
    await page.getByTestId('role-edit-DevOps Engineer').click();
    await page.getByTestId('role-edit-exclude').fill('manager');
    await page.getByTestId('role-save').click();
    await expect(page.getByTestId('role-row-DevOps Engineer')).toContainText('manager');
    await page.getByTestId('role-enabled-DevOps Engineer').uncheck();
    await expect.poll(async () => (await api.get('/api/roles')).items[0].enabled).toBe(false);
  });

  test('the logs page shows run logs with context and redacts webhook secrets', async ({ page, api, mocks, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await page.goto(`/#/logs?company_id=${company.id}`);
    await expect(page.getByTestId('log-line').filter({ hasText: 'run ok' }).first()).toBeVisible();
    const all = await api.get('/api/logs?limit=1000&level=debug');
    expect(JSON.stringify(all)).not.toContain('token-jobs');
  });
});
