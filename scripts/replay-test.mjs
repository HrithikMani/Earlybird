// Replay test for REAL generated rules: proves the rules fetch live jobs, and that a newly posted job
// would be detected and sent to Discord.
//
//   npm run test:replay                 (all companies of the running app on :3000)
//   npm run test:replay -- cmp_a cmp_b  (only these companies)
//
// 1. Live check: runs each company's active rule against the real site (no writes) and prints the newest jobs.
// 2. Record: runs the rule once through a recording proxy that forwards to the real site and saves the responses.
// 3. Replay: starts a throwaway Earlybird (own temp DB, test mode) with the same rules pointed at the proxy,
//    lets it take its silent baseline, then injects a FAKE job (cloned from the newest real job, same JSON shape)
//    into the recorded responses and runs the scheduler. The fake job must reach (mock) Discord, and nothing else.
import http from 'node:http';
import { startApp } from '../e2e/support/app-server.mjs';
import { startMockDiscord } from '../e2e/support/mock-discord.mjs';
import { getPath, setPath } from '../src/runner/extract.js';

const LIVE = process.env.EARLYBIRD_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

async function live(method, url, body) {
  const res = await fetch(LIVE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${data.message || res.status}`);
  return data;
}

// ---------------------------------------------------------------- recording / replaying proxy
// Rule URLs are rewritten from https://host/path to http://127.0.0.1:<port>/<hostKey>/path.
function startProxy() {
  const hosts = new Map(); // key -> origin
  const cache = new Map(); // method + url + body -> { status, headers, body }
  const injections = new Map(); // hostKey -> [{ jobsPath, item }]
  let mode = 'record';
  const server = http.createServer(async (req, res) => {
    const body = await new Promise((r) => {
      let d = '';
      req.on('data', (x) => (d += x));
      req.on('end', () => r(d));
    });
    const [, key, ...rest] = req.url.split('/');
    const origin = hosts.get(key);
    if (!origin) {
      res.writeHead(404);
      return res.end('unknown host key');
    }
    const upstream = origin + '/' + rest.join('/');
    const cacheKey = `${req.method} ${upstream} ${body}`;
    let entry = cache.get(cacheKey);
    if (!entry) {
      if (mode === 'replay') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not recorded', url: upstream }));
      }
      const headers = { 'user-agent': req.headers['user-agent'] || 'Earlybird', accept: req.headers.accept || '*/*' };
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      const r = await fetch(upstream, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
      entry = { status: r.status, contentType: r.headers.get('content-type') || 'application/json', body: await r.text() };
      cache.set(cacheKey, entry);
    }
    let out = entry.body;
    for (const inj of injections.get(key) || []) {
      try {
        const json = JSON.parse(out);
        const arr = getPath(json, inj.jobsPath);
        if (Array.isArray(arr) && arr.length) {
          arr.unshift(inj.item);
          out = JSON.stringify(json);
        }
      } catch {
        // not JSON: leave as is
      }
    }
    res.writeHead(entry.status, { 'content-type': entry.contentType });
    res.end(out);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        rewrite(url) {
          const u = new URL(url.replace(/\{\{\s*\w+\s*\}\}/g, 'EBPLACEHOLDER'));
          const key = u.hostname.replace(/[^a-z0-9]/gi, '_');
          hosts.set(key, u.origin);
          return url.replace(u.origin, `${base}/${key}`);
        },
        hostKey: (url) => new URL(url.replace(/\{\{\s*\w+\s*\}\}/g, 'x')).hostname.replace(/[^a-z0-9]/gi, '_'),
        replay() {
          mode = 'replay';
        },
        inject(key, jobsPath, item) {
          if (!injections.has(key)) injections.set(key, []);
          injections.get(key).push({ jobsPath, item });
        },
        recorded: () => cache.size,
        /** First job object recorded for a host (template for the fake job). */
        sample(key, jobsPath, titlePath) {
          const origin = hosts.get(key);
          for (const [k, entry] of cache) {
            if (!k.includes(origin)) continue;
            try {
              const arr = getPath(JSON.parse(entry.body), jobsPath);
              const item = Array.isArray(arr) && (arr.find((x) => getPath(x, titlePath)) || arr[0]);
              if (item) return structuredClone(item);
            } catch {
              // not JSON
            }
          }
          return null;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    }),
  );
}

// ---------------------------------------------------------------- main
const companies = (await live('GET', '/api/companies')).items.filter((x) => x.active_rule_id && (!only.length || only.includes(x.id)));
if (!companies.length) {
  console.log('No companies with an active rule found on', LIVE);
  process.exit(1);
}
const globalRoles = (await live('GET', '/api/roles?scope=global')).items;
const settings = await live('GET', '/api/settings');

console.log(c.b('\n1) LIVE CHECK: running each active rule against the real site right now\n'));
for (const co of companies) {
  const t = await live('POST', '/api/rules/test', { ruleId: co.active_rule_id, mode: 'fast' });
  if (!t.ok) {
    console.log(`${c.r('✖')} ${co.name}: ${t.error.type}: ${t.error.message}`);
    continue;
  }
  const newest = [...t.jobs].sort((a, b) => (b.posted_at ?? 0) - (a.posted_at ?? 0)).slice(0, 5);
  console.log(`${c.g('✔')} ${c.b(co.name)}: ${t.count} jobs in ${t.meta.duration_ms} ms (${t.meta.requests.length} requests, terms: ${t.terms.join(', ')})`);
  for (const j of newest) console.log(`    ${j.posted_at ? new Date(j.posted_at).toISOString().slice(0, 10) : '          '}  ${j.title}  ${c.d(j.location || '')}`);
}

console.log(c.b('\n2) RECORD + 3) REPLAY with a fake new job, in a throwaway Earlybird instance\n'));
const proxy = await startProxy();
const discord = await startMockDiscord(0);
const app = await startApp({ port: 3190 });
const api = async (method, url, body) => {
  const res = await fetch(app.url + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${data.message || JSON.stringify(data).slice(0, 300)}`);
  return data;
};

