import { test, expect, configureDiscord } from '../fixtures/index.js';
import { seedCompany, addGlobalRole, nextTick, ruleFor } from '../fixtures/seed.js';

test.describe('seen jobs: each job is sent at most once', () => {
  test('the same job found by two role searches is sent once', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await addGlobalRole(api, 'DevOps Engineer');
    await addGlobalRole(api, 'Platform Engineer', { search_terms: ['Platform'] });
    await seedCompany(api, mocks.portal.url, { kind: 'search' });
    await api.tick();
    await mockPortal.addJob('acme', { id: 'x1', title: 'DevOps Platform Engineer' });
    await nextTick(api);
    const embeds = await discordInbox.embeds();
    expect(embeds.map((e) => e.title)).toEqual(['DevOps Platform Engineer']);
    expect(embeds[0].fields.find((f) => f.name === 'Role').value).toBe('DevOps Engineer, Platform Engineer');
  });

  test('switching to a fallback rule with a different id scheme does not resend old jobs', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    // Active: HTML rule (ids "1000", URLs with ?utm_source). Fallback: search API (ids "REQ-1000", clean URLs).
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'html', role_mode: 'all_jobs', fallbackKind: 'searchAll' });
    await api.tick();
    expect(await discordInbox.embeds()).toHaveLength(0);

    // Break the HTML rule and post one genuinely new job.
    await mockPortal.board('acme', { variant: 'v2' });
    await mockPortal.addJob('acme', { id: '7777', title: 'Kotlin Engineer' });
    await nextTick(api); // active fails (SelectorNotFound) → switches to fallback
    let c = (await api.get(`/api/companies/${company.id}`)).company;
    expect(c.status).toBe('failing');
    expect(c.using_fallback).toBe(true);
    await nextTick(api, 1); // fallback run

    const jobEmbeds = (await discordInbox.embeds()).filter((e) => e.webhook === 'jobs');
    expect(jobEmbeds.map((e) => e.title)).toEqual(['Kotlin Engineer']);
    const rekeyed = await api.get(`/api/jobs?company_id=${company.id}&skip_reason=already_seen`);
    expect(rekeyed.items.length).toBe(0); // listings were refreshed in place, not re-inserted
    const alerts = (await discordInbox.embeds()).filter((e) => e.webhook === 'alerts').map((e) => e.title);
    expect(alerts.some((t) => t.includes('failing'))).toBe(true);
    expect(alerts.some((t) => t.includes('fallback in use'))).toBe(true);
    c = (await api.get(`/api/companies/${company.id}`)).company;
    expect(c.status).toBe('active');
  });

  test('a new rule version (manual edit) baselines silently: nothing is resent', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await api.post('/api/rules', { companyId: company.id, spec: ruleFor('htmlNoId', mocks.portal.url), activate: true, force: true, reason: 'switch to html' });
    await nextTick(api);
    expect(await discordInbox.embeds()).toHaveLength(0);
    await mockPortal.addJob('acme', { id: '8080', title: 'Rust Engineer' });
    await nextTick(api);
    expect((await discordInbox.embeds()).map((e) => e.title)).toEqual(['Rust Engineer']);
  });

  test('a job without an id is recognised by its cleaned-up URL across tracking-param changes', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    const { company } = await seedCompany(api, mocks.portal.url, { kind: 'htmlNoId', role_mode: 'all_jobs' });
    await api.tick();
    const before = await api.get(`/api/jobs?company_id=${company.id}&limit=500`);
    expect(before.items.every((j) => !j.canonical_url.includes('utm_'))).toBe(true);
    await nextTick(api);
    await nextTick(api);
    expect(await discordInbox.embeds()).toHaveLength(0);
    const after = await api.get(`/api/jobs?company_id=${company.id}&limit=500`);
    expect(after.items.length).toBe(before.items.length);
    expect(after.items.every((j) => j.seen_count >= 3)).toBe(true);
  });

  test('two different openings with the same title and location are both sent', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.addJob('acme', { id: 'd1', title: 'Software Engineer', location: 'Remote' });
    await mockPortal.addJob('acme', { id: 'd2', title: 'Software Engineer', location: 'Remote' });
    await nextTick(api);
    expect((await discordInbox.embeds()).map((e) => e.url).sort()).toEqual([expect.stringContaining('/d1'), expect.stringContaining('/d2')]);
  });

  test('a new role gets a silent baseline for its existing matches; later matches are sent', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await addGlobalRole(api, 'DevOps Engineer');
    await seedCompany(api, mocks.portal.url, { kind: 'search' });
    await api.tick();
    await addGlobalRole(api, 'Designer');
    await nextTick(api);
    expect(await discordInbox.embeds()).toHaveLength(0); // "Product Designer" already existed
    await mockPortal.addJob('acme', { id: 'des2', title: 'Senior Product Designer' });
    await nextTick(api);
    expect((await discordInbox.embeds()).map((e) => e.title)).toEqual(['Senior Product Designer']);
  });

  test('a job that is taken down and reposted is not sent again', async ({ api, mocks, mockPortal, discordInbox }) => {
    await configureDiscord(api, discordInbox);
    await seedCompany(api, mocks.portal.url, { kind: 'gh', role_mode: 'all_jobs' });
    await api.tick();
    await mockPortal.addJob('acme', { id: 'rp1', title: 'Data Engineer' });
    await nextTick(api);
    expect(await discordInbox.embeds()).toHaveLength(1);
    await mockPortal.removeJob('acme', 'rp1');
    await nextTick(api, 61);
    await nextTick(api, 61);
    expect((await api.get('/api/jobs?status=closed')).items.map((j) => j.external_id)).toContain('rp1');
    await api.advanceClock(4 * 86400000);
    await api.post('/api/test/cleanup');
    expect((await api.get('/api/jobs?status=closed')).items).toHaveLength(0);
    await mockPortal.addJob('acme', { id: 'rp1', title: 'Data Engineer' });
    await nextTick(api);
    expect(await discordInbox.embeds()).toHaveLength(1);
    const again = (await api.get('/api/jobs?q=Data%20Engineer')).items.find((j) => j.external_id === 'rp1');
    expect(again.notify_skip_reason).toBe('already_seen');
  });
});
