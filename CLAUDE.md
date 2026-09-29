# Earlybird

Earlybird watches company career portals and posts **new** job openings to Discord within minutes of them going live. Everything is configured and operated from a local web dashboard.

## Core principles

1. **The AI discovers (and audits); plain code runs forever.** An LLM agent is used only to *create* a rule for a portal and, on demand, to *verify* a rule. Scheduled scraping is deterministic code with no LLM.
2. **Every company is driven by a rule, and every rule has an ID** (`rul_…`). Runs, jobs, verifications, logs and alerts all reference the rule ID, so any problem can be traced back to exactly which rule produced it.
3. **URL rule or Playwright rule, whichever is optimal for that portal.** Some portals filter easily by URL (API params, query strings), others only through their UI. When a careers link is added, the agent tries both: a **URL rule** (ATS API / hidden JSON / static HTML / URL with search+sort query params) and a **Playwright rule** (open the page, search the role, apply filters like "sort by newest", extract). Code runs and scores both; the better one goes live. If the other one also passed, it's kept as a backup.
4. **Search by role.** You list the roles you care about (e.g. "Software Developer", "DevOps Engineer") globally, and optionally per company (e.g. Tesla: "AI Engineer", "Infrastructure Engineer"). The agent builds rules that search/filter by those roles at the portal (URL param or Playwright search box / category filter) whenever the portal supports it, and code also matches job titles against the roles before notifying.
5. **Optimize for the newest jobs.** Frequent *fast sweeps* fetch only the newest-first first page(s). Less frequent *full sweeps* fetch everything to detect removed (stale) postings.
6. **Nothing is a black box.** Every run, agent step, tool call and error is logged with enough detail to debug it without re-running. Every background task is visible live and can be stopped, killed or retried from the dashboard.
7. **Everything is managed from the dashboard.** Roles, models, Discord channels, filters, intervals, retention, limits, MCP tools. No config file editing after first boot.
8. **Runs on any laptop.** macOS, Windows and Linux. One setup command (`./setup.sh`, `.\setup.ps1` or `npm run setup`), then `npm run dev` gives a working app on http://localhost:3000.
9. **Works with your IDE agent too.** The `prompts/` playbooks + the `npm run eb` Agent CLI let GitHub Copilot (or Claude Code, Cursor) generate, test, import and verify rules from the editor. Rules imported this way pass the same validation as in-app ones, so they can never break the running app.

## Tech stack

- **Runtime:** Node 22 LTS, JavaScript ES modules (`"type": "module"`), no TypeScript. JSDoc for editor type hints.
- **Single npm package** (no monorepo); code organized by folder under `src/`.
- **DB:** SQLite (`better-sqlite3`) via Drizzle ORM; migrations run automatically at startup. Keep it swappable for Postgres.
- **Validation:** zod, the single source of truth for rules, agent outputs, settings.
- **LLM:** Vercel AI SDK (`ai` + `@ai-sdk/anthropic`). **Any Claude model**, selected in Settings. The model dropdown is populated from the Anthropic Models API (`@anthropic-ai/sdk` → `client.models.list()`, cached 24h) with a free-text fallback.
- **Agent tools:** `@playwright/mcp` (always on) connected through the AI SDK MCP client (stdio), our own custom tools (`run_rule`, `get_recent_jobs`, …), and any extra MCP servers added in Settings (command + args + env, enable/disable per agent). Extra MCP servers must work on Windows and macOS (use `npx`/`node` commands, not shell scripts). Agents never get `browser_run_code_unsafe`, `browser_file_upload` or `browser_drop`. Each MCP tool result is capped at 12k characters (the agent drills in with `browser_find` / `browser_network_request`), and requests use Anthropic prompt caching, because every step re-sends the growing history.
- **Runner:** `fetch` for `api`/`html` rules, `cheerio` for HTML, `playwright` library for `browser` rules.
- **Scheduling:** `croner` (in-process cron, `protect: true` to prevent overlap) + `p-limit` pools. No Redis.
- **Server:** Fastify (REST + Server-Sent Events for live logs/task progress).
- **Dashboard:** React + Vite. In dev, Vite runs in middleware mode inside Fastify (single port); in prod, Fastify serves the built `web/dist`.
- **Logging:** `pino` (JSON), `pino-pretty` in dev, `pino-roll` rotating files, plus a DB sink for dashboard views.
- **Notifications:** Discord webhooks with embeds.
- **Tests:** `vitest` (unit/integration, recorded fixtures) + **`@playwright/test`** (end-to-end tests of the whole app: dashboard, API, scheduler, Discord, agents, CLI). See "E2E testing".

## Commands

| Command | What it does |
|---|---|
| `./setup.sh` (macOS/Linux) · `.\setup.ps1` (Windows) | First-time setup. Checks/installs Node, then runs `npm run setup`. See "Setup". |
| `npm run setup` | Cross-platform setup (`node scripts/setup.mjs`). Safe to re-run. |
| `npm run doctor` | Checks the environment (Node version, Chromium, DB, data dir, API key, webhooks) and prints what's missing and how to fix it. |
| `npm run eb -- mcp check` | Checks the Playwright MCP server starts (run before discovery from GitHub Copilot / Claude Code). |
| `npm run dev` | Preflight check, migrations, then API + scheduler + dashboard (Vite HMR) on `PORT` (default 3000), with `node --watch`. |
| `npm run build` | Builds the dashboard into `web/dist`. |
| `npm start` | Production: migrations + server + scheduler, serving `web/dist`. |
| `npm test` | Unit/integration tests (vitest). |
| `npm run test:e2e` | Playwright end-to-end tests against a fully running app with a mock portal, mock Discord and a mock LLM (no tokens spent). |
| `npm run test:e2e:ui` / `test:e2e:headed` / `test:e2e:debug` | Same, in Playwright UI mode / with a visible browser / with the inspector. |
| `npm run test:e2e:live` | Only tests tagged `@live`: real Claude + real public ATS portals. Manual, costs tokens. |
| `npm run test:all` | vitest + Playwright e2e (what CI runs). |
| `npm run test:report` | Opens the last Playwright HTML report (traces, screenshots, videos). |
| `npm run eb -- <command>` | Agent CLI for humans and external agents (Copilot, Claude Code): test/import/verify rules, manage companies and tasks. See "Prompts". |
| `npm run verify -- <ruleId> [--window 10m\|1h\|24h]` | Shortcut: run the in-app AI verification for a rule (same code as the dashboard button). |
| `npm run rule -- <ruleId> [--full]` | Shortcut: dry-run a stored rule and print jobs + timing (no DB writes, no Discord). |
| `npm run db:generate` | drizzle-kit: generate a migration after changing `src/db/schema.js`. |

The app must boot with **no `.env` at all**. Missing settings (API key, webhooks) show as warnings on the dashboard, and features that need them are disabled until they're set.

**Network access:** by default the server listens on `127.0.0.1` (this computer only). Set `HOST=0.0.0.0` in `.env` to reach it from other devices on the network. `EARLYBIRD_PASSWORD` is optional: when set, other devices must enter it (HTTP Basic, any username); without it the dashboard is open to anyone on the network. Requests from this computer never need it. On Windows, the firewall must allow inbound TCP on the port for the network profile in use.

## Setup (macOS, Windows, Linux)

