import { test, expect, configureDiscord } from '../fixtures/index.js';
import { seedCompany, nextTick } from '../fixtures/seed.js';

test.describe('fast and full sweeps', () => {
  test('fast sweeps read only the newest page; full sweeps read everything', async ({ api, mocks, mockPortal }) => {
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'searchAll', role_mode: 'all_jobs' });
    await mockPortal.reset(); // forget the validation runs made when the rule was saved
    await api.tick(); // baseline = full
    const offsets = (hits) => hits.filter((h) => h.kind === 'api').map((h) => Number(h.query.offset));
    expect(offsets(await mockPortal.hits())).toEqual([0, 10, 20]);

    await mockPortal.control('/reset', 'POST'); // clears hits (and board state)
    await nextTick(api);
    const runs = (await api.get(`/api/companies/${company.id}/runs`)).items;
    expect(runs[0].mode).toBe('fast');
    expect(offsets(await mockPortal.hits())).toEqual([0]);

    await mockPortal.control('/reset', 'POST');
    await nextTick(api, 61);
    expect((await api.get(`/api/companies/${company.id}/runs`)).items[0].mode).toBe('full');
    expect(offsets(await mockPortal.hits())).toEqual([0, 10, 20]);
  });

  test('a new job on page 1 is caught by a fast sweep', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await seedCompany(api, mocks.portal.url, { kind: 'searchAll', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.addJob('acme', { id: 'f1', title: 'Firmware Engineer' });
    await nextTick(api);
    expect((await discordInbox.embeds()).map((e) => e.title)).toEqual(['Firmware Engineer']);
  });

  test('a browser (Playwright) rule with role search catches new jobs', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await api.post('/api/roles', { name: 'Engineer', scope: 'global' });
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'spa' });
    const first = await api.tick();
    expect(first.runs[0].status).toBe('ok');
    expect((await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items.length).toBeGreaterThan(10);
    await mockPortal.addJob('acme', { id: 's1', title: 'Robotics Engineer' });
    await nextTick(api, 16);
    expect((await discordInbox.embeds()).map((e) => e.title)).toEqual(['Robotics Engineer']);
  });
});

test.describe('browser rules with URL pagination', () => {
  test('a Playwright rule follows ?page=N until the cap / last page', async ({ api, mocks, mockPortal }) => {
    const { company } = await seedCompany(api, mocks.portal.url, {
      kind: 'spa',
      role_mode: 'all_jobs',
      rule: {
        item_selector: 'li.job',
        search: { mode: 'none' },
        sorted_newest_first: true,
        fast_max_pages: 1,
        pagination: { kind: 'page', param: 'page', page_size: 10, max_pages: 5 },
        actions: [{ do: 'goto', url: `${mocks.portal.url}/html/acme` }, { do: 'wait', selector: 'li.job' }, { do: 'extract' }],
        fields: { id: '@data-job-id', title: 'a.job-title', url: 'a.job-title@href', location: '.loc', posted_at: 'time@datetime' },
      },
    });
    await mockPortal.reset();
    await api.tick(); // baseline = full: pages 1..3 (25 jobs), page 4 is empty
    const pages = (await mockPortal.hits()).filter((h) => h.kind === 'html').map((h) => Number(h.query.page || 1));
    expect(pages.slice(0, 3)).toEqual([1, 2, 3]);
    expect((await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items).toHaveLength(25);
    await mockPortal.reset();
    await nextTick(api, 16); // fast: page 1 only
    expect((await mockPortal.hits()).filter((h) => h.kind === 'html').map((h) => Number(h.query.page || 1))).toEqual([1]);
  });
});

test.describe('stale jobs', () => {
  test('a removed job is closed after two full sweeps (not by fast sweeps) and deleted after retention', async ({ api, mocks, mockPortal }) => {
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.removeJob('acme', '1003');
    const job = async () => (await api.get(`/api/jobs?company_id=${company.id}&status=&limit=500`)).items.find((j) => j.external_id === '1003');

    await nextTick(api, 61); // full sweep #1
    expect((await job()).closed_at).toBeNull();
    expect((await job()).missing_sweeps).toBe(1);
    await nextTick(api, 61); // full sweep #2
    expect((await job()).closed_at).not.toBeNull();

    await api.advanceClock(2 * 86400000);
    await api.post('/api/test/cleanup');
    expect(await job()).toBeTruthy(); // within 3-day retention
    await api.advanceClock(2 * 86400000);
    await api.post('/api/test/cleanup');
    expect(await job()).toBeUndefined();
    const seen = await api.sql("select count(*) n from seen_jobs where job_key = 'id:1003'");
    expect(seen.rows[0].n).toBe(1); // still remembered for dedupe
  });

  test('a job that reappears before being closed is reopened silently', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    const snapshot = (await mockPortal.board('acme')).jobs.find((j) => j.id === '1004');
    await mockPortal.removeJob('acme', '1004');
    await nextTick(api, 61);
    await mockPortal.addJob('acme', snapshot);
    await nextTick(api, 61);
    const j = (await api.get(`/api/jobs?company_id=${company.id}&limit=500`)).items.find((x) => x.external_id === '1004');
    expect(j.missing_sweeps).toBe(0);
    expect(j.closed_at).toBeNull();
    expect(await discordInbox.embeds()).toHaveLength(0);
  });
});
