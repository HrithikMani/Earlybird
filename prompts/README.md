# Earlybird playbooks

These prompts are used in two ways:

1. **By Earlybird's own agent.** Discovery, verification and synonym tasks load them fresh on every run. The `{{placeholders}}` are filled in by the app, and the agent gets browser tools (Playwright MCP) plus `run_rule`, `get_recent_jobs` and `report_phase`.
2. **By your IDE agent** (GitHub Copilot agent mode, Claude Code, Cursor). The agent follows the same playbook, but uses the **Agent CLI** instead of the in-app tools. Every rule it imports goes through the same validation and scoring as the app, so it can't break the running app.

| Playbook | Use it to |
|---|---|
| [discover-rule.md](discover-rule.md) | build URL / Playwright / script rules for a company |
| [verify-rule.md](verify-rule.md) | check a rule catches the newest jobs in a window (10m / 1h / 24h) |
| [repair-rule.md](repair-rule.md) | fix a failing rule, or one that misses jobs |
| [suggest-synonyms.md](suggest-synonyms.md) | suggest title synonyms and search terms for a role |

## Tool ↔ CLI mapping

| Capability | In-app agent tool | IDE agent (run in a terminal) |
|---|---|---|
| Browse the portal | Playwright MCP | Playwright MCP from `.vscode/mcp.json` |
| Rule JSON schema | embedded in the prompt | `npm run eb -- schema rule` |
| Company, roles, search terms | embedded in the prompt | `npm run eb -- company show <companyId> --json` |
| Test a draft rule | `run_rule` | `npm run eb -- rule test --file <rule.json\|script.mjs> --company <id> --json` |
| Test a stored rule | `run_rule` with `rule_id` | `npm run eb -- rule run <ruleId> --full --json` |
| Recent jobs | `get_recent_jobs` | `npm run eb -- jobs --company <id> --window 1h --json` |
| Verification pre-checks | embedded in the prompt | `npm run eb -- verify precheck <ruleId> --window 1h --json` |
| Save the result | returned to the app | `npm run eb -- rule import …` / `npm run eb -- verify save <ruleId> --file report.json` |

## Before using an IDE agent: connect the Playwright MCP browser

The playbooks need a browser. The repo ships `.vscode/mcp.json` with the Playwright MCP server.

1. `npm run setup` (installs Chromium), then `npm run eb -- mcp check`. It should print `OK: Playwright MCP`.
2. In VS Code, open `.vscode/mcp.json` and click **Start** above the `playwright` server.
3. In Copilot Chat, switch to **Agent** mode, open **Tools**, and enable the `playwright` tools.

The `/discover-rule` prompt checks this first, and asks you to connect the browser if the tools are missing.

**Limits.** The in-app agent is stopped by the per-task limits in Settings → AI (default **$1**, 40 steps, 10 min; each task shows its duration, steps and cost on the dashboard). An IDE agent runs on your Copilot/Claude Code plan and isn't limited by Earlybird, but its imports still go through the same validation.

## Example: discover a rule from Copilot Chat

```
/discover-rule company=cmp_abc123
```

or, in words: *"Follow prompts/discover-rule.md for company cmp_abc123. Use the Playwright MCP browser, test with `npm run eb -- rule test`, then import the best rule with `npm run eb -- rule import --activate`."*

What the agent does:
1. `npm run eb -- company show cmp_abc123 --json` to get the careers URL, roles and search terms.
2. Explores the portal with Playwright MCP (explore, analyze).
3. Writes `data/drafts/cmp_abc123.json` and runs `npm run eb -- rule test --file data/drafts/cmp_abc123.json --company cmp_abc123 --json` until the newest jobs show up (build, test).
4. Runs `npm run eb -- rule import --file data/drafts/cmp_abc123.json --company cmp_abc123 --activate --json` (commit). The running app picks the rule up on its next run, with a silent baseline first.

Rules of the road: never edit the DB or `data/rules/` by hand, keep drafts in `data/drafts/`, and use `--force --reason` only when replacing a broken rule.
