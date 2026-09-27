---
mode: agent
description: Discover and import Earlybird rules for a company (Playwright MCP + npm run eb)
---
Discover rules for Earlybird company `${input:company:company id, e.g. cmp_abc123}` by following [the discover-rule playbook](../../prompts/discover-rule.md). Use the CLI mapping in [prompts/README.md](../../prompts/README.md) instead of the in-app tools.

**Step 0: make sure you have a browser.** Before anything else, check that the Playwright MCP browser tools (`browser_navigate`, `browser_snapshot`, `browser_network_requests`) are available to you.
- If they are, run `npm run eb -- mcp check` once to confirm Chromium starts, then continue.
- If they are **not** available, **stop and ask the user** to connect them. Don't try to discover rules without a browser. Tell them to:
  1. run `npm run setup` (installs Chromium) and `npm run eb -- mcp check`
  2. open `.vscode/mcp.json` in VS Code and click **Start** above the `playwright` server
  3. in Copilot Chat, switch to **Agent** mode, open **Tools**, and enable the `playwright` tools
  4. run `/discover-rule` again

Then:
1. `npm run eb -- company show <company> --json` for the careers URL, roles and search terms.
2. Go through the phases **explore → analyze → build → test → commit**, and say in chat which phase you're in and what you found.
3. Write drafts to `data/drafts/<company>.json` and test them with `npm run eb -- rule test --file … --company <company> --json` until the newest jobs on the site show up.
4. Import the best rule with `npm run eb -- rule import --file … --company <company> --activate --json`, and the runner-up with `--as fallback`.
5. Report the active rule id, its strategy, how many jobs it found, and how new jobs are reached.

Earlybird's per-task cost and step limits don't apply here (they only cover the in-app agent), so be efficient: prefer `browser_network_requests` and `browser_find` over repeated full snapshots.
