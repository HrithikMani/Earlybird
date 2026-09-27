# Discover rules for {{company_name}}

Earlybird watches **{{company_name}}**'s careers portal and posts **new job openings to Discord within minutes**. A cron job runs your rule **every 5 minutes**, and each run only needs the **~10 newest jobs** for our roles: whatever is new since the last run is always at the top when the list is sorted newest first.

Your job is small and specific: **find the best way to get those ~10 newest matching jobs, a URL rule or a Playwright rule, and prove it works.** That means one request or one page, sorted newest first, **with no pagination**. You're not collecting every job, documenting the site, or reverse-engineering its internals.

- Careers page: {{careers_url}}
- Roles:
{{roles}}
- Search terms Earlybird sends to the portal: {{search_terms}}
- Portal filters to apply if the portal supports them: {{source_filters}}
- Script rules allowed: {{scripts_allowed}}
{{operator_note}}

## What the user wants

{{interests}}

Earlybird ignores jobs posted more than {{max_age_days}} day(s) ago, and it filters titles and locations itself too. So a rule that can't filter by location at the portal is still fine; the essential parts are **search by role + sort newest first + the first page**.

## The procedure (follow it in order, and keep to the step budgets)

You have **{{max_steps}} tool steps** and **${{max_cost}}** in total, but a good run needs **15–25 steps**. Call `report_phase` at the start of each phase with one line on what you found.

### 1. explore (≤ 4 steps)
Open the careers page, ideally already searched for the first role and sorted newest first if the URL makes that obvious (e.g. `?q=Software+Engineer&sort=newest`). Then **one** `browser_snapshot` and **one** `browser_network_requests`.

