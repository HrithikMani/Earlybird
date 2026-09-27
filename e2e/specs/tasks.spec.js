import { test, expect } from '../fixtures/index.js';

const useModel = (api, name, extra = {}) => api.put('/api/settings/ai', { discoveryModel: `mock:${name}`, ...extra });

async function startDiscovery(api, mocks, name = 'Slowco') {
  const { company, task } = await api.post('/api/companies', { name, careers_url: `${mocks.portal.url}/html/acme` });
  await expect.poll(async () => (await api.get(`/api/tasks/${task.id}`)).task.status, { timeout: 30_000 }).toBe('running');
  return { company, task };
}

test.describe('agent tasks: watch, stop, kill, retry, guards', () => {
  test.setTimeout(120_000);

  test('Stop cancels a running agent task', async ({ page, api, mocks }) => {
    await useModel(api, 'slow');
    const { company, task } = await startDiscovery(api, mocks);
    await page.goto(`/#/tasks/${task.id}`);
    await expect(page.getByTestId('task-detail-status')).toHaveText('running');
    await expect(page.getByTestId('event-phase').first()).toBeVisible();
    await page.getByTestId('task-stop').click();
    await expect.poll(async () => (await api.get(`/api/tasks/${task.id}`)).task.status, { timeout: 20_000 }).toBe('cancelled');
    expect((await api.get(`/api/companies/${company.id}`)).company.status).toBe('needs_review');
  });

  test('Kill stops a task and shuts down its browser', async ({ page, api, mocks }) => {
    await useModel(api, 'slow');
    const { task } = await startDiscovery(api, mocks);
    await page.goto('/#/tasks');
    await page.getByTestId(`task-kill-${task.id}`).first().click();
    await expect.poll(async () => (await api.get(`/api/tasks/${task.id}`)).task.status, { timeout: 20_000 }).toBe('killed');
  });

  test('loop detection stops an agent that repeats itself', async ({ page, api, mocks }) => {
    await useModel(api, 'loop');
    const { task } = await api.post('/api/companies', { name: 'Loopy', careers_url: `${mocks.portal.url}/html/acme` });
    await api.drainTasks();
    const t = (await api.get(`/api/tasks/${task.id}`)).task;
    expect(t.status).toBe('failed');
    expect(t.error_type).toBe('loop_detected');
    await page.goto(`/#/tasks/${task.id}`);
    await expect(page.getByTestId('event-guard')).toContainText('loop_detected');
    await expect(page.getByTestId('event-tool_call').filter({ hasText: 'repeat #3' })).toBeVisible();
  });

  test('the cost limit stops an expensive task', async ({ api, mocks }) => {
    await useModel(api, 'expensive', { maxCostUsd: 1, prices: { 'mock:expensive': { input: 10, output: 50 } } });
    const { task } = await api.post('/api/companies', { name: 'Pricey', careers_url: `${mocks.portal.url}/html/acme` });
    await api.drainTasks();
    const t = (await api.get(`/api/tasks/${task.id}`)).task;
    expect(t.error_type).toBe('cost_limit');
    expect(t.cost_usd).toBeGreaterThan(1);
  });

  test('the step limit stops a task that never answers', async ({ api, mocks }) => {
    await useModel(api, 'expensive', { maxSteps: 3 });
    const { task } = await api.post('/api/companies', { name: 'Stepper', careers_url: `${mocks.portal.url}/html/acme` });
    await api.drainTasks();
    const t = (await api.get(`/api/tasks/${task.id}`)).task;
    expect(t.error_type).toBe('max_steps');
    expect(t.steps).toBe(3);
  });

  test('a task running when the server crashes is marked interrupted and can be retried', async ({ api, app, mocks }) => {
    await useModel(api, 'slow');
    const { task } = await startDiscovery(api, mocks);
    await app.restart({ crash: true });
    const t = (await api.get(`/api/tasks/${task.id}`)).task;
    expect(t.status).toBe('interrupted');
    await useModel(api, 'discover-acme');
    const { task: retry } = await api.post(`/api/tasks/${task.id}/retry`, { note: 'try again' });
    await api.drainTasks();
    expect((await api.get(`/api/tasks/${retry.id}`)).task.status).toBe('succeeded');
  });

  test('without an API key, discovery waits in the queue', async ({ page, api, mocks }) => {
    await api.put('/api/settings/ai', { discoveryModel: 'claude-sonnet-5' });
    const { company, task } = await api.post('/api/companies', { name: 'Waiting', careers_url: `${mocks.portal.url}/html/acme` });
    await api.drainTasks();
    expect((await api.get(`/api/tasks/${task.id}`)).task.status).toBe('queued');
    await page.goto(`/#/companies/${company.id}`);
    await expect(page.getByTestId('company-title')).toContainText('pending discovery');
    await api.post(`/api/tasks/${task.id}/stop`);
    expect((await api.get(`/api/tasks/${task.id}`)).task.status).toBe('cancelled');
  });
});
