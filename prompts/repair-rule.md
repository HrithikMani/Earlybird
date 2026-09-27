# Repair the rule for {{company_name}}

Rule `{{rule_id}}` for **{{company_name}}** ({{careers_url}}) is failing, or its last verification found missing jobs. Find out what changed on the portal and produce a fixed rule. Earlier versions show what used to work, so change as little as needed.

## Inputs

- Current rule: `npm run eb -- rule show {{rule_id}} --json`
- Company, roles and search terms: `npm run eb -- company show {{company_id}} --json`
- What's going wrong:
  - Latest failed run: open it on the dashboard (Company → Runs), or look at its error type, message, response snippet, failing browser step and screenshot.
  - Latest verification: `npm run eb -- verify precheck {{rule_id}} --window 1h --json`

## Steps

1. **Reproduce.** `npm run eb -- rule run {{rule_id}} --full --json`. Note the exact error or the missing jobs.
2. **Explore.** Open the careers page with the Playwright MCP browser, and compare what you see with what the rule expects (URL, endpoint, JSON shape, selectors, pagination, sort).
3. **Fix.** Write the corrected rule to `data/drafts/{{company_id}}.json` (or `.mjs` for a script). Keep the same ids and posted-date mapping where possible, so Earlybird keeps recognising jobs it has already seen.
4. **Test.** `npm run eb -- rule test --file data/drafts/{{company_id}}.json --company {{company_id}} --json`. Check that the newest jobs on the site are in the results and that dates and ids are right. Repeat until they are.
5. **Import.** `npm run eb -- rule import --file data/drafts/{{company_id}}.json --company {{company_id}} --activate --json`. It only saves if validation passes, always as a new version, and the next run records a silent baseline. If it's refused because it scores lower than the current rule, explain why in `--reason` and use `--force` only if the current rule is broken.
6. Report what changed on the portal and what you changed in the rule.

Never edit the database or `data/rules/` directly. Everything goes through `npm run eb`.
