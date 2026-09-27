---
mode: agent
description: Check whether an Earlybird rule is catching the newest jobs
---
Follow [the verify-rule playbook](../../prompts/verify-rule.md) for rule `${input:rule:rule id, e.g. rul_abc123}` with window `${input:window:10m, 1h or 24h}`.

Get the pre-checks with `npm run eb -- verify precheck <rule> --window <window> --json`, browse the portal with the Playwright MCP browser, test with `npm run eb -- rule run <rule> --json`, then save your JSON report to `data/drafts/verify-<rule>.json` and store it with `npm run eb -- verify save <rule> --file data/drafts/verify-<rule>.json --window <window> --json`.
