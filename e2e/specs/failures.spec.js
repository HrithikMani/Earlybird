import { test, expect, configureDiscord } from '../fixtures/index.js';
import { seedCompany, nextTick } from '../fixtures/seed.js';

const company = async (api, id) => (await api.get(`/api/companies/${id}`)).company;
const alertTitles = async (discordInbox) => (await discordInbox.embeds()).filter((e) => e.webhook === 'alerts').map((e) => e.title);

test.describe('failures, alerts and fallback', () => {
  test('HTTP 404 marks the company failing immediately, alerts once, and recovers', async ({ api, mocks, mockPortal, discordInbox, page }) => {
    await configureDiscord(api, discordInbox);
    const { company: c } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.board('acme', { mode: '404' });
    await nextTick(api);
    expect((await company(api, c.id)).status).toBe('failing');
    await nextTick(api);
    expect((await alertTitles(discordInbox)).filter((t) => t.includes('failing'))).toHaveLength(1); // no spam

    await page.goto(`/#/companies/${c.id}?tab=runs`);
    await page.getByTestId('run-row').first().click();
    await expect(page.getByTestId('run-error-card')).toContainText('HttpError');
    await expect(page.getByTestId('run-error-card')).toContainText('Page not found');

    await mockPortal.board('acme', { mode: 'ok' });
    await nextTick(api);
    expect((await company(api, c.id)).status).toBe('active');
    expect((await alertTitles(discordInbox)).some((t) => t.includes('recovered'))).toBe(true);
  });

  test('429 / blocked doubles the interval and alerts', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    const { company: c } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.board('acme', { mode: '429' });
    await nextTick(api);
    const after = await company(api, c.id);
    expect(after.effective_interval_min).toBe(20);
    expect(after.health_note).toContain('Blocked');
    expect((await alertTitles(discordInbox)).some((t) => t.includes('blocked'))).toBe(true);
    // Not due again after the normal 10 min, only after the doubled interval.
    await mockPortal.board('acme', { mode: 'ok' });
    const early = await nextTick(api, 11);
    expect(early.ran).toBe(0);
    const later = await nextTick(api, 10);
    expect(later.ran).toBe(1);
    expect((await company(api, c.id)).effective_interval_min).toBeNull();
  });

  test('3 consecutive network errors mark the company failing', async ({ api, mocks, mockPortal }) => {
    const { company: c } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.board('acme', { mode: '500' });
    await nextTick(api);
    expect((await company(api, c.id)).status).toBe('degraded');
    await nextTick(api);
    await nextTick(api);
    const after = await company(api, c.id);
    expect(after.status).toBe('failing');
    expect(after.consecutive_failures).toBe(3);
  });

  test('two zero-job runs after a non-zero run raise a zero_jobs alert', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    const { company: c } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.board('acme', { mode: 'empty' });
    await nextTick(api);
    expect((await company(api, c.id)).status).toBe('active');
    await nextTick(api);
    expect((await company(api, c.id)).status).toBe('degraded');
    expect((await alertTitles(discordInbox)).some((t) => t.includes('zero jobs'))).toBe(true);
  });

  test('a broken browser rule stores a screenshot and the failing step', async ({ api, mocks, mockPortal, page }) => {
    await api.post('/api/roles', { name: 'Engineer', scope: 'global' });
    const { company: c } = await seedCompany(api, mocks.portal.url, { kind: 'spa' });
    await api.tick();
    await mockPortal.board('acme', { variant: 'v2' }); // .card renamed → selector breaks
    await api.put('/api/settings/scraping', { actionTimeoutMs: 3000 });
    await nextTick(api, 16);
    const run = (await api.get(`/api/companies/${c.id}/runs`)).items[0];
    expect(run.error_type).toBe('SelectorNotFound');
    await page.goto(`/#/runs/${run.id}`);
    await expect(page.getByTestId('run-error-card')).toContainText('wait');
    await expect(page.getByTestId('run-error-card')).toContainText('.card');
    await expect(page.getByTestId('run-screenshot')).toBeVisible();
    const img = await page.request.get(await page.getByTestId('run-screenshot').getAttribute('src'));
    expect(img.headers()['content-type']).toBe('image/png');
  });
});
