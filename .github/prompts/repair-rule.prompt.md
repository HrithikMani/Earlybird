---
mode: agent
description: Fix a failing Earlybird rule
---
Follow [the repair-rule playbook](../../prompts/repair-rule.md) for rule `${input:rule:rule id}` of company `${input:company:company id}`. Use the Playwright MCP browser and `npm run eb` only; never edit the database or `data/rules/` directly.
