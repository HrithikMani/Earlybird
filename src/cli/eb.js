#!/usr/bin/env node
// Earlybird Agent CLI: the only way external agents (GitHub Copilot, Claude Code, Cursor) touch Earlybird.
// Every write goes through the same validation as the app. Usage: npm run eb -- <command> [...] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

process.env.EARLYBIRD_CLI = '1';
process.env.LOG_LEVEL ??= 'warn';

const HELP = `Earlybird CLI  (npm run eb -- <command> [options] [--json])

  mcp check                                Check the Playwright MCP server works (run before IDE-agent discovery)
  schema rule|job|discovery|verify         Print the JSON Schema to draft against
  company list                             List companies
  company show <companyId>                 Company, effective roles, search terms, rules
  company add --name N --url U [--roles "A, B"] [--role-mode M]
  rule test --file F --company C [--mode fast|full] [--spec S]
                                           Dry run a draft (.json rule, or .mjs script + optional --spec). No writes.
  rule import --file F --company C [--activate] [--as fallback] [--force --reason R] [--spec S]
                                           Validate + score like discovery; saves a new version only if it passes
  rule show <ruleId> | rule list <companyId> | rule diff <ruleA> <ruleB>
  rule run <ruleId> [--full]               Dry run a stored rule (no DB writes, no Discord)
  rule rollback <companyId>                Re-activate the previous rule version
  jobs --company C | --rule R [--window 10m|1h|24h]
  verify precheck <ruleId> [--window W]    Deterministic checks (no LLM)
  verify save <ruleId> --file report.json  Store a verification report produced by an external agent
  verify run <ruleId> [--window W]         Ask the running app to verify with its own agent
  task list | task show|stop|kill|retry <taskId> [--note N]   (needs the app running)

Exit codes: 0 ok · 1 validation failed · 2 error`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    file: { type: 'string' },
    spec: { type: 'string' },
    company: { type: 'string' },
    rule: { type: 'string' },
    mode: { type: 'string' },
    window: { type: 'string', default: '1h' },
    activate: { type: 'boolean', default: false },
    as: { type: 'string' },
    force: { type: 'boolean', default: false },
    reason: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    roles: { type: 'string' },
    'role-mode': { type: 'string' },
    note: { type: 'string' },
    full: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

