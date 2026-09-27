# Verify rule {{rule_id}} for {{company_name}}

Earlybird uses rule `{{rule_id}}` (version {{rule_version}}, `{{rule_strategy}}/{{rule_type}}`) to catch **new jobs on {{company_name}}'s careers portal within minutes**. Check whether it's actually catching the newest jobs. **Don't change the rule**; a human decides what to do with your report.

- Careers page: {{careers_url}}
- Window: jobs posted in the last **{{window}}** (it is now {{now_iso}})
{{operator_note}}

The rule:

```json
{{rule_json}}
```

What Earlybird's code already measured (fast and full runs, jobs first seen in the window, detection lag, recent errors):

```json
{{precheck_json}}
```

## Steps

1. Open the careers page with the browser tools. Sort by newest and apply the same search/filters the rule uses, where the portal allows it. List the jobs the portal shows as posted within the window. If it shows no dates, take its **10 newest** jobs instead.
2. Call `run_rule` with `{ "rule_id": "{{rule_id}}", "mode": "fast" }` (and `"full"` if needed) to see what the rule returns right now.
3. Call `get_recent_jobs` with `{ "window": "{{window}}" }` to see what Earlybird already stored and sent to Discord.
4. Compare the lists: match by URL first, then by title + location.
5. Choose a verdict:
   - `healthy`: every recent job on the portal is returned by the rule.
   - `missing_recent`: some recent portal jobs aren't returned by the rule.
   - `stale`: the rule returns jobs, but the newest ones are old compared with the portal (wrong sort, cached endpoint, first page only…).
   - `broken`: the rule errors or returns nothing useful.
   - `inconclusive`: you couldn't determine the portal's recent jobs (blocked, no dates and no sort…).

Don't repeat the same tool call with identical arguments. Stop as soon as you have enough evidence.

## Report

Reply with **only** this JSON object:

```json
{
  "verdict": "healthy | missing_recent | stale | broken | inconclusive",
  "window": "{{window}}",
  "portal_recent_jobs": [{ "title": "", "url": "", "location": "", "posted_label": "" }],
  "rule_recent_jobs": [{ "title": "", "url": "", "posted_at": "" }],
  "missing": [{ "title": "", "url": "", "reason": "why the rule likely missed it" }],
  "suggested_action": "none | rerun_discovery | promote_fallback | edit_rule | check_manually",
  "suggested_rule_change": "plain-language description, only for edit_rule",
  "notes": "short explanation of how you reached the verdict"
}
```