let failures = 0;
try {
  await api('PUT', '/api/settings/discord', { channels: [{ id: 'ch_jobs', name: 'jobs', webhookUrl: discord.webhookUrl('jobs') }, { id: 'ch_alerts', name: 'alerts', webhookUrl: discord.webhookUrl('alerts') }], jobsChannelId: 'ch_jobs', alertsChannelId: 'ch_alerts' });
  await api('PUT', '/api/settings/filters', settings.filters);
  await api('PUT', '/api/settings/scraping', { respectRobots: false }); // the proxy is local
  for (const r of globalRoles) await api('POST', '/api/roles', { name: r.name, scope: 'global', search_terms: r.search_terms, synonyms: r.synonyms, exclude_words: r.exclude_words });

  const plans = [];
  for (const co of companies) {
    const detail = await live('GET', `/api/companies/${co.id}`);
    const rule = detail.active_rule;
    if (rule.type !== 'api' && rule.type !== 'html') {
      console.log(`${c.d('–')} ${co.name}: active rule is ${rule.type}; replay supports api/html rules only, skipping`);
      continue;
    }
    const spec = structuredClone(rule.spec);
    spec.url = proxy.rewrite(spec.url);
    const { company } = await api('POST', '/api/companies', {
      name: co.name,
      careers_url: co.careers_url,
      discover: false,
      role_mode: co.role_mode,
      source_filters: co.source_filters,
      notify_filters: co.notify_filters,
      roles: detail.company_roles.map((r) => ({ name: r.name, search_terms: r.search_terms, synonyms: r.synonyms, exclude_words: r.exclude_words })),
    });
    // Record: the first rule run goes through the proxy to the real site.
    const saved = await api('POST', '/api/rules', { companyId: company.id, spec, activate: true, force: true, reason: 'replay test' });
    plans.push({ co, company, spec, rule: saved.rule, hostKey: proxy.hostKey(rule.spec.url) });
    console.log(`${c.g('✔')} ${co.name}: rule ${rule.id} copied as ${saved.rule.id}, responses recorded from ${new URL(rule.spec.url.replace(/\{\{\s*\w+\s*\}\}/g, 'x')).host}`);
  }
  proxy.replay();
  console.log(c.d(`   ${proxy.recorded()} real responses recorded; the replay is now offline`));

  const first = await api('POST', '/api/test/tick');
  for (const r of first.runs) console.log(`   baseline run: ${r.status}`);
  const baselineMsgs = (await (await fetch(`${discord.url}/_control/messages`)).json()).length;
  console.log(`   Discord messages after baseline: ${baselineMsgs} ${baselineMsgs === 0 ? c.g('(correct: baseline is silent)') : c.r('(expected 0)')}`);
  if (baselineMsgs) failures++;

  // Inject a fake job cloned from the newest real job (same JSON shape and date format).
  const fakes = [];
  for (const p of plans) {
    const template = proxy.sample(p.hostKey, p.spec.jobs_path, p.spec.fields.title);
    if (!template) {
      console.log(`${c.r('✖')} ${p.co.name}: could not read a recorded job to clone`);
      failures++;
      continue;
    }
    const stamp = Date.now().toString(36);
    const title = `Software Development Engineer II - Earlybird Test ${stamp}`;
    setPath(template, p.spec.fields.title, title);
    if (p.spec.fields.id) setPath(template, p.spec.fields.id, `EBTEST-${stamp}`);
    const oldUrl = String(getPath(template, p.spec.fields.url) ?? '');
    setPath(template, p.spec.fields.url, oldUrl.includes('?') ? `${oldUrl}&earlybird_test=${stamp}` : `${oldUrl}?earlybird_test=${stamp}`);
    proxy.inject(p.hostKey, p.spec.jobs_path, template);
    fakes.push({ company: p.co.name, title });
    console.log(`   injected fake job for ${p.co.name}: "${title}"`);
  }

  await api('POST', '/api/test/advance-clock', { ms: 61 * 60000 });
  const second = await api('POST', '/api/test/tick');
  for (const r of second.runs) console.log(`   next scheduled run: ${r.status}`);
  const embeds = (await (await fetch(`${discord.url}/_control/messages`)).json()).flatMap((m) => (m.payload.embeds || []).map((e) => ({ ...e, webhook: m.webhook })));
  const jobEmbeds = embeds.filter((e) => e.webhook === 'jobs');

  console.log(c.b('\nRESULT'));
  for (const f of fakes) {
    const hit = jobEmbeds.find((e) => e.title === f.title);
    if (hit) console.log(`${c.g('✔')} ${f.company}: the fake new job reached Discord → "${hit.title}" (${hit.fields.map((x) => `${x.name}: ${x.value}`).join(' · ')})`);
    else {
      failures++;
      console.log(`${c.r('✖')} ${f.company}: the fake job was NOT sent to Discord`);
      const j = (await api('GET', `/api/jobs?q=${encodeURIComponent('Earlybird Test')}`)).items.find((x) => x.company_name === f.company);
      console.log(j ? `    stored with notify_status=${j.notify_status} reason=${j.notify_skip_reason}` : '    not stored at all (the rule did not return it)');
    }
  }
  const others = jobEmbeds.filter((e) => !fakes.some((f) => f.title === e.title));
  console.log(others.length ? `${c.r('✖')} ${others.length} unexpected job message(s) (old jobs re-sent?)` : `${c.g('✔')} no other jobs were sent (no duplicates, no old jobs)`);
  if (others.length) failures++;
} catch (err) {
  failures++;
  console.error(c.r(`\nreplay test crashed: ${err.message}`));
  console.error(c.d(`app log: ${app.logFile}`));
} finally {
  await app.dispose();
  await discord.close();
  await proxy.close();
}
console.log(failures ? c.r(`\n${failures} problem(s)\n`) : c.g('\nAll good: live fetching works and a newly posted job is detected and sent.\n'));
process.exit(failures ? 1 : 0);
