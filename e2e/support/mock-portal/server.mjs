// Mock careers portal for tests. One server hosts many "boards" (companies), each reachable in several styles:
//   /gh/:board/jobs                     Greenhouse-shaped JSON (no pagination)
//   /lever/:board?mode=json&skip&limit  Lever-shaped JSON array (offset pagination)
//   /api/:board/search?q&sort&offset&limit   hidden JSON search API (search + sort + offset)
//   POST /wd/:board/jobs {searchText, limit, offset}   Workday-shaped POST API
//   /html/:board?q&page                 server-rendered HTML (page pagination)
//   /spa/:board                         JS-rendered page: search box, sort select, "Load more"
//   /token/:board/session + /token/:board/jobs   needs a token handshake (script rules only)
//   /job/:board/:id                     job detail page
// Control API (tests): /_control/...
import http from 'node:http';

const TITLES = [
  ['Senior Software Engineer', 'Engineering'], ['DevOps Engineer', 'Infrastructure'], ['Product Designer', 'Design'],
  ['Backend Engineer (Go)', 'Engineering'], ['Data Scientist', 'Data'], ['Site Reliability Engineer', 'Infrastructure'],
  ['Account Executive', 'Sales'], ['Machine Learning Engineer', 'AI'], ['Frontend Engineer', 'Engineering'],
  ['Technical Recruiter', 'People'], ['Platform Engineer', 'Infrastructure'], ['Engineering Manager', 'Engineering'],
  ['Software Engineer, Mobile', 'Engineering'], ['Customer Success Manager', 'Sales'], ['AI Research Engineer', 'AI'],
  ['Security Engineer', 'Security'], ['Cloud Infrastructure Engineer', 'Infrastructure'], ['QA Automation Engineer', 'Engineering'],
  ['Marketing Manager', 'Marketing'], ['Staff Software Engineer', 'Engineering'], ['Financial Analyst', 'Finance'],
  ['Software Developer Intern', 'Engineering'], ['Solutions Architect', 'Sales'], ['Kubernetes Engineer', 'Infrastructure'],
  ['Full Stack Developer', 'Engineering'],
];
const LOCATIONS = ['Remote', 'New York, NY', 'San Francisco, CA', 'London, UK', 'Austin, TX', 'Remote - US'];

function seedJobs(board, n = 25, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => {
    const [title, department] = TITLES[i % TITLES.length];
    return {
      id: String(1000 + i),
      title,
      department,
      location: LOCATIONS[i % LOCATIONS.length],
      posted_at: now - (i + 1) * 5 * 3600 * 1000, // 5h apart, newest first
    };
  });
}