### 2. analyze: decide (≤ 4 steps)
Answer these, then pick the strategy:
- **Known ATS?** (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Oracle Recruiting Cloud, iCIMS, …) → use its public JSON API as a **URL rule**. The endpoints are below.
- **A plain JSON request in the network list** that returns the jobs and works **without cookies, tokens or special headers** (you can call it again with `browser_evaluate(fetch(url))` or `run_rule`)? → **URL rule** on that endpoint.
- **Otherwise** (the data comes from a private or authenticated API such as GraphQL with `doc_id`, CSRF/`lsd` tokens or session cookies, or it's rendered by JavaScript) → **Playwright rule**. Use the page's own URL parameters for search, sort and page when it has them (they're visible in the address bar after you search or sort), else UI actions. **Don't** try to reproduce private APIs, token handshakes or cookies, and don't read request bodies of private APIs.
- **Script rules** are a last resort: only when a URL rule is impossible *and* a Playwright rule can't reach the jobs.

**How to find search/sort (learned from real runs):**
- **Try the URL first.** Most sites keep search and sort in the address bar. After typing a search or choosing "Newest", read `location.href` with one `browser_evaluate`. If the sort isn't in the URL yet, try the common params directly with `browser_navigate`: `sort=newest`, `sort=recent`, `sort=date`, `sort_by=date`, `sort_by_new=true`, `sortBy=POSTING_DATES_DESC`, `orderby=date`. A URL param makes the rule simpler and more reliable than clicking.
- **Clicking:** pass the element's **snapshot ref** (e.g. `e586` from the latest snapshot) or a Playwright selector such as `text=Newest` or `role=radio[name="Newest"]` as `target`, never a description like "Newest sort button". Refs change when the page re-renders: take a fresh snapshot if one fails. **If a click fails twice, stop clicking** and look for the URL param instead.
- **Don't set up location, team or other filters in the UI.** Earlybird filters locations and titles itself. Only search (role) and sort (newest) matter.

### 3. newest jobs = your reference (≤ 3 steps)
On the site, sorted newest first and searched for our roles, note the **5–10 newest matching job titles** (and their posted dates if shown). These go in `evidence.newest_titles`, and your rule must return them. One `browser_find` or a small `browser_evaluate` that returns titles is enough.

### 4. build + test one rule (≤ 10 steps)
Write the rule for the chosen strategy so that **one request or page returns the newest ~10–25 matching jobs**. Don't add `pagination`:
- **URL rule:** the endpoint with search (`{{query}}`) + sort-newest params and a small page size (10–25).
- **Playwright rule:** `goto` a URL with the search + sort params (with `{{query}}` in it), `wait` for the job cards, `extract`. If the site has no sort/search URL params, use `fill`/`select`/`click` for search and "newest" instead. No "load more" clicks and no pagination.

To learn the markup, read the `outerHTML` of **one** job card in **one** `browser_evaluate` call, then write the selectors. Run the rule with `run_rule`, check your reference titles are in the result and that ids, URLs and dates look right, and fix it at most 2–3 times.

### 5. second strategy (optional, ≤ 5 steps)
Only if it's cheap, e.g. a Playwright twin of a working URL rule using the same search/sort URL. If it doesn't work within the budget, skip it and say why in `evidence.skipped`.

### 6. commit
Answer with the JSON below. Earlybird re-validates in code (two full runs and one fast run), scores the candidates, makes the best one active and keeps the other as a fallback.

**Stop signals:** if you notice you're re-reading the same thing, inspecting internals you won't use, building pagination, or you're past 25 steps, commit what you've tested. One tested rule is far more useful than none.

## Known ATS endpoints

- Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs` (array at `jobs`; `id`, `title`, `absolute_url`, `location.name`, `updated_at`)
- Lever: `GET https://api.lever.co/v0/postings/{company}?mode=json` (root array; `id`, `text`, `hostedUrl`, `categories.location`, `createdAt`)
- Ashby: `GET https://api.ashbyhq.com/posting-api/job-board/{name}` (array at `jobs`)
- SmartRecruiters: `GET https://api.smartrecruiters.com/v1/companies/{id}/postings` (array at `content`, `offset`/`limit` pagination)
- Workday: `POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with body `{"limit":20,"offset":0,"searchText":"{{query}}","appliedFacets":{}}` (array at `jobPostings`; `postedOn` is relative like "Posted 2 Days Ago")
- Oracle Recruiting Cloud: `GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber={site},keyword="{{query}}",sortBy=POSTING_DATES_DESC,limit=25,offset=0` (array at `items.0.requisitionList`)

## Rule details

- **Newest first:** set `"sorted_newest_first": true` only if you confirmed the order. If the site can't sort by date at all, say so in `evidence.notes`: then the rule returns the first page as the site orders it.
- **`{{query}}`:** put it where the search term goes (URL, body value, or `fill` value) and set `search.mode`:
  - `per_term`: one request per term
  - `combined`: terms joined with `combine_with`
  - `none`: the portal can't search; Earlybird matches titles itself
- **Stable ids:** `fields.id`, or `id_from_url` (a regex with one capture group, e.g. `"/jobs/(\\d+)"`).
- **Posted date:** map `fields.posted_at` when the portal shows it, and set `posted_at_format` (`iso`, `relative`, `auto`). If the site shows no dates, say so. Newest-first order is then what matters.
- **Selectors:** CSS. `"a.title"` reads text, `"a.title@href"` reads an attribute, `"@data-id"` reads an attribute of the item itself. Prefer data attributes, ARIA roles and stable class names over generated ones.
- **Browser actions:** only `goto`, `wait`, `click`, `fill`, `select`, `scroll` and `extract`, ending with `extract`.
- **Script rules** export `default async function fetchJobs({ terms, mode, signal, fetch, cheerio, page, log })` and return `[{ external_id, title, url, location, department, posted_at, search_term }]`. `log` is an object: use `log.info(msg, data)`. They run in a sandbox with network access but no file system.
- **Don't** log in, submit applications, or bypass captchas.

## Final answer

Reply with **only** this JSON object:

```json
{
  "candidates": [
    { "strategy": "url | playwright | script", "rule": { }, "notes": "why this works" }
  ],
  "evidence": {
    "ats_detected": "greenhouse | lever | ashby | smartrecruiters | workday | oracle | other | none",
    "source_request": "endpoint you used, if any",
    "site_supports_sort_newest": true,
    "how_to_get_newest": "one sentence: how new postings are reached (sort param, first page, …)",
    "recommended_strategy": "url | playwright | script: and why in one sentence",
    "visible_job_count": 42,
    "visible_role_job_count": 7,
    "newest_titles": ["the 5-10 newest matching titles you saw on the site"],
    "example_titles": ["a few other titles"],
    "skipped": { "url": "reason, only if a strategy was left out" },
    "notes": "anything the operator should know"
  }
}
```

For a script candidate add `"code": "<the module source>"` next to the rule.

## Rule schema

```json
{{rule_schema_json}}
```
