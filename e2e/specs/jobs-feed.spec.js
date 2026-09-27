import { test, expect } from '../fixtures/index.js';
import { seedCompany, nextTick } from '../fixtures/seed.js';

test.describe('jobs feed', () => {
  test('sorted by newest posted by default; headers and the dropdown change the order', async ({ page, api, mocks, mockPortal }) => {
    await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    // Seen later but posted 3 days ago: must NOT be on top when sorting by posted date.
    await mockPortal.addJob('acme', { id: 'late', title: 'Zeta Latecomer Engineer', posted_at: Date.now() - 3 * 86400000 });
    await nextTick(api);

    await page.goto('/#/jobs');
    const titles = () => page.getByTestId('job-row').locator('td:first-child a').allInnerTexts();
    await expect(page.getByTestId('jobs-sort')).toHaveValue('posted');
    await expect(page.getByTestId('job-row').first()).toContainText('Senior Software Engineer'); // newest posted (1000)
    expect((await titles()).indexOf('Zeta Latecomer Engineer')).toBeGreaterThan(5);

    await page.getByTestId('sort-first-seen').click(); // newest first seen
    await expect(page.getByTestId('job-row').first()).toContainText('Zeta Latecomer Engineer');

    await page.getByTestId('sort-posted').click();
    await page.getByTestId('sort-posted').click(); // oldest posted
    await expect(page.getByTestId('sort-posted')).toContainText('↑');
    await expect(page.getByTestId('job-row').first()).toContainText('Full Stack Developer'); // oldest seeded job (1024)

    await page.getByTestId('jobs-sort').selectOption('title');
    await expect(page.getByTestId('job-row').first()).toContainText('Account Executive');
  });

  test('filter by company', async ({ page, api, mocks }) => {
    await seedCompany(api, mocks.portal.url, { name: 'Acme', board: 'acme', kind: 'gh', role_mode: 'all_jobs' });
    await seedCompany(api, mocks.portal.url, { name: 'Globex', board: 'globex', kind: 'html', role_mode: 'all_jobs' });
    await api.tick();
    await page.goto('/#/jobs');
    await expect(page.getByTestId('job-row')).toHaveCount(50);
    await page.getByTestId('jobs-company').selectOption({ label: 'Globex (25)' });
    await expect(page.getByTestId('job-row')).toHaveCount(25);
    for (const c of await page.getByTestId('job-row').locator('td:nth-child(2)').allInnerTexts()) expect(c).toBe('Globex');
    await page.getByTestId('jobs-company').selectOption('');
    await expect(page.getByTestId('job-row')).toHaveCount(50);
  });

  test('search and filters narrow the list', async ({ page, api, mocks }) => {
    await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await page.goto('/#/jobs');
    await page.getByTestId('jobs-search').fill('DevOps');
    await expect(page.getByTestId('job-row')).toHaveCount(1);
    await page.getByTestId('jobs-search').fill('');
    await page.getByTestId('jobs-skip-reason').selectOption('baseline');
    await expect(page.getByTestId('job-row')).toHaveCount(25);
  });
});
