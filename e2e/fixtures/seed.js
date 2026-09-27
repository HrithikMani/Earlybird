// Helpers to create companies with hand-written rules against the mock portal.
export const MIN = 60_000;

export function ruleFor(kind, portalUrl, board = 'acme', overrides = {}) {
  const B = portalUrl;
  const rules = {
    gh: { type: 'api', url: `${B}/gh/${board}/jobs`, jobs_path: 'jobs', fields: { id: 'id', title: 'title', url: 'absolute_url', location: 'location.name', department: 'departments.0.name', posted_at: 'updated_at' } },
    search: {
      type: 'api', url: `${B}/api/${board}/search?q={{query}}&sort=newest`, jobs_path: 'results', url_prefix: B,
      pagination: { kind: 'offset', param: 'offset', size_param: 'limit', page_size: 10, max_pages: 10 },
      search: { mode: 'per_term' }, sorted_newest_first: true, fast_max_pages: 1,
      fields: { id: 'reqId', title: 'name', url: 'path', location: 'office', department: 'team', posted_at: 'publishedAt' },
    },
    searchAll: {
      type: 'api', url: `${B}/api/${board}/search?sort=newest`, jobs_path: 'results', url_prefix: B,
      pagination: { kind: 'offset', param: 'offset', size_param: 'limit', page_size: 10, max_pages: 10 },
      sorted_newest_first: true, fast_max_pages: 1,
      fields: { id: 'reqId', title: 'name', url: 'path', location: 'office', posted_at: 'publishedAt' },
    },
    html: {
      type: 'html', url: `${B}/html/${board}`, item_selector: 'li.job', pagination: { kind: 'page', param: 'page', page_size: 10, max_pages: 10 },
      fields: { id: '@data-job-id', title: 'a.job-title', url: 'a.job-title@href', location: '.loc', posted_at: 'time@datetime' },
    },
    htmlNoId: {
      type: 'html', url: `${B}/html/${board}`, item_selector: 'li.job', pagination: { kind: 'page', param: 'page', page_size: 10, max_pages: 10 },
      fields: { title: 'a.job-title', url: 'a.job-title@href', location: '.loc', posted_at: 'time@datetime' },
    },
    spa: {
      type: 'browser', item_selector: '.card', sorted_newest_first: true, fast_max_pages: 1, search: { mode: 'per_term' },
      actions: [
        { do: 'goto', url: `${B}/spa/${board}` },
        { do: 'wait', selector: '.card' },
        { do: 'fill', selector: '#search', value: '{{query}}' },
        { do: 'select', selector: '#sort', value: 'newest' },
        { do: 'click', selector: '#more', repeat_until_gone: true },
        { do: 'extract' },
      ],
      fields: { id: '@data-id', title: 'h3 a', url: 'h3 a@href', location: '.location', posted_at: '.posted' },
    },
  };
  return { ...rules[kind], ...overrides };
}

/** Creates a company with an active hand-written rule (no discovery). Returns { company, rule }. */
export async function seedCompany(api, portalUrl, { name = 'Acme', board = 'acme', kind = 'gh', roles = [], role_mode, rule = {}, fallbackKind, companyExtra = {} } = {}) {
  const { company } = await api.post('/api/companies', { name, careers_url: `${portalUrl}/html/${board}`, discover: false, roles, role_mode, ...companyExtra });
  const saved = await api.post('/api/rules', { companyId: company.id, spec: ruleFor(kind, portalUrl, board, rule), activate: true, createdBy: 'seed' });
  let fallback;
  if (fallbackKind) fallback = await api.post('/api/rules', { companyId: company.id, spec: ruleFor(fallbackKind, portalUrl, board), asFallback: true, createdBy: 'seed' });
  return { company: (await api.get(`/api/companies/${company.id}`)).company, rule: saved.rule, fallback: fallback?.rule };
}

export async function addGlobalRole(api, name, extra = {}) {
  return (await api.post('/api/roles', { name, scope: 'global', ...extra })).role;
}

/** Advances the app clock past the company interval and runs a scheduler tick. */
export async function nextTick(api, minutes = 11) {
  await api.advanceClock(minutes * MIN);
  return api.tick();
}