function relative(ms, now = Date.now()) {
  const h = Math.max(0, Math.round((now - ms) / 3600000));
  if (h < 1) return 'Posted just now';
  if (h < 24) return `Posted ${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Posted Yesterday' : `Posted ${d} Days Ago`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export async function startMockPortal(port = 0) {
  const boards = new Map();
  let hits = [];
  const tokens = new Set();

  const board = (name) => {
    if (!boards.has(name)) boards.set(name, { name, jobs: seedJobs(name), mode: 'ok', variant: 'v1', delayMs: 0, sortDefault: 'newest', pageSize: 10 });
    return boards.get(name);
  };
  const reset = () => {
    boards.clear();
    hits = [];
    tokens.clear();
  };

  function list(b, { q, sort } = {}) {
    let jobs = [...b.jobs];
    if (q) {
      const terms = String(q).toLowerCase().split(/\s+or\s+|,/i).map((t) => t.trim()).filter(Boolean);
      jobs = jobs.filter((j) => terms.some((t) => t.split(/\s+/).every((w) => `${j.title} ${j.department}`.toLowerCase().includes(w))));
    }
    const s = sort || b.sortDefault;
    if (s === 'newest') jobs.sort((a, c) => c.posted_at - a.posted_at);
    else if (s === 'title') jobs.sort((a, c) => a.title.localeCompare(c.title));
    return jobs;
  }

  let originUrl = "";
  const origin = () => originUrl;
  const jobUrl = (b, j, extra = '') => `${origin()}/job/${b.name}/${j.id}${extra}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const body = await new Promise((r) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => r(d));
    });
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    const html = (status, s) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(s);
    };

    // ---------- control API ----------
    if (p.startsWith('/_control')) {
      const parts = p.split('/').filter(Boolean); // _control, boards, :board, jobs, :id
      if (p === '/_control/reset') {
        reset();
        return json(200, { ok: true });
      }
      if (p === '/_control/hits') return json(200, hits);
      if (parts[1] === 'boards' && parts[2]) {
        const b = board(parts[2]);
        if (parts[3] === 'jobs') {
          if (req.method === 'POST') {
            const add = [].concat(JSON.parse(body || '[]'));
            for (const j of add) b.jobs.unshift({ id: j.id ?? String(Date.now() + Math.floor(Math.random() * 1e6)), title: j.title, department: j.department ?? 'Engineering', location: j.location ?? 'Remote', posted_at: j.posted_at ?? Date.now() });
            return json(200, b);
          }
          if (req.method === 'DELETE' && parts[4]) {
            b.jobs = b.jobs.filter((j) => j.id !== parts[4]);
            return json(200, b);
          }
        }
        if (req.method === 'POST') {
          const patch = JSON.parse(body || '{}');
          if (patch.seed !== undefined) b.jobs = seedJobs(b.name, patch.seed);
          delete patch.seed;
          Object.assign(b, patch);
        }
        return json(200, b);
      }
      return json(404, { error: 'unknown control route' });
    }

    if (p === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /private/\n');
    }

    const m = p.match(/^\/(gh|lever|api|wd|html|spa|spa-data|token|job)\/([^/]+)(\/.*)?$/);
    if (!m) return html(404, '<h1>Not found</h1>');
    const [, kind, name, rest = ''] = m;
    const b = board(name);
    hits.push({ kind, board: name, path: p, query: Object.fromEntries(url.searchParams), method: req.method, at: Date.now() });

    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    if (b.mode === '404') return html(404, '<h1>Page not found</h1>');
    if (b.mode === '403') return html(403, '<h1>Forbidden</h1>');
    if (b.mode === '429') return json(429, { error: 'Too many requests' }, { 'retry-after': '60' });
    if (b.mode === '500') return html(500, '<h1>Internal error</h1>');
    if (b.mode === 'captcha' && kind !== 'job') return html(200, '<html><body><h1>Please verify you are human</h1><div class="g-recaptcha" data-sitekey="x"></div></body></html>');
    const jobsFor = (opts) => (b.mode === 'empty' ? [] : list(b, opts));

    if (kind === 'job') {
      const j = b.jobs.find((x) => x.id === rest.slice(1));
      return j ? html(200, `<h1>${esc(j.title)}</h1><p>${esc(j.location)}</p>`) : html(404, 'gone');
    }

    if (kind === 'gh') {
      const jobs = jobsFor({ sort: 'newest' });
      return json(200, {
        jobs: jobs.map((j) => ({ id: /^d+$/.test(j.id) ? Number(j.id) : j.id, title: j.title, absolute_url: jobUrl(b, j, '?gh_src=abc123'), location: { name: j.location }, updated_at: new Date(j.posted_at).toISOString(), departments: [{ name: j.department }] })),
        meta: { total: jobs.length },
      });
    }

    if (kind === 'lever') {
      const skip = Number(url.searchParams.get('skip') || 0);
      const limit = Number(url.searchParams.get('limit') || 10);
      const jobs = jobsFor({ sort: 'newest' }).slice(skip, skip + limit);
      return json(200, jobs.map((j) => ({ id: `lv-${j.id}`, text: j.title, hostedUrl: jobUrl(b, j, '?lever-source=site'), categories: { location: j.location, team: j.department }, createdAt: j.posted_at })));
    }

    if (kind === 'api') {
      const q = url.searchParams.get('q') || '';
      const sort = url.searchParams.get('sort') || b.sortDefault;
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || b.pageSize);
      const all = jobsFor({ q, sort });
      return json(200, {
        total: all.length,
        results: all.slice(offset, offset + limit).map((j) => ({ reqId: `REQ-${j.id}`, name: j.title, path: `/job/${b.name}/${j.id}`, office: j.location, team: j.department, publishedAt: new Date(j.posted_at).toISOString() })),
      });
    }

    if (kind === 'wd' && req.method === 'POST') {
      const { searchText = '', limit = 20, offset = 0 } = JSON.parse(body || '{}');
      const all = jobsFor({ q: searchText, sort: 'newest' });
      return json(200, {
        total: all.length,
        jobPostings: all.slice(offset, offset + limit).map((j) => ({ title: j.title, externalPath: `/job/${b.name}/${j.id}`, locationsText: j.location, postedOn: relative(j.posted_at), bulletFields: [`JR${j.id}`] })),
      });
    }

    if (kind === 'html') {
      const q = url.searchParams.get('q') || '';
      const page = Number(url.searchParams.get('page') || 1);
      const size = b.pageSize;
      const all = jobsFor({ q, sort: url.searchParams.get('sort') || b.sortDefault });
      const items = all.slice((page - 1) * size, page * size);
      const cls = b.variant === 'v2' ? 'posting' : 'job';
      const rows = items
        .map((j) => `<li class="${cls}" data-job-id="${j.id}"><a class="${cls}-title" href="/job/${b.name}/${j.id}?utm_source=careers">${esc(j.title)}</a> <span class="loc">${esc(j.location)}</span> <span class="dept">${esc(j.department)}</span> <time datetime="${new Date(j.posted_at).toISOString()}">${relative(j.posted_at)}</time></li>`)
        .join('\n');
      return html(200, `<!doctype html><html><head><title>${esc(name)} careers</title></head><body><h1>Careers at ${esc(name)}</h1>
<form action="/html/${name}"><input name="q" value="${esc(q)}"><button>Search</button></form>
<p class="count">${all.length} open positions</p><ul class="jobs">${rows}</ul>
${page * size < all.length ? `<a class="next" href="/html/${name}?page=${page + 1}&q=${encodeURIComponent(q)}">Next</a>` : ''}</body></html>`);
    }

    if (kind === 'spa-data') {
      return json(200, jobsFor({}).map((j) => ({ ...j, rel: relative(j.posted_at) })));
    }

    if (kind === 'spa') {
      const cls = b.variant === 'v2' ? 'opening' : 'card';
      return html(200, `<!doctype html><html><head><title>${esc(name)} jobs</title></head><body>
<h1>Join ${esc(name)}</h1>
<div class="filters"><input id="search" type="search" placeholder="Search jobs" aria-label="Search jobs">
<select id="sort" aria-label="Sort"><option value="relevance">Relevance</option><option value="newest">Newest</option></select></div>
<div id="results" aria-live="polite"><p class="loading">Loading…</p></div>
<button id="more" type="button">Load more</button>
<script>
const PAGE = ${b.pageSize};
let all = [], shown = PAGE;
function render() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const sort = document.getElementById('sort').value;
  let jobs = all.filter(j => !q || q.split(/\\s+or\\s+/).some(t => t.split(/\\s+/).every(w => (j.title + ' ' + j.department).toLowerCase().includes(w))));
  if (sort === 'newest') jobs.sort((a, b) => b.posted_at - a.posted_at);
  else jobs.sort((a, b) => a.title.length - b.title.length || a.title.localeCompare(b.title));
  const el = document.getElementById('results');
  el.innerHTML = jobs.slice(0, shown).map(j => '<div class="${cls}" data-id="' + j.id + '"><h3><a href="/job/${name}/' + j.id + '">' + j.title + '</a></h3><span class="location">' + j.location + '</span><span class="posted">' + j.rel + '</span></div>').join('') || '<p class="none">No jobs found</p>';
  document.getElementById('more').style.display = shown < jobs.length ? '' : 'none';
}
document.getElementById('search').addEventListener('input', () => { shown = PAGE; setTimeout(render, 150); });
document.getElementById('sort').addEventListener('change', () => { shown = PAGE; render(); });
document.getElementById('more').addEventListener('click', () => { shown += PAGE; setTimeout(render, 200); });
setTimeout(() => fetch('/spa-data/${name}').then(r => r.json()).then(d => { all = d; render(); }), 250);
</script></body></html>`);
    }

    if (kind === 'token') {
      if (rest === '/session') {
        const t = Math.random().toString(36).slice(2);
        tokens.add(t);
        return json(200, { token: t, expiresIn: 60 });
      }
      if (rest === '/jobs') {
        if (!tokens.has(req.headers['x-session-token'])) return json(401, { error: 'missing or invalid session token' });
        const q = url.searchParams.get('q') || '';
        return json(200, { data: { items: jobsFor({ q, sort: 'newest' }).map((j) => ({ key: `T${j.id}`, label: j.title, where: j.location, link: `/job/${b.name}/${j.id}`, ts: j.posted_at })) } });
      }
    }
    return html(404, '<h1>Not found</h1>');
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  originUrl = `http://127.0.0.1:${actual}`;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// Run standalone: node e2e/support/mock-portal/server.mjs [port]
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const p = await startMockPortal(Number(process.argv[2] || 4600));
  console.log(`mock portal on ${p.url}`);
}