Anyone should be able to clone the repo and run it on their own laptop. Prerequisites: **git** and **Node 22+** (the wrapper scripts help install Node if it's missing).

```bash
git clone https://github.com/HrithikMani/Earlybird.git && cd Earlybird
./setup.sh          # macOS / Linux
.\setup.ps1         # Windows PowerShell (or double-click setup.cmd)
npm run setup       # any OS that already has Node 22+
npm run dev         # then open http://localhost:3000
```

- **`setup.sh` / `setup.ps1` / `setup.cmd` are thin wrappers.** They only make sure Node 22+ is available (suggest/offer `brew` or `nvm` on macOS/Linux, `winget` on Windows; otherwise print the download link and exit) and then call `npm run setup`. All real logic lives in `scripts/setup.mjs` so it behaves the same on every OS.
- **`scripts/setup.mjs`** (idempotent, safe to re-run):
  1. Check Node version and OS/arch; print them.
  2. `npm ci` (or `npm install` if there's no lockfile).
  3. `npx playwright install chromium` (adds `--with-deps` on Linux only).
  4. Verify `better-sqlite3` loads (pinned to v12, which ships prebuilt binaries; v13+ compiles from source and needs Python + C++ build tools) (prebuilt binaries exist for Windows/macOS/Linux; if it fails, print the fix: `npm rebuild better-sqlite3` plus build-tool hints per OS).
  5. Create `data/`, `data/logs/`, `data/artifacts/`; create `.env` from `.env.example` if missing.
  6. Run DB migrations.
  7. Optional interactive questions (skip with `--yes`): Anthropic API key, Discord jobs + alerts webhooks, first roles to track. Saved into the settings table; everything can be changed later in the dashboard.
  8. Run `doctor` and print "Run `npm run dev` → http://localhost:3000".
- **`npm run dev` runs a quick preflight** (`scripts/preflight.mjs`: Node version, Chromium installed, data dir writable) and tells you to run `npm run setup` if something is missing, instead of crashing.
- **Cross-platform rules for all code and scripts:**
  - npm scripts only call `node …`/`vite`; no `rm -rf`, `cp`, `export FOO=…` or other shell-specific syntax. Set env vars in code.
  - Paths via `path.join` / `fileURLToPath(import.meta.url)`; never hardcode `/` or `\`.
  - Spawn MCP servers and child processes with `shell: false` and resolve `npx` as `npx.cmd` on Windows.
  - `.gitattributes`: `*.sh text eol=lf`, `*.ps1 text eol=crlf`, `*.cmd text eol=crlf`; `setup.sh` committed as executable.
  - Graceful shutdown handles `SIGINT`/`SIGTERM` and Windows Ctrl+C.
  - CI (GitHub Actions) runs `npm run setup -- --yes` and `npm run test:all` (vitest + Playwright e2e) on `windows-latest`, `macos-latest` and `ubuntu-latest`.

## Repo layout

```
earlybird/
  CLAUDE.md
  package.json
  setup.sh                # macOS/Linux wrapper -> npm run setup
  setup.ps1               # Windows wrapper -> npm run setup
  setup.cmd               # double-click wrapper that runs setup.ps1
  .gitattributes
  vite.config.js
  drizzle.config.js
  .env.example
  scripts/
    setup.mjs             # cross-platform setup (all real logic)
    preflight.mjs         # quick checks before `npm run dev`
    doctor.mjs            # environment diagnosis
  prompts/                # agent playbooks for the in-app agent AND Copilot/Claude Code (written last)
    README.md discover-rule.md verify-rule.md repair-rule.md suggest-synonyms.md
  .github/
    copilot-instructions.md
    prompts/*.prompt.md   # thin Copilot wrappers around prompts/*.md
    workflows/ci.yml      # tests on windows/macos/ubuntu
  .vscode/mcp.json        # Playwright MCP for Copilot agent mode
  src/
    schema/               # zod: rule, job, discovery result, verify report, settings
    db/                   # drizzle schema, migrations/, query helpers
    runner/               # runRule(rule, opts) -> jobs. Pure: no DB, no Discord, no LLM
      api.js html.js browser.js script.js script-sandbox.mjs paginate.js extract.js errors.js index.js
    agents/               # the ONLY place LLMs are called
      model.js            # builds AI SDK model from settings
      loop.js             # shared agent loop: guards, events, cost, abort
      tools.js            # custom tools: run_rule, get_rule, get_recent_jobs
      discovery.js        # discover -> candidates -> score -> pick
      verify.js           # AI verification of a rule
      prompts.js          # loads prompts/*.md, fills {{vars}}, records hash
    worker/
      scheduler.js        # croner jobs (scrape, discovery queue, cleanup, verify audit)
      scrape.js           # one run: rule -> dedupe -> store -> filter -> notify -> log
      pools.js dedupe.js stale.js health.js fallback.js
    tasks/
      registry.js         # in-memory map of running tasks/runs -> AbortController
      queue.js            # DB-backed task queue, concurrency, retry
      events.js           # task_events writer + SSE fan-out
    roles/                # effective roles per company, title matching, search terms
    notify/discord.js
    log/                  # pino setup, DB sink, redaction, SSE live tail
    settings/             # typed get/set with cache + change events (hot reload)
    server/               # fastify app, routes/, sse.js, static/vite
    cli/                  # eb.js (Agent CLI), verify.js, rule.js
  web/                    # React dashboard (Vite root)
  test/fixtures/          # recorded Greenhouse/Lever/Ashby JSON, sample HTML
  e2e/                    # Playwright end-to-end tests
    playwright.config.js
    fixtures/             # test fixtures: app, api, mockPortal, discordInbox, cli
    specs/                # *.spec.js, one per feature area
    agent-scripts/        # scripted mock-LLM conversations (JSON)
    support/
      app-server.mjs      # starts an isolated app instance (own port + temp data dir)
      mock-portal/        # local careers sites: ATS-like API, static HTML, JS SPA with search/sort/load-more
      mock-discord.mjs    # webhook receiver that records messages, can return 429
  data/                   # gitignored: earlybird.db, logs/, artifacts/, rules/ (script rule files)
```

## Rules

A **rule** describes how to fetch a portal's jobs. Two forms:

- **Declarative rule** (preferred): JSON matching the zod schema below (`api`, `html`, `browser`).
- **Script rule** (`type: "script"`): an AI-generated JavaScript module, used when JSON can't express what the portal needs (token handshakes, signed requests, odd GraphQL cursors, multi-step flows). The agent may write one, but **only a verified script goes live**: it must pass the same validation and scoring as any other rule (see Discovery), for every role term, in both fast and full mode, with every returned job passing the zod job schema.

The agent must also verify declarative rules by running them (`run_rule`) before answering.

- **ID:** `rul_` + 10-char nanoid. Immutable. Editing a rule creates a new version (new row, same `rule_key`, `version + 1`); runs reference the exact version they used.
- **Strategy:** `url` (type `api` or `html`), `playwright` (type `browser`), or `script` (type `script`).
- **Role per company:** `active` (used by the scheduler), `fallback` (validated runner-up), `candidate` (from a discovery, not promoted), `retired`.

### Rule schema

```jsonc
{
  "type": "api" | "html" | "browser",
  "strategy": "url" | "playwright",

  // api + html
  "url": "https://...",           // may include sort/filter query params, e.g. ?sort=newest&location=remote
  "method": "GET" | "POST",
  "headers": { },                 // optional
  "body": { },                    // optional, for POST APIs (e.g. Workday); may include sort/filter fields
  "jobs_path": "jobs",            // api only: dot-path to the jobs array
  "pagination": {                 // optional
    "kind": "offset" | "page" | "cursor",
    "param": "offset",
    "cursor_path": "next",        // cursor only: dot-path to next cursor in response
    "page_size": 20,
    "max_pages": 20
  },

  // field mapping: dot-paths (api) or CSS selectors (html/browser).
  // "a.title" = text content, "a.title@href" = attribute.
  "item_selector": ".job-card",   // html/browser only
  "fields": {
    "id": "id",                   // strongly preferred: the portal's own job/requisition id
    "title": "title",
    "url": "absolute_url",
    "location": "location.name",  // optional
    "department": "departments.0.name", // optional
    "posted_at": "updated_at"     // strongly preferred: selector/path of the posted date or "3 days ago" label
  },
  "id_from_url": "/jobs/(\\d+)",  // optional regex: extract a stable id from the job URL when there's no id field
  "posted_at_format": "relative" | "iso" | "custom", // how to parse posted_at ("2 hours ago", ISO date, or a pattern)
  "posted_at_pattern": "MMM d, yyyy", // custom only
  "url_prefix": "https://acme.com", // optional, for relative links

  // role search: how the portal is searched for the company's roles.
  // "{{query}}" may appear in url, body values, and fill/select action values;
  // the runner substitutes each search term (URL-encoded inside urls).
  "search": {
    "mode": "per_term" | "combined" | "none",
    // per_term: run once per role term, merge + dedupe results
    // combined: one run with all terms joined by combine_with
    // none: portal can't search; fetch all, match roles in code
    "combine_with": " OR ",       // combined only
    "term_source": "roles"        // terms come from the company's effective roles at run time
  },

  // browser only: ordered actions; the runner rejects anything else
  "actions": [
    { "do": "goto", "url": "https://acme.com/careers" },
    { "do": "wait", "selector": ".job-card" },
    { "do": "fill", "selector": "input[name=q]", "value": "{{query}}" },
    { "do": "select", "selector": "select#sort", "value": "newest" },
    { "do": "click", "selector": "button:has-text('Newest')" },
    { "do": "click", "selector": "button:has-text('Load more')", "repeat_until_gone": true, "max_repeats": 20 },
    { "do": "scroll", "until_no_change": true, "max_scrolls": 20 },
    { "do": "extract" }
  ],

  // freshness: how the fast sweep gets the newest jobs cheaply
  "sorted_newest_first": true,    // true if URL params / actions put newest jobs first
  "fast_max_pages": 1,            // pages (or load-more clicks) for a fast sweep; ignored if not sorted

  "expected_min_jobs": 1,
  "interval_min": 10
}
```

Allowed browser actions: `goto`, `wait`, `click`, `fill`, `select`, `scroll`, `extract`. Nothing else.

### Script rules

```jsonc
{
  "type": "script",
  "strategy": "script",
  "uses_browser": false,          // true -> the script gets a Playwright `page`
  "entry": "rul_ab12cd34ef.mjs",  // stored at data/rules/<rule_id>.mjs (code also saved in DB)
  "search": { "mode": "per_term" | "combined" | "none" },
  "sorted_newest_first": true,
  "fast_max_pages": 1,
  "expected_min_jobs": 1,
  "interval_min": 10
}
```

Contract (the file must export exactly this):

```js
// data/rules/<rule_id>.mjs
export default async function fetchJobs({ terms, mode, signal, fetch, cheerio, page, log }) {
  // return [{ external_id?, title, url, location?, department?, posted_at?, search_term? }, ...]
}
```

- **Sandboxed execution:** scripts run in a separate Node child process (not the server process) using the Node permission model: read access only to the script file, no filesystem writes, no `child_process` (except browser scripts, whose worker owns its own Chromium), no env vars or secrets. Wall-clock timeout and memory limit from Settings. Only the injected helpers are available; imports are blocked except `node:` built-ins that the permission model allows.
- **Output is validated** with zod, exactly like declarative rules. A script that throws, times out or returns malformed jobs fails the run with a typed error (`ScriptError`, `Timeout`, `ParseError`) and full detail (stack, stdout/stderr excerpt).
- **Versioned and visible:** the code is stored in `rules.code` with `code_hash`, shown read-only in the dashboard with syntax highlighting, and editing creates a new version that must pass validation again.
- **Settings:** `allow_script_rules` (default on), `script_rules_require_approval` (default off: a validated script can go live automatically; on: it waits for a human to click Approve).
- In scoring, scripts get a cost/maintainability penalty (api 1.0, html 0.8, script 0.6, browser 0.4), so declarative rules win when they're equally good.

Because search terms are injected at run time, **adding or editing a role does not require re-running discovery**. The next run searches with the new terms. The dashboard offers a dry run after role changes to confirm it.

## Roles

- **Global roles** (Settings → Roles): e.g. "Software Developer", "DevOps Engineer". They apply to every company.
- **Company roles** (company page): extra roles for one company, e.g. Tesla: "AI Engineer", "Infrastructure Engineer".
- **Role mode per company:** `global_plus_company` (default), `company_only`, or `all_jobs` (no role filtering).
- **Each role has:** a name, **search terms** (what's typed/sent to the portal; defaults to the name), **title synonyms** for matching (e.g. Software Developer → "software engineer", "SWE", "backend engineer"), optional **exclude words** (e.g. "manager"), and an enabled flag. A "Suggest synonyms" button can ask the AI for synonyms (runs as a normal task; the human accepts or edits them).
- **Search at the portal** (via the rule's `search` + `{{query}}`) narrows what's fetched. **Title matching in code** decides what's notified, because portal search is often fuzzy. Matching is case-insensitive and word-boundary based against name + synonyms, and `matched_roles` is stored on each job.
- `max_terms_per_run` (Settings, default 10) caps `per_term` searches so browser rules don't explode in cost; beyond the cap, the rule falls back to fetching all jobs and matching in code.

## Data model

All tables have `created_at`/`updated_at`. IDs are prefixed nanoids (`cmp_`, `rul_`, `run_`, `tsk_`, `job_`, `vfy_`).

**roles**: `id, name, scope (global|company), company_id (null for global), search_terms_json, synonyms_json, exclude_words_json, enabled`

**companies**: `id, name, careers_url, status, role_mode (global_plus_company|company_only|all_jobs), active_rule_id, fallback_rule_id, interval_min, source_filters_json (applied at the portal: location/department), notify_filters_json (per-company override), discord_channel_id, last_run_at, last_success_at, last_full_sweep_at, consecutive_failures, consecutive_zero_runs, last_job_count, health_state`

**rules**: `id, rule_key, version, company_id, role, type, strategy, spec_json, code (script rules only), code_hash, approved_at, score_json, source_task_id, created_by (discovery|manual|promotion), notes`

**jobs** (current listings, pruned): `id, company_id, rule_id, job_key, external_id, canonical_url, fingerprint, title, url, location, department, posted_at, posted_at_raw, matched_roles_json, search_term, first_seen_at, last_seen_at, seen_count, missing_sweeps, closed_at, notify_status (pending|sent|skipped), notify_skip_reason`. Unique `(company_id, job_key)`.

**seen_jobs** (permanent memory of every job ever seen, long retention): `company_id, job_key, external_id, canonical_url, fingerprint, title, first_seen_at, last_seen_at, first_rule_id, notified_at`. Unique `(company_id, job_key)`; indexes on `(company_id, canonical_url)` and `(company_id, fingerprint)`. Pruned only after `seen_retention_days` (default 365).

**notifications** (outbox, one row per job per channel): `id, company_id, job_key, channel_id, status (pending|sent|failed), discord_message_id, attempts, last_error, created_at, sent_at`. Unique `(company_id, job_key, channel_id)`.

**runs** (every scheduled/manual scrape): `id, company_id, rule_id, mode (fast|full), trigger (schedule|manual|fallback), status (running|ok|error|cancelled), started_at, duration_ms, http_status, job_count, new_job_count, closed_job_count, error_type, error_message, error_detail_json, artifacts_json`

**tasks** (every agent or long operation): `id, kind (discovery|verify|run_now|rediscover), company_id, rule_id, parent_task_id (retry chain), attempt, status (queued|running|cancelling|succeeded|failed|cancelled|killed|timed_out|interrupted), input_json, result_json, error_type, error_message, model, prompt_file, prompt_hash, steps, input_tokens, output_tokens, cost_usd, started_at, finished_at, operator_note`

**task_events**: `id, task_id, ts, seq, level, type (status|step|tool_call|tool_result|model_text|guard|log), data_json`

**verifications**: `id, rule_id, company_id, task_id, window, verdict, report_json`

**logs**: `id, ts, level, msg, scope (server|scheduler|run|task|discord|http), company_id, rule_id, run_id, task_id, data_json`

**alerts**: `id, company_id, rule_id, kind, state, message, sent_at, resolved_at`. Dedupe: one alert per company per state change.

**settings**: `key, value_json`. Validated by zod on write.

## Company lifecycle

```
pending_discovery -> discovering -> active
                                 -> needs_review     (no candidate passed validation)
active  -> degraded   (warning thresholds; still scheduled)
active  -> failing    (failure threshold; fallback tried; still scheduled with backoff)
failing -> active     (next healthy run)
any     -> paused     (manual)
any     -> pending_discovery (manual "Re-run discovery")
```

## Discovery: URL rule or Playwright rule, whichever is optimal

Triggered when a company is added, when "Re-run discovery" is clicked, or suggested after a failed verification. Runs as a **task** (see Tasks), never inside an HTTP request.

**Inputs to the agent:** company name, careers URL, the company's **effective roles** (name + search terms), source filters (location/department), and an optional operator note.

**The agent works in four explicit phases**, and the prompt (`prompts/discover-rule.md`) walks it through them in this order. Each phase shows up as a labelled `phase` event in the task's live view, so you can see where it is:

1. **Explore:** open the careers page in Playwright (MCP) and load it like a user would.
2. **Analyze:**
   - the **URL** (path, query params, ATS domain)
   - the **page** (how listings are rendered, item markup, pagination / "load more")
   - the **network requests** (ATS API or hidden JSON endpoint)
   - the **search and filters**: how to search by role, filter by location, and above all **how to get the newest jobs** (sort-by-date param or control, date labels, where new postings appear)
3. **Build and test rules:** form a URL rule and a Playwright rule (or a script if needed) from what it learned. Run each with `run_rule` using the real role terms, and check that the results contain the **newest jobs it saw on the site** with the correct titles, links and dates. Fix and re-run until they do.
4. **Commit:** return the tested candidates plus evidence (newest titles, visible counts). Code then validates, scores, saves the winner as active and the other as fallback, and records the baseline. The task ends with a clear summary: "Rules committed and ready for scheduled runs", with the active rule id, its strategy, and why it won.

1. **Agent run** with `prompts/discover-rule.md`, Playwright MCP tools, any enabled extra MCP servers, and the custom `run_rule` tool so the agent can test rules itself (including with real role terms) before answering.
2. The agent works out **how this portal can be searched/filtered by role, location and date**:
   - URL route: ATS API params, hidden JSON endpoint params, or query strings (`?q=devops&sort=newest`).
   - Playwright route: search box, category/team dropdowns, "sort by newest", "load more".
3. It returns up to **two candidates**: one `url` strategy and one `playwright` strategy, each with a `search` config and `{{query}}` placeholders where role search applies. If neither JSON form can work (or works badly), it may return a **`script` candidate** instead, after testing it with `run_rule`. A strategy that can't work is omitted, with the reason in `evidence`.
4. **Parse** with zod. On error, feed the error back to the agent (counts toward the attempt limit).
5. **Validate and score each candidate in code** by running it through `runner` twice with the real role terms:
   - hard requirements: `>= expected_min_jobs` jobs, every job has a title and an absolute URL, both runs succeed
   - `freshness` = fraction of `evidence.newest_titles` (newest matching jobs the agent saw on the site) found in the results (fuzzy match)
   - `completeness` = min(role-matched job_count / evidence.visible_role_job_count, 1)
   - `relevance` = share of returned jobs whose titles match the roles (rewards portal-side filtering)
   - `stability` = both runs return the same count ±5%
   - `cost` = api 1.0, html 0.8, script 0.6, browser 0.4, adjusted for number of search runs and latency
   - every role term is exercised, fast and full mode both run, and **every** returned job must pass the zod job schema (title, absolute URL, stable `external_id`)
   - `score = 0.30·freshness + 0.25·completeness + 0.15·relevance + 0.10·stability + 0.20·cost`. Ties go to the cheaper rule.
6. If no candidate passes, send the validation errors back to the agent and retry (max attempts from Settings, default 3).
7. **On success:** the higher score becomes `active` (whichever strategy that is). If the other candidate also passed, it becomes `fallback`. All scores are saved in `score_json`, current jobs are inserted as a **baseline** (`notified_at` set, no Discord), and `status = active`. The dashboard shows the side-by-side comparison, and the user can promote the other candidate with one click.
7. **On final failure:** `status = needs_review`, agent notes + screenshot kept, alert sent.

## Verification: is this rule really catching the newest jobs?

On demand from the dashboard (rule or company page) or `npm run verify -- <ruleId> --window 1h`. Optionally scheduled from Settings (off by default because it spends tokens).

1. **Deterministic pre-checks (no LLM):** run the rule (fast + full), compare with DB jobs, compute: jobs first-seen within the window, newest `posted_at`, detection lag (`first_seen_at - posted_at`), last successful run age, recent errors.
2. **Agent check** with `prompts/verify-rule.md`: the agent opens the live portal with Playwright, sorts/filters for the newest postings, lists jobs posted in the window (10 min / 1 h / 24 h, or the top N newest if the site shows no dates), and compares them with the rule output and DB (via `run_rule`, `get_recent_jobs`).
3. **Report** (zod-validated) stored in `verifications`: `verdict: healthy | missing_recent | stale | broken | inconclusive`, missing jobs, extra notes, `suggested_action: none | rerun_discovery | promote_fallback | edit_rule | check_manually`. The AI never changes a rule; a human acts on the suggestion from the dashboard.

## Runner

`runRule(rule, { mode: 'fast'|'full', terms: string[], signal, logger }) => Promise<{ jobs, meta }>`

- Normalizes to `{ external_id, title, url, location?, department?, posted_at?, search_term? }`; `external_id` = mapped id, else `sha256(url)`.
- Role search: substitutes `{{query}}` per `search.mode` (`per_term` runs once per term, sequentially for browser rules, and merges/dedupes by `job_key`). The runner stays pure: the caller passes `terms`, the runner never reads roles from the DB.
- `fast`: if `sorted_newest_first`, stop after `fast_max_pages`; otherwise behaves like `full`.
- `full`: follow pagination until an empty page or `max_pages`.
- Honors `signal` (AbortController) at every await: fetch, page load, action, pagination step.
- Browser rules: headless Chromium, fresh context per run, 30s action timeout, realistic UA, always closes the context in `finally`.
- `meta`: pages fetched, requests made, bytes, timings per request/action, final URL, response status.
- Script rules: executed in the sandboxed child process described under "Script rules"; `signal` kills the child.
- Typed errors (`class RunnerError extends Error` with `type`, `retryable`, `detail`): `NetworkError`, `HttpError(status)`, `ParseError`, `SelectorNotFound`, `Timeout`, `Blocked` (403/429/captcha), `ScriptError`, `Cancelled`, `InvalidRule`.

## Worker and cron jobs

Registered with `croner` at boot. Schedules come from Settings and are re-registered live when changed.

- **Scrape tick** (every minute): pick companies with `status in (active, degraded, failing)` that are due. A run is a **full sweep** if `last_full_sweep_at` is older than `full_sweep_every_min` (default 60), otherwise **fast**. Random jitter 0–60s per company.
- **Pools:** `api`/`html` (default 20), `browser` (default 3), `agent` (default 1).
- **Per run:** resolve effective roles → execute rule with their search terms → dedupe within the run → match against `seen_jobs` by id / canonical URL / fingerprint → match roles on titles → one transaction: insert new jobs + upsert `seen_jobs` + queue `notifications` (see "Seen jobs") → update `last_seen_at` → (full sweep only) mark missing jobs → Discord sender drains the outbox → write `runs` row + logs → update health.
- **Discovery queue** (every minute): starts queued discovery/verify tasks up to the agent pool limit.
- **Cleanup** (daily, configurable): stale jobs, old runs/logs/task_events/artifacts, `seen_jobs` older than `seen_retention_days`, sent `notifications` older than 30 days, SQLite `VACUUM` weekly.
- **Heartbeat:** every tick writes `scheduler.last_tick_at`, due backlog and pool usage. The dashboard flags the scheduler as unhealthy if no tick for 3 minutes.
- **Shutdown** (SIGINT/SIGTERM): stop cron, abort in-flight work, wait up to 10s, mark leftovers `interrupted`, close DB.
- **Startup:** tasks/runs left `running` from a crash become `interrupted` and can be retried.

## Stale jobs

- A job not present in a **full sweep** gets `missing_sweeps + 1`; at 2 it's marked `closed_at` (posting taken down). Seen again → reopened.
- Closed jobs are deleted after `closed_job_retention_days` (default 3).
- **Job age window** (Settings → Filters `maxJobAgeDays`, default **7 days**, per-company override): jobs posted earlier are never listed, shown or sent. They are only recorded in `seen_jobs`. Cleanup also removes listings that age out.
- **Job cap** (`maxJobsPerCompany`, default **100**): rules read at most the newest 100 jobs per run (pagination stops early) and cleanup keeps only each company's newest 100 listings. Beyond the newest ~100 postings nothing is relevant to "new jobs".
- **Dates from detail pages:** when a rule's list has no posted dates (e.g. Meta), the worker reads `datePosted` from the JSON-LD on the detail page of each job it doesn't know yet: plain HTTP first, then the browser if HTTP is blocked, at most 15 per run (40 on a baseline). The date is stored in `seen_jobs.posted_at`, so each detail page is read at most once. A rule can opt out with `"enrich_dates": "off"`.
- Listings first seen more than `keepJobsDays` (default 30) ago are deleted.
- Deleted jobs stay in `seen_jobs`, so they're never re-notified (see "Seen jobs").
- Fast sweeps never close jobs (they only see page 1).

## Seen jobs: every job is notified at most once

**Only jobs Earlybird has never seen before are sent to Discord.** Every job fetched is remembered in `seen_jobs`, whether or not it matched a role, was filtered, or was part of a baseline, so it's never "new" again.

### Job identity

Each scraped job gets three keys, computed in `src/worker/dedupe.js`:

1. **`external_id`**: the portal's own id (rule `fields.id`), else extracted with `id_from_url`, else missing.
2. **`canonical_url`**: the job URL normalized: lowercase host, `https`, no fragment, no trailing slash, tracking/session params removed (`utm_*`, `gh_src`, `source`, `ref`, `lever-source`, session ids; list editable in Settings), remaining params sorted.
3. **`fingerprint`**: `sha256(normalized title + normalized location + company_id)`. It catches the same job appearing under a new id or URL.

`job_key` = `external_id` when present, else `sha256(canonical_url)`.

A job counts as **already seen** if **any** key matches a `seen_jobs` row for that company. This keeps working when:
- the URL gains new tracking params
- the active rule changes (rediscovery, fallback, manual edit, CLI import) and the new rule produces different ids or URLs
- the same job shows up under two role search terms in one run
- a job disappears and reappears, or is reposted

When a match is found via URL or fingerprint but the `job_key` differs, the seen row is **re-keyed** (aliases kept), and this is logged.

### What's stored per job while scraping

The runner returns, and the worker stores: `external_id`, `url` + `canonical_url`, `posted_at_raw` (exact text/value from the posted-date selector or path) + parsed `posted_at` (UTC), `first_seen_at`, `last_seen_at`, `seen_count`, the `rule_id` and `search_term` that found it, and `notify_status` + `notify_skip_reason`. Discovery must map a stable **id** (or `id_from_url`) and the **posted date** selector/path whenever the portal has them. Scoring adds `id_stability` (same ids across both validation runs).

### Notification decision (per new job)

A job is sent to Discord only if **all** hold, otherwise it's stored with a `notify_skip_reason`:

| Check | Skip reason |
|---|---|
| Not in `seen_jobs` by any key | `already_seen` |
| Not part of a baseline (first run of a company, new rule activation, new role term) | `baseline` |
| Title matches an effective role (unless `all_jobs`) | `role_mismatch` |
| Passes exclude keywords + location filters | `filtered` |
| `posted_at` (if known) is within the job age window (`maxJobAgeDays`) | `too_old` (not listed at all) |

- **Reposts:** a job that reappears after being closed isn't re-sent. `renotify_reposted_after_days` (default off) can allow it.
- **New role terms get a silent baseline:** when a role is added, the first run with the new term records its results as seen without notifying. Otherwise adding "DevOps Engineer" would flood Discord with every existing DevOps job. Toggle per role: "notify existing matches once".

### Exactly-once sending (outbox)

1. In **one DB transaction**: insert the job, upsert `seen_jobs`, and insert a `notifications` row (`pending`) for each target channel. The unique `(company_id, job_key, channel_id)` makes a duplicate send impossible.
2. The Discord sender drains `pending` rows, posts with `?wait=true` to get the Discord message id, and marks the row `sent` with `discord_message_id`.
3. Failures (network, 429, 5xx) retry with backoff; the row stays `pending`/`failed` and is **never duplicated**. After a crash/restart, only `pending` rows are sent.
4. A run's results are deduped within the run before anything is written.

### Visibility

- The job detail on the dashboard shows first/last seen, seen count, the rule and search term that found it, posted date (raw + parsed), notify status, skip reason, and a link to the Discord message.
- The jobs feed can filter by notify status / skip reason ("why wasn't this sent?").
- Each run logs `fetched / already_seen / new / notified / skipped (by reason) / rekeyed`.

## Health, failures and fallback (code only, no LLM)

- 3 consecutive errors → `failing`, alert.
- HTTP 404 / `SelectorNotFound` on the rule → `failing` immediately, alert.
- `Blocked` (403/429/captcha) → double interval (cap 60 min), exponential backoff, alert.
- 0 jobs after a non-zero run → alert after 2 consecutive zero runs.
- Job count drops >80% vs the previous full sweep → `degraded`, warn.
- No new job for a long time relative to that company's history (e.g. 5× its median gap) → `degraded`, suggest a verification.
- **Fallback:** when the active rule is `failing`, the next run uses the validated `fallback` rule (`trigger = fallback`). If it succeeds, the company keeps running on it and an alert asks the human to promote it or re-run discovery. Rules are never auto-rewritten.
- Back to healthy → `active`, "recovered" alert. Max one alert per company per state change.

## Tasks: see, stop, kill, retry

Every discovery, verification and manual "Run now" is a **task**. Scheduled scrape runs appear in the same "Running now" view.

- **Live view:** the dashboard streams `task_events` over SSE: each agent step, the model's text, every tool call (name + args, truncated) and result summary, tokens, running cost, guard warnings.
- **Stop:** aborts the `AbortController` (AI SDK `abortSignal`, runner `signal`). Status becomes `cancelling`, then `cancelled`.
- **Kill:** Stop, plus force-close the Playwright browser/MCP process after a 5s grace. Status becomes `killed`.
- **Retry:** creates a new task (`parent_task_id`, `attempt + 1`) with the same input and an optional operator note appended to the prompt (e.g. "the jobs are behind the 'Engineering' tab").
- **Guards** (all configurable in Settings) stop runaway agent loops:
  - `max_steps` (default 60). Two steps before the limit the agent's tools are removed and it must commit the rules it has already tested.
  - `max_wall_time_min` (default 10)
  - `max_cost_usd` per task (default **$2**, from token usage × the model price table; cache reads are priced at 0.1×)
  - **loop detection:** the same tool called with identical input **and an identical result** 3 times (re-checking a page that changed is progress), or no new tool calls for 8 steps → abort with `error_type = loop_detected`
  - `max_attempts` for discovery retries (default 3)
- A guard trip is logged as a `guard` event with the reason, so "why did it stop" is always answered.
- **Diagnostics for prompt tuning:** every agent step is logged (`scope = task`) with its phase, tools, tokens and cost, and every failed tool call (MCP `isError`, `run_rule` errors, invalid tool input) is logged as a warning. The task stores `result.diagnostics` (cost/steps/failed calls per phase + totals), the task page shows a Diagnostics card and "Took 5m 24s · 29 steps · $0.61", and `GET /api/tasks/:id/transcript` downloads the full event log as JSON.

## Logging

Goal: from the dashboard alone, you can tell what failed, where, why, and whether the system is working.

- **pino** everywhere, one root logger with child loggers carrying context: `{ scope, company_id, rule_id, run_id, task_id }`.
- **Sinks:** stdout (pretty in dev), rotating JSON files in `data/logs/` (daily, `log_retention_days`), and the `logs` table (info+ for run/task scopes, warn+ for everything else) for dashboard search.
- **Every run logs:** start (mode, rule id/version, trigger), each HTTP request (method, url, status, ms, bytes) or browser action (index, action, selector, ms), pagination progress, result counts (total/new/closed/filtered/notified), end status + duration.
- **Every failure records `error_detail_json`:** error type, message, stack, cause chain, request url/method/status, selected response headers, first 2 KB of the response body, and for browser rules the failing action index + selector + page URL + a screenshot and an HTML snapshot (optionally a Playwright trace, toggle in Settings) saved under `data/artifacts/<run_id>/`.
- **Agent tasks log** every step as `task_events` plus a summary log line (model, steps, tokens, cost, outcome, guard trips).
- **Discord** sends and failures (status, retry_after) are logged.
- **Process level:** `uncaughtException`/`unhandledRejection` are logged at fatal with stack. Boot logs version, settings summary (secrets redacted) and migration status.
- **Redaction:** API keys, webhook URLs and auth headers are always redacted.
- **Health endpoint:** `GET /api/health` returns scheduler heartbeat, DB ok, pools, running tasks, last errors.

## E2E testing (Playwright)

Every feature is covered by Playwright end-to-end tests that drive the **real app** (dashboard in a browser + API + scheduler + runner + CLI) against **local mocks**, so tests are fast, free and deterministic, and run on Windows, macOS and Linux.

### Harness

- **`@playwright/test`**, config in `e2e/playwright.config.js`. Chromium only; `fullyParallel`; retries 2 in CI, 0 locally; `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`; HTML report + GitHub reporter in CI. Chromium is already installed by `npm run setup`.
- **Isolated app per Playwright worker:** a worker-scoped `app` fixture starts `e2e/support/app-server.mjs` on port `3100 + workerIndex` with a fresh temp `DATA_DIR` (own SQLite DB, logs, artifacts) and tears it down afterwards. Tests never share state and never touch your real `data/`.
- **Test mode** (`EARLYBIRD_TEST=1`, only set by the harness):
  - LLM calls go to the **AI SDK mock language model** (from `ai/test`), which replays scripted conversations from `e2e/agent-scripts/*.json` (tool calls, text, final JSON, deliberate loops, slow steps). No API key needed and no tokens spent.
  - Extra routes under `/api/test/*` are enabled: `tick` (run the scheduler now), `advance-clock` (fake time for intervals, stale-job and retention logic), `reset`. These routes are **never registered** outside test mode.
  - Discord webhooks point to **mock Discord** (`mock-discord.mjs`), which records every payload and can be told to return 429 with `retry_after`.
- **Mock portal** (`e2e/support/mock-portal/`): a local server hosting fake careers sites that tests control through an API (add/remove jobs, change sort order, rename a CSS class, return 404/403/429, show a captcha page, slow responses):
  - `ats-api`: Greenhouse/Lever/Ashby-shaped JSON endpoints with pagination and search params
  - `static-html`: server-rendered listings
  - `spa`: JS-rendered page with a search box, category dropdown, "sort by newest" and "load more" (only reachable by a Playwright rule)
  - `script-only`: needs a token handshake that JSON rules can't express (exercises script rules)
- **Fixtures** (`e2e/fixtures/`): `app` (URL, DB helpers), `api` (typed REST client), `mockPortal`, `discordInbox` (`await discordInbox.waitFor({ title: /DevOps/ })`), `cli` (runs `npm run eb -- … --json` against the worker's app and parses output).
- **Selectors:** the dashboard uses `data-testid` on every interactive element and status badge; tests use `getByTestId`/`getByRole`, never CSS classes.
- **Page objects** for the main screens (Companies, Company detail, Roles, Tasks, Logs, Settings) live in `e2e/fixtures/pages/`.

### What's covered (one spec file per area)

| Spec | Scenarios |
|---|---|
| `setup.spec.js` | First boot with no `.env`: dashboard loads, missing API key/webhook warnings, `/api/health` ok. |
| `settings.spec.js` | Save/validate every tab, secrets masked, model dropdown + free text, Discord "Send test" reaches mock Discord, hot-reload of schedules. |
| `roles.spec.js` | Global + company roles, role modes, synonyms, exclude words, title matching, dry run after role change (no rediscovery needed). |
| `discovery.spec.js` | Add company → discovery task streams live → URL vs Playwright candidates compared → winner active, other kept as fallback → baseline inserted with **no** Discord messages; `needs_review` when nothing passes. |
| `notifications.spec.js` | New job on mock portal → tick → one Discord embed with matched role; non-matching and excluded jobs stored but not sent; batching; 429 retry. |
| `sweeps.spec.js` | Fast sweep only reads page 1 of a newest-first portal; full sweep reads all pages. |
| `stale-jobs.spec.js` | Job removed → closed after 2 full sweeps → deleted after retention → `seen_jobs` stops re-notification when it reappears. |
| `dedupe.spec.js` | Same job never sent twice: tracking-param URL change, rule switch (rediscovery / fallback / CLI import) with new ids, same job under two search terms, repost after close, new role term → silent baseline, app killed mid-send → restart sends only pending, Discord 429 retry without duplicates. |
| `failures.spec.js` | 404 / selector change → `failing` + alert → fallback rule used → recovery alert; 403/429 → interval doubled; 0-job and −80% drops. |
| `tasks.spec.js` | Stop, Kill and Retry (with operator note) a running agent task; guard trips for max steps, wall time, cost and **loop detection**; `interrupted` after app restart. |
| `verification.spec.js` | Verify with 10m / 1h windows → report + verdict shown; `missing_recent` when the portal has a job the rule misses. |
| `rules.spec.js` | Edit rule JSON: invalid rejected, valid saved as a new version after test run; promote fallback; rollback; rule page shows runs/jobs. |
| `script-rules.spec.js` | Script rule passes validation and runs; sandbox blocks file writes, env access and child processes; approval flow when required. |
| `agent-cli.spec.js` | `eb rule test` / `rule import --activate` / `verify save` while the app runs; a failing import never changes the active rule; dashboard reflects imports. |
| `logs.spec.js` | Failed run shows error type, request/response detail, failing browser step, screenshot artifact; live tail; search by rule/run/task; secrets redacted. |
| `jobs-feed.spec.js` | Search and filter jobs by company, role, location, open/closed. |
| `health.spec.js` | Scheduler stalled → dashboard banner + alert; heartbeat recovers. |
| `live/*.spec.js` (`@live`) | Real Claude discovers and verifies rules for a few real public Greenhouse/Lever boards. Excluded from CI. |

### Rules for writing tests

- **Every feature ships with its e2e spec** in the same phase; a phase isn't done until its specs pass.
- Tests don't wait on real time: use `/api/test/tick` and `advance-clock` plus Playwright's auto-waiting (`expect.poll`, `toHaveText`), never `waitForTimeout`.
- Tests never hit the internet (except `@live`); the config blocks non-localhost requests in test mode.
- Bug fixes add a regression spec (or vitest test) that fails before the fix.
- CI (`.github/workflows/ci.yml`) runs `npm run setup -- --yes` and `npm run test:all` on `windows-latest`, `macos-latest` and `ubuntu-latest`, and uploads the Playwright report + traces as artifacts on failure.

## Settings (all editable in the dashboard, stored in DB, hot-reloaded)

- **Roles:** global roles (name, search terms, synonyms, exclude words, enabled), `max_terms_per_run`.
- **AI:** Anthropic API key, discovery model, verification model (any Claude model from the Models API list or typed in), effort, guard limits, model price table (for cost tracking), scheduled verification (off/on + cron + window).
- **MCP tools:** Playwright MCP options (headless, browser), extra MCP servers (name, command, args, env), each toggled per agent (discovery / verification), with a "Test connection" button that lists the server's tools.
- **Discord:** named channels (webhook URLs) with a "Send test" button; default jobs channel, alerts channel, per-company channel override, embed batch size.
- **Scheduling:** default interval, minimum intervals (api/html 10 min, browser 15 min), full-sweep interval, jitter, pool sizes.
- **Filters:** job age window (`maxJobAgeDays`, default 7), max jobs per company (`maxJobsPerCompany`, default 100), global exclude keywords and locations (per-company overrides on the company page). Roles, keywords and locations decide what gets **notified**; jobs inside the age window and cap are stored.
- **Dedupe & notify:** `renotify_reposted_after_days`, tracking params stripped from URLs, "Resend" button per job (manual only).
- **Retention:** closed jobs, max job age, seen jobs (`seen_retention_days`), runs, logs, task events, artifacts.
- **Logging:** level, save Playwright traces on failure.
- **Scraping:** user agent, respect robots.txt.

`.env` only bootstraps: `PORT`, `DATA_DIR`, `LOG_LEVEL`, and optionally `ANTHROPIC_API_KEY` (used only if the setting is empty).

## Dashboard

- **Overview:** system health (scheduler heartbeat, pool usage, running tasks), counts, jobs found today, open alerts, companies needing attention.
- **Roles:** manage global roles (add/edit/disable, search terms, synonyms, "Suggest synonyms"), and see how many open jobs match each role across companies.
- **Companies:** list with status, roles, active rule id + strategy (URL/Playwright), last success, last job seen, next run. **Add company:** name, careers URL, **company-specific roles** + role mode, optional source filters (location/department, applied at the portal), notify filters, channel. The discovery task opens live.
- **Company detail:** roles (global + company, editable, with a dry run showing what each role returns), active + fallback rule (id, version, strategy, JSON, score), last discovery's candidate comparison, rule history, runs (with error details and artifacts), jobs, verifications. Actions: Run now (fast/full), Verify (window picker), Re-run discovery, Promote fallback/candidate, Edit rule (JSON editor, validated + test-run before saving as a new version), Pause/Resume, Delete.
- **Rule page** (`/rules/:id`): everything about one rule version (runs, jobs, verifications), dry-run output, and for script rules the code viewer + Approve button (when approval is required).
- **Tasks:** running + recent tasks and runs, a live event stream, Stop / Kill / Retry (with note), token and cost totals.
- **Jobs:** searchable feed (company, title, location, open/closed, notified).
- **Logs:** live tail + search by level, scope, company, rule, run, task.
- **Settings:** tabs per section above.

## Prompts: playbooks for any agent (in-app or GitHub Copilot)

`prompts/` holds **agent-agnostic playbooks** for rule work. The same files are used in two ways:

1. **By the app's own agent** (Vercel AI SDK): `src/agents/prompts.js` loads them fresh for each task (edits apply without restart), fills `{{placeholders}}`, and stores `prompt_file` + `prompt_hash` on the task.
2. **By an external coding agent** such as **GitHub Copilot** (agent mode), Claude Code or Cursor, working in this repo. The agent follows the playbook and uses the **Agent CLI** (below) instead of in-app tools. This lets you generate, verify and fix rules from your IDE, with the app still running, **without any risk of breaking it**: every rule goes through the same validation and scoring pipeline before it can go live.

### Playbooks

| File | Purpose |
|---|---|
| `prompts/README.md` | How to use the playbooks from Copilot/Claude Code, the tool ↔ CLI mapping, and an example session. |
| `prompts/discover-rule.md` | Generate URL / Playwright / script candidates for a company and its roles. |
| `prompts/verify-rule.md` | Check whether a rule catches the newest jobs in a window (10m / 1h / 24h). |
| `prompts/repair-rule.md` | Fix a failing or `missing_recent` rule, starting from its latest failed run / verification report. |
| `prompts/suggest-synonyms.md` | Suggest title synonyms and search terms for a role. |

Each playbook has the same structure: **Goal**, **Inputs** (`{{placeholders}}`), **Steps**, **Tools** (a table giving the in-app tool name *and* the equivalent CLI command for each capability), **Rules/constraints**, and **Output** (the exact JSON shape, matching a zod schema in `src/schema/`).

| Capability | In-app agent tool | External agent (CLI) |
|---|---|---|
| Browse the portal | Playwright MCP | Playwright MCP from `.vscode/mcp.json` |
| Get the rule JSON schema | (embedded in prompt) | `npm run eb -- schema rule` |
| Get company + effective roles | (embedded in prompt) | `npm run eb -- company show <companyId> --json` |
| Test a draft rule | `run_rule` | `npm run eb -- rule test --file <rule.json\|script.mjs> --company <id> [--mode fast\|full] --json` |
| Get a stored rule | `get_rule` | `npm run eb -- rule show <ruleId> --json` |
| Recent jobs for a rule | `get_recent_jobs` | `npm run eb -- jobs --rule <ruleId> --window 1h --json` |
| Verification pre-checks | (embedded in prompt) | `npm run eb -- verify precheck <ruleId> --window 1h --json` |
| Save the result | (task result) | `npm run eb -- rule import …` / `npm run eb -- verify save …` |

### Agent CLI (`npm run eb -- <command>`)

One cross-platform CLI (`src/cli/eb.js`) is the only way external agents touch Earlybird. It never bypasses validation.

- `schema rule|job|discovery|verify`: print the JSON Schema (generated from zod) for drafting.
- `company list|show <id>` / `company add --name --url [--roles "AI Engineer,Infrastructure Engineer"]`.
- `rule test --file <path> --company <id>`: dry run, no DB writes. Prints jobs, `meta`, per-term counts, validation errors and the score.
- `rule import --file <path> --company <id> [--activate] [--as fallback]`: runs the **full discovery validation + scoring pipeline**. It only saves if it passes, always as a **new rule version**, and never replaces the active rule unless `--activate` is given *and* the new rule scores at least as well (or `--force` with a reason, which is logged). On activation, current jobs are inserted as a baseline (no Discord spam).
- `rule show|list|diff <idA> <idB>|rollback <companyId>`: rollback re-activates the previous version.
- `jobs --rule <id> --window 10m|1h|24h`.
- `verify precheck <ruleId> --window …` / `verify save <ruleId> --file report.json`: stores an externally produced verification report (zod-validated) exactly like an in-app one.
- `task list|show|stop|kill|retry <taskId>`: same controls as the dashboard.
- Every command supports `--json` (machine-readable output for agents), uses exit code 0/1/2 (ok / validation failed / error), and logs to the same logs with `scope = cli` and `actor = cli`.
- Works while `npm run dev` is running: SQLite in WAL mode with `busy_timeout`. The scheduler reads the active rule from the DB on each run, so an imported rule is picked up without a restart.
- Drafts live wherever the agent likes; `data/drafts/` (gitignored) is the suggested place.

### IDE integration files

- `.github/copilot-instructions.md`: short repo guide for Copilot. It points to `CLAUDE.md` and `prompts/README.md`, and says "never edit the DB or rule files directly; always use `npm run eb`".
- `.github/prompts/discover-rule.prompt.md`, `verify-rule.prompt.md`, `repair-rule.prompt.md`: thin Copilot prompt files that reference the matching `prompts/*.md` playbook, so they show up as `/discover-rule` etc. in Copilot Chat. The playbooks in `prompts/` stay the single source of truth.
- `.vscode/mcp.json`: registers the Playwright MCP server so Copilot agent mode can browse portals (cross-platform `npx` command).

### Status

The playbooks, `.github/` files and `.vscode/mcp.json` are written **last** (see Build phases), after the app and the Agent CLI exist, so they can be tested end to end. Until then, don't create `prompts/`; build the prompt loader, the agents and the CLI against the file names, placeholders and JSON shapes described here.

## Discord

- Jobs: one embed per job (linked title, company, matched role(s), location, department, posted/first-seen time, rule id in the footer), up to 10 embeds per message, routed to the company's channel or the default one. Retry 429 with `retry_after`; log every send.
- Alerts: failing, blocked, fallback in use, discovery failed, verification verdict not healthy, recovered, scheduler stalled.

## Scraping etiquette

- Respect robots.txt (toggle on by default) and each site's terms.
- Minimum intervals are enforced (api/html 10 min, browser 15 min).
- Polite, identifiable user agent; exponential backoff on errors; never hammer on retry.

## Build phases

Each phase must work end-to-end (and `npm run dev` must boot) before the next.

1. **Foundation:** setup wrappers (`setup.sh`, `setup.ps1`, `setup.cmd`), `scripts/setup.mjs`, preflight, doctor, `.gitattributes`, package.json scripts, Fastify + Vite middleware skeleton, pino logging (all sinks), zod schemas, Drizzle schema + auto-migrations, settings module, `/api/health`, **Playwright e2e harness** (config, isolated app-per-worker fixture, test mode + `/api/test/*`, mock portal, mock Discord, mock LLM, CI workflow) with `setup.spec.js` passing. Verified on Windows and macOS.
2. **Runner:** `api` + `html` rules, pagination, fast/full modes, role search (`{{query}}`, per_term/combined/none), abort, typed errors with full `detail`. Fixture tests (Greenhouse, Lever, Ashby, sample HTML). `npm run rule` CLI.
3. **Roles + Worker + Discord:** roles module (effective roles, title matching), croner jobs, pools, seen-jobs dedupe (job keys, canonical URL, fingerprint, re-keying), baseline, notification outbox, stale-job handling, Discord routing. Seed companies with hand-written Greenhouse/Lever rules.
4. **Tasks:** queue, registry, task_events + SSE, stop/kill/retry, startup recovery.
5. **Browser + script rules:** Playwright action interpreter, artifacts on failure; script sandbox (child process + permission model, timeout, memory limit) tested on Windows and macOS.
6. **Discovery:** AI SDK agent loop with guards, Playwright MCP + `run_rule`, two-candidate scoring, baseline.
7. **Verification:** pre-checks, verify agent, reports, CLI.
8. **Dashboard:** all pages above.
9. **Health + alerts + fallback:** thresholds, fallback execution, alert dedupe.
10. **Agent CLI + playbooks:** `npm run eb` (all commands, `--json`, exit codes), then write `prompts/*.md`, `.github/copilot-instructions.md`, `.github/prompts/*.prompt.md`, `.vscode/mcp.json`. Test end to end: from Copilot agent mode, discover a rule for a real company, `rule test`, `rule import --activate`, then `verify` it, while `npm run dev` keeps running.

## Conventions

- Rule/agent-output/settings shapes come only from `src/schema/`.
- AI-generated code only ever exists as a **script rule** and only ever runs inside the script sandbox; it's never imported into the server process.
- `src/runner/` is pure: no DB, no Discord, no LLM. Discovery, verification, the worker and the CLI all call the same `runRule`.
- LLM calls only in `src/agents/`, only through the Vercel AI SDK, with the model from Settings (never hardcoded). Pass Claude-specific options (thinking/effort) via the AI SDK Anthropic `providerOptions`, checking the names against the installed `@ai-sdk/anthropic` version. Don't send `temperature`/`top_p` (current Claude models reject them), and don't force `tool_choice` to a specific tool (rejected on some models); steer from the prompt instead.
- Every long-running function accepts an `AbortSignal` and a child `logger`.
- Schedules only through `croner` in `src/worker/scheduler.js`; no stray `setInterval`.
- Never swallow errors: log with context, then rethrow or record them on the run/task.
- Secrets are never logged or sent to the browser in full (mask all but the last 4 chars).
- Tests use recorded fixtures or the local mock portal, never live sites (except `@live` e2e tests).
- Every feature ships with vitest tests for its logic and a Playwright e2e spec for its user-facing flow; `npm run test:all` must pass before a phase is done.
- Everything must work on Windows, macOS and Linux (see the cross-platform rules under "Setup").
