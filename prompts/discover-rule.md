# Discover rules for {{company_name}}

You're setting up Earlybird to watch **{{company_name}}**'s careers portal and post **new job openings to Discord within minutes of them going live**. Your job is to work out how this portal can be read cheaply and reliably, especially **how to get its newest jobs**, and turn that into tested rules.

- Careers page: {{careers_url}}
- Roles we care about:
{{roles}}
- Search terms Earlybird will send to the portal: {{search_terms}}
- Filters to apply at the portal if it supports them (otherwise ignore): {{source_filters}}
- Script rules allowed: {{scripts_allowed}}
{{operator_note}}

## How you work

Go through these phases in order, and call `report_phase` each time you start one with a one-line note on what you found. The operator watches these notes live.

1. **explore**: open the careers page with the browser tools (`browser_navigate`, then `browser_snapshot`) and look at it the way a job seeker would.
2. **analyze**: work out:
   - **The URL.** Path and query params, and whether it's an ATS domain (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, iCIMS, Workable, …).
   - **The network requests** (`browser_network_requests`). Is there an ATS API or a hidden JSON endpoint behind the listings? JSON endpoints are the most reliable source.
   - **The page.** How listings are rendered, the markup of one job card, and whether pagination, "load more" or infinite scroll is used.
   - **Search and filters.** How to search for a role (query param, request body field, or search box), and how to filter by location.
   - **Newest jobs.** Whether you can sort by date (param or control), where new postings appear, and how the posted date is shown ("2 days ago", an ISO date, …).
3. **build**: form rules from what you learned:
   - a **URL rule** (`api` or `html`) that fetches with plain HTTP, using search/sort query params where the portal supports them
   - a **Playwright rule** (`browser`) that searches and sorts through the UI
   - a **script rule** only if neither JSON form can work (for example a token handshake), and only if scripts are allowed
4. **test**: run every rule with `run_rule`, which uses the real role search terms. Check that:
   - it returns the jobs you saw on the page, with correct titles and absolute URLs
   - **the newest jobs you saw on the site are in the results**
   - `posted_at` parses into real dates where the site shows them
   - every job has a stable id

   Fix and re-run until each rule is right. If a strategy can't work on this portal, drop it and say why.
5. **commit**: answer with the JSON below. Earlybird then re-validates your rules in code (two full runs and one fast run each), scores them, makes the best one active and keeps the other as a fallback.

Known ATS endpoints (prefer these when the portal uses them):
- Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs` (array at `jobs`; `id`, `title`, `absolute_url`, `location.name`, `updated_at`)
- Lever: `GET https://api.lever.co/v0/postings/{company}?mode=json` (root array; `id`, `text`, `hostedUrl`, `categories.location`, `createdAt`)
- Ashby: `GET https://api.ashbyhq.com/posting-api/job-board/{name}` (array at `jobs`)
- SmartRecruiters: `GET https://api.smartrecruiters.com/v1/companies/{id}/postings` (array at `content`, `offset`/`limit` pagination)
- Workday: `POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with body `{"limit":20,"offset":0,"searchText":"{{query}}","appliedFacets":{}}` (array at `jobPostings`; `postedOn` is relative like "Posted 2 Days Ago")

## What makes a good rule

- **Newest first.** If the source can sort by date, use that and set `"sorted_newest_first": true`. Set `fast_max_pages` to the number of pages that reliably hold the last hour or so of new postings (usually 1). Only claim `sorted_newest_first` if you confirmed the order.
- **All jobs reachable.** Full sweeps must be able to read every page (`pagination`, or "load more" clicks with `repeat_until_gone`) so Earlybird can tell when jobs are taken down.
- **Role search at the source** when the portal supports it. Put `{{query}}` where the search term goes (URL, body value, or a `fill` action value) and set `search.mode`:
  - `per_term`: one request per role term
  - `combined`: one request with the terms joined by `combine_with`
  - `none`: the portal can't search. Fetch everything and Earlybird matches titles itself.
- **Stable ids.** Map the portal's own job/requisition id (`fields.id`), or give `id_from_url` a regex with one capture group that pulls the id out of the job URL.
- **Posted date.** Map `fields.posted_at` whenever the portal shows one, and set `posted_at_format` (`iso`, `relative` or `auto`).
- **Stable selectors.** Prefer data attributes, semantic tags and ARIA roles over generated class names. Field selectors are CSS: `"a.title"` reads text, `"a.title@href"` reads an attribute, and `"@data-id"` reads an attribute of the item itself.
- **Browser actions.** Use only `goto`, `wait`, `click`, `fill`, `select`, `scroll` and `extract`, and end with `extract`.
- **Script rules** export `default async function fetchJobs({ terms, mode, signal, fetch, cheerio, page, log })` and return `[{ external_id, title, url, location, department, posted_at, search_term }]`. They run in a sandbox with network access but no file system, and `page` is only there when `uses_browser` is true.
- **Don't** log in, submit applications, or bypass captchas. If the portal blocks automated access, say so in `evidence.notes`.
- **Don't** repeat the same tool call with identical arguments. If you're stuck, commit what works and explain the rest in `evidence.notes`.

## Final answer

Reply with **only** this JSON object (no prose around it):

```json
{
  "candidates": [
    { "strategy": "url", "rule": { }, "notes": "why this works" },
    { "strategy": "playwright", "rule": { }, "notes": "why this works" }
  ],
  "evidence": {
    "ats_detected": "greenhouse | lever | ashby | smartrecruiters | workday | other | none",
    "source_request": "endpoint you found, if any",
    "site_supports_sort_newest": true,
    "how_to_get_newest": "one sentence: how new postings are reached (sort param, first page, …)",
    "visible_job_count": 42,
    "visible_role_job_count": 7,
    "newest_titles": ["the 3-5 newest job titles you saw on the site that match our roles (or overall if no roles)"],
    "example_titles": ["a few other titles"],
    "skipped": { "playwright": "reason, only if a strategy was left out" },
    "notes": "anything the operator should know"
  }
}
```

For a script candidate, add `"code": "<the module source>"` next to `"rule": { "type": "script", "uses_browser": false, "search": { "mode": "per_term" } }`.

## Rule schema

```json
{{rule_schema_json}}
```
