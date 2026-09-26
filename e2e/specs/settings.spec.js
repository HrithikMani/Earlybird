import { test, expect } from '../fixtures/index.js';

test.describe('settings', () => {
  test('saving the API key masks it and clears the warning', async ({ page, api }) => {
    await page.goto('/#/settings?tab=ai');
    await page.getByTestId('setting-apiKey').fill('sk-ant-test-1234567890abcd');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-saved')).toBeVisible();

    const s = await api.get('/api/settings');
    expect(s.ai.apiKey).toBe('••••abcd');
    expect(JSON.stringify(s)).not.toContain('sk-ant-test');

    const h = await api.get('/api/health');
    expect(h.warnings.map((w) => w.id)).not.toContain('no_api_key');

    // Saving again with the masked value keeps the real key.
    await page.reload();
    await page.getByTestId('setting-maxSteps').fill('25');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-saved')).toBeVisible();
    const rows = await api.sql("select value from settings where key = 'ai'");
    const stored = JSON.parse(rows.rows[0].value);
    expect(stored.apiKey).toBe('sk-ant-test-1234567890abcd');
    expect(stored.maxSteps).toBe(25);
  });

  test('invalid values are rejected with a readable error', async ({ page }) => {
    await page.goto('/#/settings?tab=ai');
    await page.getByTestId('setting-maxSteps').fill('1');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-save-error')).toContainText('maxSteps');
  });

  test('model field suggests Claude models and accepts any id', async ({ page, api }) => {
    await page.goto('/#/settings?tab=ai');
    const models = await api.get('/api/models');
    expect(models.models.map((m) => m.id)).toContain('claude-sonnet-5');
    await page.getByTestId('setting-discoveryModel').fill('claude-opus-5-5');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-saved')).toBeVisible();
    expect((await api.get('/api/settings')).ai.discoveryModel).toBe('claude-opus-5-5');
  });

  test('discord channels are saved with masked webhooks', async ({ page, api, discordInbox }) => {
    await page.goto('/#/settings?tab=discord');
    await page.getByTestId('channel-add').click();
    await page.getByTestId('channel-webhook-0').fill(discordInbox.webhookUrl('jobs'));
    await page.getByTestId('setting-jobsChannelId').selectOption({ label: 'jobs' });
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-saved')).toBeVisible();
    const s = await api.get('/api/settings');
    expect(s.discord.channels[0].webhookUrl).toMatch(/^••••/);
    const h = await api.get('/api/health');
    expect(h.warnings.map((w) => w.id)).not.toContain('no_jobs_webhook');
  });

  test('settings changes are logged and visible on the Logs page', async ({ page, api }) => {
    await api.put('/api/settings/filters', { excludeKeywords: ['intern'] });
    await page.goto('/#/logs');
    await page.getByTestId('logs-search').fill('settings updated');
    await expect(page.getByTestId('log-line').first()).toContainText('settings updated');
  });
});
