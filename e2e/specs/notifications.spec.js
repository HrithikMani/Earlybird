import { test, expect, configureDiscord } from '../fixtures/index.js';
import { seedCompany, addGlobalRole, nextTick } from '../fixtures/seed.js';

test.describe('notifications', () => {
  test('first run is a silent baseline; only new matching jobs reach Discord', async ({ api, mocks, mockPortal, discordInbox, page }) => {
    await configureDiscord(api, discordInbox);
    await addGlobalRole(api, 'DevOps Engineer', { synonyms: ['SRE', 'Site Reliability Engineer'] });
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh' });

    const first = await api.tick();
    expect(first.runs[0].status).toBe('ok');
    expect(await discordInbox.embeds()).toHaveLength(0);
    const baseline = await api.get(`/api/jobs?company_id=${company.id}&skip_reason=baseline`);
    expect(baseline.items.length).toBe(25);

    await mockPortal.addJob('acme', { id: '9001', title: 'Senior DevOps Engineer', location: 'Remote' });
    await mockPortal.addJob('acme', { id: '9002', title: 'Staff Accountant', location: 'Remote' });
    await mockPortal.addJob('acme', { id: '9003', title: 'SRE, Payments', location: 'London, UK' });
    await nextTick(api);

    const embeds = await discordInbox.embeds();
    expect(embeds.map((e) => e.title).sort()).toEqual(['SRE, Payments', 'Senior DevOps Engineer']);
    const devops = embeds.find((e) => e.title === 'Senior DevOps Engineer');
    expect(devops.url).toContain('/job/acme/9001');
    expect(devops.fields.find((f) => f.name === 'Company').value).toBe('Acme');
    expect(devops.fields.find((f) => f.name === 'Role').value).toBe('DevOps Engineer');
    expect(embeds.every((e) => e.webhook === 'jobs')).toBe(true);

    // The accountant job is stored but not sent, with the reason visible in the dashboard.
    await page.goto('/#/jobs');
    await page.getByTestId('jobs-search').fill('Accountant');
    const row = page.getByTestId('job-row').filter({ hasText: 'Staff Accountant' });
    await expect(row.getByTestId('job-skip-reason')).toHaveText('role mismatch');
    await row.click();
    await expect(page.getByTestId('job-detail')).toContainText('portal id 9002');
  });

  test('exclude keywords and location filters stop a job from being sent', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await api.put('/api/settings/filters', { excludeKeywords: ['intern'], locations: ['Remote'] });
    await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.addJob('acme', { id: 'a1', title: 'Software Engineer Intern', location: 'Remote' });
    await mockPortal.addJob('acme', { id: 'a2', title: 'Software Engineer', location: 'Berlin' });
    await mockPortal.addJob('acme', { id: 'a3', title: 'Software Engineer', location: 'Remote - EU' });
    await nextTick(api);
    const titles = (await discordInbox.embeds()).map((e) => `${e.title}|${e.fields.find((f) => f.name === 'Location')?.value}`);
    expect(titles).toEqual(['Software Engineer|Remote - EU']);
  });

  test('jobs posted long ago are not sent even if new to Earlybird', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.addJob('acme', { id: 'old1', title: 'Backend Engineer', posted_at: Date.now() - 10 * 86400000 });
    await nextTick(api);
    expect(await discordInbox.embeds()).toHaveLength(0);
    const skipped = await api.get('/api/jobs?skip_reason=too_old');
    expect(skipped.items.map((j) => j.external_id)).toContain('old1');
  });

  test('Discord 429 is retried and the job is sent exactly once', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await discordInbox.fail({ status: 429, retry_after: 0.2, count: 2 });
    await mockPortal.addJob('acme', { id: 'r1', title: 'Platform Engineer' });
    await nextTick(api);
    const embeds = await discordInbox.embeds();
    expect(embeds.map((e) => e.title)).toEqual(['Platform Engineer']);
    const job = (await api.get('/api/jobs?q=Platform%20Engineer')).items.find((j) => j.external_id === 'r1');
    expect(job.notify_status).toBe('sent');
  });

  test('a Discord outage keeps notifications pending and sends them once when it recovers', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await discordInbox.fail({ status: 500, count: 20 });
    await mockPortal.addJob('acme', { id: 'o1', title: 'Security Engineer II' });
    await nextTick(api);
    expect(await discordInbox.embeds()).toHaveLength(0);
    const pending = await api.sql("select status, attempts, last_error from notifications where kind = 'job'");
    expect(pending.rows[0].status).toBe('pending');
    expect(pending.rows[0].last_error).toContain('500');

    await discordInbox.reset();
    await api.advanceClock(2 * 60_000);
    await api.drainOutbox();
    await api.drainOutbox();
    expect((await discordInbox.embeds()).map((e) => e.title)).toEqual(['Security Engineer II']);
  });
});
