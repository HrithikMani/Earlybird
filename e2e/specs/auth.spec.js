import { test as base, expect } from '@playwright/test';
import { startApp } from '../support/app-server.mjs';

// Its own app instance with the login switched on, and forced for localhost too (EARLYBIRD_AUTH_LOCAL=1).
const test = base.extend({
  authApp: [
    async ({}, use, workerInfo) => {
      const app = await startApp({
        port: 3160 + workerInfo.parallelIndex,
        env: { EARLYBIRD_USERNAME: 'admin', EARLYBIRD_PASSWORD: 'Test-only-Pw-7731!', EARLYBIRD_AUTH_LOCAL: '1' },
      });
      await use(app);
      await app.dispose();
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ authApp }, use) => use(authApp.url),
});

test.describe('login', () => {
  test('pages redirect to the login page; the API answers 401 until signed in', async ({ page, authApp }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('login-form')).toBeVisible();
    const api = await fetch(`${authApp.url}/api/companies`);
    expect(api.status).toBe(401);
  });

  test('wrong password shows an error; the right one opens the dashboard; log out works', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-username').fill('admin');
    await page.getByTestId('login-password').fill('wrong');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toContainText('Wrong username or password');

    await page.getByTestId('login-password').fill('Test-only-Pw-7731!');
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByTestId('signed-in')).toContainText('admin');
    const cookie = (await page.context().cookies()).find((c) => c.name === 'eb_session');
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');

    await page.getByTestId('nav-companies').click();
    await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();

    await page.getByTestId('logout').click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/#/jobs');
    await expect(page).toHaveURL(/\/login/);
  });

  test('too many wrong passwords lock the address out for a minute', async ({ authApp }) => {
    const attempt = (password) =>
      fetch(`${authApp.url}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
    for (let i = 0; i < 5; i++) expect((await attempt('nope')).status).toBe(401);
    expect((await attempt('Test-only-Pw-7731!')).status).toBe(429);
  });
});
