import { test, expect } from '../fixtures/index.js';

test.describe('first boot', () => {
  test('dashboard loads with no .env and shows configuration warnings', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByTestId('warning-no_api_key')).toContainText('No Anthropic API key');
    await expect(page.getByTestId('warning-no_jobs_webhook')).toBeVisible();
    await expect(page.getByTestId('system-status')).toHaveText('ok');
    await expect(page.getByTestId('stat-companies')).toContainText('0');
  });

  test('health endpoint reports db ok and test mode', async ({ api }) => {
    const h = await api.get('/api/health');
    expect(h.db.ok).toBe(true);
    expect(h.testMode).toBe(true);
    expect(h.warnings.map((w) => w.id)).toContain('no_api_key');
  });

  test('every nav link opens a page', async ({ page }) => {
    await page.goto('/');
    for (const [id, heading] of [['nav-settings', 'Settings'], ['nav-logs', 'Logs'], ['nav-overview', 'Overview']]) {
      await page.getByTestId(id).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
  });
});
