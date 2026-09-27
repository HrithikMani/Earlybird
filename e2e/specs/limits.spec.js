import { test, expect } from '../fixtures/index.js';
import { seedCompany } from '../fixtures/seed.js';

test.describe('job cap, age window and AI diagnostics', () => {
  test.setTimeout(120_000);

  test('rules read only the newest N jobs per company (older pages are never fetched)', async ({ api, mocks, mockPortal }) => {
    await api.put('/api/settings/filters', { maxJobsPerCompany: 10 });
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'searchAll', role_mode: 'all_jobs' });
    await mockPortal.reset();
    await api.tick();
    const offsets = (await mockPortal.hits()).filter((h) => h.kind === 'api').map((h) => Number(h.query.offset));
    expect(offsets).toEqual([0]);
    const jobs = (await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items;
    expect(jobs).toHaveLength(10);
    expect(jobs.map((j) => j.external_id)).toContain('REQ-1000'); // the newest one
  });

  test('cleanup trims existing listings to the newest N and to the age window', async ({ api, mocks }) => {
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    expect((await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items).toHaveLength(25);
    await api.put('/api/settings/filters', { maxJobsPerCompany: 12 });
    const res = await api.post('/api/maintenance/cleanup');
    expect(res.trimmed).toBe(13);
    // Seeded jobs are 5h apart; with a 1-day window only the ~4 newest remain.
    await api.put('/api/settings/filters', { maxJobAgeDays: 1 });
    await api.post('/api/maintenance/cleanup');
    const left = (await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items;
    expect(left.length).toBeLessThanOrEqual(5);
    expect(left.every((j) => j.posted_at > Date.now() - 86400000)).toBe(true);
    const seen = await api.sql('select count(*) n from seen_jobs where company_id = ?', [company.id]);
    expect(seen.rows[0].n).toBe(25); // all still remembered: none can be re-sent later
  });

  test('a location preference keeps only jobs in that country ("United States" matches USA / state codes)', async ({ page, api, mocks, mockPortal, discordInbox }) => {
    const { configureDiscord } = await import('../fixtures/index.js');
    await configureDiscord(api, discordInbox);
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs', companyExtra: { source_filters: { location: 'United States' } } });
    await api.tick();
    const listed = (await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items;
    expect(listed.some((j) => j.location === 'London, UK')).toBe(false);
    expect(listed.some((j) => j.location === 'Austin, TX')).toBe(true);
    expect(listed.some((j) => j.location === 'Remote')).toBe(true); // no country info: kept
    const run = (await api.get(`/api/companies/${company.id}/runs`)).items[0];
    expect(run.stats.skipped.other_location).toBe(4);

    await mockPortal.addJob('acme', { id: 'hyd1', title: 'Software Engineer', location: 'IN, TS, Hyderabad' });
    await mockPortal.addJob('acme', { id: 'sea1', title: 'Software Engineer', location: 'Seattle, Washington, USA' });
    await api.advanceClock(11 * 60000);
    await api.tick();
    expect((await discordInbox.embeds()).map((e) => e.fields.find((f) => f.name === 'Location').value)).toEqual(['Seattle, Washington, USA']);

    // Changing the location on the company page cleans up right away.
    await page.goto(`/#/companies/${company.id}?tab=roles`);
    await page.getByTestId('company-location-edit').fill('Texas');
    await page.getByTestId('company-location-save').click();
    await expect.poll(async () => (await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items.every((j) => /TX|Remote/.test(j.location))).toBe(true);
  });

  test('activating a new rule clears listings the new rule no longer returns', async ({ api, mocks, mockPortal }) => {
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    expect((await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items).toHaveLength(25);
    await mockPortal.board('acme', { seed: 3 }); // e.g. the new rule is narrower (US only)
    const { ruleFor } = await import('../fixtures/seed.js');
    await api.post('/api/rules', { companyId: company.id, spec: ruleFor('html', mocks.portal.url), activate: true, force: true, reason: 'narrower rule' });
    await api.advanceClock(11 * 60000);
    const t = await api.tick();
    expect(t.runs[0].status).toBe('ok');
    expect((await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items).toHaveLength(3);
    const seen = await api.sql('select count(*) n from seen_jobs where company_id = ?', [company.id]);
    expect(seen.rows[0].n).toBeGreaterThanOrEqual(25); // still remembered, never re-sent
  });

  test('lists without dates get datePosted from the job detail pages (new jobs only), so the age window works', async ({ api, mocks, mockPortal, discordInbox }) => {
    const { configureDiscord } = await import('../fixtures/index.js');
    await configureDiscord(api, discordInbox);
    const noDates = { fields: { id: '@data-job-id', title: 'a.job-title', url: 'a.job-title@href', location: '.loc' } };
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'html', role_mode: 'all_jobs', rule: noDates });
    await api.tick();
    const listed = (await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items;
    expect(listed.length).toBeGreaterThan(20);
    expect(listed.every((j) => j.posted_at && j.posted_at_raw.includes('detail page'))).toBe(true);
    const baseline = (await api.get(`/api/companies/${company.id}/runs`)).items[0];
    expect(baseline.stats.enrich.found).toBe(baseline.stats.enrich.tried);

    // A "new" job whose detail page says it was posted 30 days ago: remembered, never listed or sent.
    await mockPortal.addJob('acme', { id: 'old30', title: 'Legacy Systems Engineer', posted_at: Date.now() - 30 * 86400000 });
    await mockPortal.addJob('acme', { id: 'new1', title: 'Fresh Systems Engineer' });
    await api.advanceClock(11 * 60000);
    await api.tick();
    const run = (await api.get(`/api/companies/${company.id}/runs`)).items[0];
    expect(run.stats.enrich.tried).toBe(2); // only the two unseen jobs were fetched
    expect(run.stats.skipped.too_old).toBe(1);
    expect((await discordInbox.embeds()).filter((e) => e.webhook === 'jobs').map((e) => e.title)).toEqual(['Fresh Systems Engineer']);

    // Next run: every date is remembered (even for the too-old job), so no detail page is opened again
    // and the old job still isn't listed.
    await api.advanceClock(11 * 60000);
    await api.tick();
    const again = (await api.get(`/api/companies/${company.id}/runs`)).items[0];
    expect(again.stats.enrich).toBeUndefined();
    expect((await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items.some((j) => j.external_id === 'old30')).toBe(false);
  });

  test('a per-company age window overrides the global one', async ({ api, mocks }) => {
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs', companyExtra: { notify_filters: { maxJobAgeDays: 1 } } });
    await api.tick();
    const jobs = (await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items;
    expect(jobs.length).toBeLessThanOrEqual(5);
    const run = (await api.get(`/api/companies/${company.id}/runs`)).items[0];
    expect(run.stats.skipped.too_old).toBeGreaterThanOrEqual(20);
  });

  test('AI tasks record per-phase cost and every failed tool call, and log each step', async ({ page, api, mocks }) => {
    await api.put('/api/settings/ai', { discoveryModel: 'mock:discover-fix', prices: { 'mock:discover-fix': { input: 1, output: 5 } } });
    const { task } = await api.post('/api/companies', { name: 'Diag', careers_url: `${mocks.portal.url}/html/acme` });
    await api.drainTasks();
    const t = (await api.get(`/api/tasks/${task.id}`)).task;
    expect(t.status).toBe('succeeded');
    const diag = t.result.diagnostics;
    expect(diag.totals.steps).toBe(t.steps);
    expect(diag.by_phase.test.steps).toBeGreaterThanOrEqual(1);
    expect(diag.failed_calls).toHaveLength(1);
    expect(diag.failed_calls[0]).toMatchObject({ tool: 'run_rule', phase: 'test' });
    expect(diag.failed_calls[0].error).toContain('SelectorNotFound');

    await page.goto(`/#/tasks/${task.id}`);
    await expect(page.getByTestId('task-diagnostics')).toContainText('Test rules');
    await expect(page.getByTestId('diag-failed-calls')).toContainText('SelectorNotFound');
    await expect(page.getByTestId('event-tool_result').filter({ hasText: 'run_rule failed' })).toBeVisible();

    const logs = await api.get(`/api/logs?task_id=${task.id}`);
    expect(logs.items.some((l) => l.msg.startsWith('agent step'))).toBe(true);
    expect(logs.items.some((l) => l.level === 'warn' && l.msg.includes('tool call failed'))).toBe(true);

    // Step-by-step log: the failed run_rule is flagged and a prompt suggestion is shown.
    await expect(page.getByTestId('step-log')).toBeVisible();
    await expect(page.getByTestId('finding-tool_failed')).toContainText('run_rule');
    await page.getByTestId('step-log-flagged-only').check();
    await expect(page.getByTestId('step-row')).toHaveCount(1);
    await expect(page.getByTestId('step-call').filter({ hasText: '✖' })).toContainText('Tested a html rule');
    const review = await api.get(`/api/tasks/${task.id}/review`);
    expect(review.totals.steps).toBe(t.steps);
    expect(review.findings.map((f) => f.code)).toContain('tool_failed');

    const transcript = await page.request.get(`/api/tasks/${task.id}/transcript`);
    expect(transcript.headers()['content-disposition']).toContain('transcript.json');
    expect((await transcript.json()).events.length).toBeGreaterThan(5);
  });
});
