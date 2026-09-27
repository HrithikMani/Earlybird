# Earlybird: instructions for GitHub Copilot

Earlybird watches company careers portals and posts new jobs to Discord. Read `CLAUDE.md` for the architecture and `prompts/README.md` for the rule playbooks.

When asked to create, test, verify or fix a **rule**:
- Follow the matching playbook in `prompts/` (`discover-rule.md`, `verify-rule.md`, `repair-rule.md`).
- Browse portals with the Playwright MCP server from `.vscode/mcp.json`. If the `browser_*` tools aren't available to you, stop and ask the user to run `npm run eb -- mcp check`, start the `playwright` server in `.vscode/mcp.json`, and enable its tools in Agent mode. Don't guess rules without a browser.
- Use the Agent CLI for everything else: `npm run eb -- <command> --json` (see `npm run eb -- --help`).
- **Never edit the SQLite DB, `data/rules/` or settings by hand.** `npm run eb -- rule import` validates and scores every rule and never replaces a better active rule, so the running app can't break.
- Put drafts in `data/drafts/`.

When changing **code**: follow the conventions in `CLAUDE.md` (JavaScript ES modules, zod schemas in `src/schema/`, runner stays pure, LLM calls only in `src/agents/`). Add or update Playwright e2e specs in `e2e/specs/` and run `npm run test:all`.