class CliError extends Error {
  constructor(message, code = 2, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function out(data, human) {
  if (opts.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write((human ? human(data) : JSON.stringify(data, null, 2)) + '\n');
}

const apiBase = () => process.env.EARLYBIRD_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(apiBase() + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new CliError(`the Earlybird app is not running at ${apiBase()} (start it with "npm run dev")`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliError(data.message || data.error || `HTTP ${res.status}`, res.status === 422 ? 1 : 2, data);
  return data;
}

function readDraft() {
  if (!opts.file) throw new CliError('--file is required');
  const file = path.resolve(opts.file);
  if (!fs.existsSync(file)) throw new CliError(`file not found: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  if (/\.(mjs|js)$/.test(file)) {
    const spec = opts.spec ? JSON.parse(fs.readFileSync(path.resolve(opts.spec), 'utf8')) : { type: 'script', search: { mode: 'per_term' } };
    return { spec, code: text };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new CliError(`${file} is not valid JSON: ${e.message}`, 1);
  }
  if (json.rule) return { spec: json.rule, code: json.code };
  return { spec: json, code: undefined };
}

async function main() {
  if (opts.help || !positionals.length) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  const [cmd, sub, arg1, arg2] = positionals;

  // Commands that only talk to the running app.
  if (cmd === 'task') {
    if (sub === 'list') return out(await api('GET', '/api/tasks?limit=50'), (d) => d.items.map((t) => `${t.id}  ${t.kind.padEnd(9)} ${t.status.padEnd(10)} ${t.company_name || ''} ${t.error_type || ''}`).join('\n')), 0;
    if (!arg1) throw new CliError('task id required');
    if (sub === 'show') return out(await api('GET', `/api/tasks/${arg1}`)), 0;
    if (['stop', 'kill', 'retry'].includes(sub)) return out(await api('POST', `/api/tasks/${arg1}/${sub}`, sub === 'retry' ? { note: opts.note } : {})), 0;
    throw new CliError(`unknown task command ${sub}`);
  }
  if (cmd === 'verify' && sub === 'run') {
    if (!arg1) throw new CliError('rule id required');
    return out(await api('POST', `/api/rules/${arg1}/verify`, { window: opts.window, note: opts.note })), 0;
  }

  // Everything else works directly on the DB (safe while the app runs: WAL + busy_timeout).
  const { ensureDataDirs } = await import('../config.js');
  const { openDb, closeDb, getSqlite } = await import('../db/index.js');
  ensureDataDirs();
  openDb();
  (await import('../log/db-sink.js')).attachDbSink();
  const { childLogger } = await import('../log/logger.js');
  const log = childLogger('cli', { actor: 'cli' });
  try {
    const { getCompany, listCompanies, createCompany } = await import('../store/companies.js');
    const rulesStore = await import('../store/rules.js');
    const { effectiveRoles, searchTerms } = await import('../roles/match.js');
    const needCompany = (id) => {
      const c = getCompany(id);
      if (!c) throw new CliError(`company ${id} not found`);
      return c;
    };

    if (cmd === 'mcp' && sub === 'check') {
      // Pre-flight for IDE agents: can the Playwright MCP server start here, and is VS Code configured for it?
      const { playwrightMcpCommand, testMcpServer } = await import('../agents/mcp.js');
      const { ROOT } = await import('../config.js');
      const vscodeConfig = path.join(ROOT, '.vscode', 'mcp.json');
      const result = { vscode_mcp_json: fs.existsSync(vscodeConfig) ? '.vscode/mcp.json' : null };
      try {
        const tools = await testMcpServer(playwrightMcpCommand());
        Object.assign(result, { ok: tools.includes('browser_navigate'), tools });
      } catch (e) {
        Object.assign(result, { ok: false, error: e.message });
      }
      result.next_steps = result.ok
        ? 'Playwright MCP works. In VS Code: Copilot Chat → Agent mode → Tools → enable the "playwright" server (from .vscode/mcp.json), then run /discover-rule.'
        : 'Run "npm run setup" (installs Chromium), then in VS Code open .vscode/mcp.json and click "Start" on the playwright server, and enable it in Copilot Chat → Agent mode → Tools.';
      return out(result, (d) => `${d.ok ? 'OK' : 'NOT READY'}: Playwright MCP ${d.ok ? `(${d.tools.length} tools)` : d.error || ''}\n${d.next_steps}`), result.ok ? 0 : 2;
    }

    if (cmd === 'schema') {
      const { ruleJsonSchema } = await import('../schema/rule.js');
      const { jobJsonSchema } = await import('../schema/job.js');
      const { z } = await import('zod');
      const agent = await import('../schema/agent.js');
      const map = { rule: ruleJsonSchema, job: jobJsonSchema, discovery: () => z.toJSONSchema(agent.DiscoveryResultSchema, { io: 'input' }), verify: () => z.toJSONSchema(agent.VerifyReportSchema, { io: 'input' }) };
      if (!map[sub]) throw new CliError('schema rule|job|discovery|verify');
      process.stdout.write(JSON.stringify(map[sub](), null, 2) + '\n');
      return 0;
    }

    if (cmd === 'company') {
      if (sub === 'list') return out({ items: listCompanies().map((c) => ({ id: c.id, name: c.name, status: c.status, careers_url: c.careers_url, active_rule_id: c.active_rule_id })) }, (d) => d.items.map((c) => `${c.id}  ${c.status.padEnd(18)} ${c.name}  ${c.active_rule_id || '-'}  ${c.careers_url}`).join('\n')), 0;
      if (sub === 'show') {
        const c = needCompany(arg1);
        const roles = effectiveRoles(c);
        return out({ company: c, effective_roles: roles.map((r) => ({ name: r.name, scope: r.scope, search_terms: r.search_terms, synonyms: r.synonyms })), search_terms: searchTerms(roles), rules: rulesStore.listRules(c.id).map((r) => ({ id: r.id, slot: r.slot, strategy: r.strategy, type: r.type, version: r.version, score: r.score?.total })) }), 0;
      }
      if (sub === 'add') {
        const c = createCompany({ name: opts.name, careers_url: opts.url, role_mode: opts['role-mode'] || undefined });
        const { createRole } = await import('../roles/store.js');
        for (const r of (opts.roles || '').split(',').map((s) => s.trim()).filter(Boolean)) createRole({ name: r, scope: 'company', company_id: c.id });
        log.info({ company_id: c.id, name: c.name }, 'company added (cli)');
        return out({ company: getCompany(c.id) }, (d) => `added ${d.company.id} (${d.company.status}); run discovery from the dashboard or import a rule with "rule import"`), 0;
      }
    }

    if (cmd === 'rule') {
      if (sub === 'test' || sub === 'import') {
        const c = needCompany(opts.company);
        const { spec, code } = readDraft();
        const { safeParseRule, formatZodError } = await import('../schema/rule.js');
        const parsed = safeParseRule(spec);
        if (!parsed.success) throw new CliError(`invalid rule: ${formatZodError(parsed.error)}`, 1, { issues: parsed.error.issues });
        if (sub === 'test') {
          const { runRule } = await import('../runner/index.js');
          const { runnerOptions } = await import('../worker/scrape.js');
          const terms = searchTerms(effectiveRoles(c));
          try {
            const { jobs, meta } = await runRule(parsed.data, { ...runnerOptions({ log }), mode: opts.mode === 'fast' ? 'fast' : 'full', terms, scriptCode: code });
            const newest = [...jobs].sort((a, b) => (b.posted_at ?? 0) - (a.posted_at ?? 0));
            return out({ ok: true, job_count: jobs.length, terms, per_query: meta.per_query, pages: meta.pages, invalid_count: meta.invalid_count, invalid_samples: meta.invalid_samples, newest_jobs: newest.slice(0, 15), duration_ms: meta.duration_ms }, (d) => `${d.job_count} jobs (${d.pages} pages, ${d.duration_ms} ms, invalid ${d.invalid_count})\n` + d.newest_jobs.map((j) => `  ${j.posted_at ? new Date(j.posted_at).toISOString().slice(0, 16) : '—'}  ${j.title}  ${j.url}`).join('\n')), meta.invalid_count ? 1 : 0;
          } catch (err) {
            throw new CliError(`${err.type || 'Error'}: ${err.message}`, 1, { error_type: err.type, detail: err.detail });
          }
        }
        // import: full validation pipeline, never breaks the running app
        const { validateCandidate } = await import('../agents/validate.js');
        const v = await validateCandidate({ company: c, spec: parsed.data, code, log });
        if (!v.passed && !opts.force) throw new CliError(`validation failed: ${v.errors.join('; ')}`, 1, { validation: v });
        if (opts.force && !opts.reason) throw new CliError('--force needs --reason');
        const current = c.active_rule_id ? rulesStore.getRule(c.active_rule_id) : null;
        if (opts.activate && current?.score?.total !== undefined && v.score.total < current.score.total && !opts.force) {
          throw new CliError(`new rule scores ${v.score.total.toFixed(2)} < active ${current.score.total.toFixed(2)}; use --force --reason to replace it`, 1, { validation: v });
        }
        const { getSettings } = await import('../settings/index.js');
        const needsApproval = parsed.data.type === 'script' && getSettings('scripts').requireApproval;
        const rule = rulesStore.saveRule({ companyId: c.id, spec: parsed.data, code, createdBy: 'cli', score: v.score, notes: opts.reason, ruleKey: current?.rule_key });
        if (opts.activate && !needsApproval) rulesStore.activateRule(rule.id);
        else if (opts.as === 'fallback') rulesStore.setFallback(rule.id);
        log.info({ company_id: c.id, rule_id: rule.id, activate: opts.activate, forced: opts.force, reason: opts.reason, score: v.score.total }, 'rule imported (cli)');
        return out({ ok: true, rule: rulesStore.getRule(rule.id), validation: { passed: v.passed, score: v.score, errors: v.errors, job_count: v.job_count }, activated: opts.activate && !needsApproval, needs_approval: needsApproval }, (d) => `saved ${d.rule.id} v${d.rule.version} (score ${d.validation.score.total.toFixed(2)})${d.activated ? ' and activated; the next scheduled run records a silent baseline' : ''}`), 0;
      }
      if (sub === 'show') {
        const r = rulesStore.getRule(arg1);
        if (!r) throw new CliError(`rule ${arg1} not found`);
        return out({ rule: r }), 0;
      }
      if (sub === 'list') return out({ items: rulesStore.listRules(needCompany(arg1).id) }, (d) => d.items.map((r) => `${r.id}  ${r.slot.padEnd(9)} ${r.strategy}/${r.type} v${r.version}  score ${r.score?.total?.toFixed(2) ?? '-'}`).join('\n')), 0;
      if (sub === 'diff') {
        const a = rulesStore.getRule(arg1);
        const b = rulesStore.getRule(arg2);
        if (!a || !b) throw new CliError('both rule ids must exist');
        const keys = [...new Set([...Object.keys(a.spec), ...Object.keys(b.spec)])];
        const changes = keys.filter((k) => JSON.stringify(a.spec[k]) !== JSON.stringify(b.spec[k])).map((k) => ({ key: k, a: a.spec[k], b: b.spec[k] }));
        return out({ changes, code_changed: a.code_hash !== b.code_hash }), 0;
      }
      if (sub === 'rollback') {
        const r = rulesStore.rollbackRule(needCompany(arg1).id);
        log.info({ company_id: arg1, rule_id: r.id }, 'rule rolled back (cli)');
        return out({ ok: true, rule: r }, (d) => `active rule is now ${d.rule.id}`), 0;
      }
      if (sub === 'run') {
        const r = rulesStore.getRule(arg1);
        if (!r) throw new CliError(`rule ${arg1} not found`);
        const { runRule } = await import('../runner/index.js');
        const { runnerOptions } = await import('../worker/scrape.js');
        const c = needCompany(r.company_id);
        const { jobs, meta } = await runRule(r.spec, { ...runnerOptions({ log }), mode: opts.full ? 'full' : 'fast', terms: searchTerms(effectiveRoles(c)), scriptPath: rulesStore.ensureScriptFile(r) });
        return out({ job_count: jobs.length, meta: { ...meta, requests: meta.requests.slice(0, 30) }, jobs: jobs.slice(0, 50) }, (d) => `${d.job_count} jobs in ${d.meta.duration_ms} ms\n` + d.jobs.slice(0, 20).map((j) => `  ${j.title}  ${j.url}`).join('\n')), 0;
      }
    }

    if (cmd === 'jobs') {
      const { windowMs } = await import('../agents/tools.js');
      const { now } = await import('../runtime.js');
      const since = now() - windowMs(opts.window);
      const where = opts.rule ? 'rule_id = ?' : 'company_id = ?';
      const key = opts.rule || opts.company;
      if (!key) throw new CliError('--company or --rule required');
      const rows = getSqlite().prepare(`select id, title, url, location, posted_at, first_seen_at, notify_status, notify_skip_reason, rule_id from jobs where ${where} and first_seen_at >= ? order by first_seen_at desc`).all(key, since);
      return out({ window: opts.window, count: rows.length, items: rows }, (d) => `${d.count} jobs first seen in the last ${d.window}\n` + d.items.map((j) => `  ${j.notify_status.padEnd(8)} ${j.title}  ${j.url}`).join('\n')), 0;
    }

    if (cmd === 'verify') {
      const { precheck, saveVerification } = await import('../agents/verify.js');
      if (sub === 'precheck') return out(await precheck(arg1, opts.window)), 0;
      if (sub === 'save') {
        const r = rulesStore.getRule(arg1);
        if (!r) throw new CliError(`rule ${arg1} not found`);
        if (!opts.file) throw new CliError('--file is required');
        let report;
        try {
          report = JSON.parse(fs.readFileSync(path.resolve(opts.file), 'utf8'));
        } catch (e) {
          throw new CliError(`could not read report: ${e.message}`, 1);
        }
        try {
          const saved = await saveVerification({ rule: r, report: { window: opts.window, ...report }, source: 'cli' });
          log.info({ rule_id: r.id, verdict: saved.verdict }, 'verification saved (cli)');
          return out({ ok: true, verification: saved }, (d) => `saved ${d.verification.id}: ${d.verification.verdict}`), 0;
        } catch (e) {
          throw new CliError(`invalid report: ${e.issues ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message}`, 1);
        }
      }
    }
    throw new CliError(`unknown command: ${positionals.join(' ')}\n\n${HELP}`);
  } finally {
    const { flushDbSink } = await import('../log/db-sink.js').catch(() => ({}));
    flushDbSink?.();
    closeDb();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    const code = err instanceof CliError ? err.code : 2;
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message, ...(err.data || {}) }, null, 2) + '\n');
    else process.stderr.write(`error: ${err.message}\n`);
    process.exit(code);
  });
