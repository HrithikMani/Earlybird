import path from 'node:path';
import { createRequire } from 'node:module';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { chromium } from 'playwright';
import { getSettings } from '../settings/index.js';
import { ROOT } from '../config.js';

const require = createRequire(path.join(ROOT, 'package.json'));

// Tools the agents never get: arbitrary code execution and file access are too dangerous with untrusted web pages.
const BLOCKED_TOOLS = new Set(['browser_run_code_unsafe', 'browser_file_upload', 'browser_drop']);

// Page snapshots and network logs can be huge, and every agent step re-sends them. Keep each result bounded;
// the agent can drill in with browser_find / browser_network_request when it needs more.
const MAX_TOOL_TEXT = 12000;

function clipTool(def) {
  if (typeof def.execute !== 'function') return def;
  return {
    ...def,
    execute: async (...args) => {
      const res = await def.execute(...args);
      if (!res || !Array.isArray(res.content)) return res;
      let budget = MAX_TOOL_TEXT;
      const content = res.content.map((part) => {
        if (part.type !== 'text' || typeof part.text !== 'string') return part;
        if (part.text.length <= budget) {
          budget -= part.text.length;
          return part;
        }
        const text = `${part.text.slice(0, Math.max(0, budget))}\n… [truncated ${part.text.length - budget} chars: use browser_find, browser_network_request or a narrower query for details]`;
        budget = 0;
        return { ...part, text };
      });
      return { ...res, content };
    },
  };
}

/** Command to start the Playwright MCP server with our installed Chromium (no npx, works on Windows/macOS/Linux). */
export function playwrightMcpCommand({ outputDir } = {}) {
  const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
  const { headless } = getSettings('mcp').playwright;
  const args = [cli, '--isolated', '--browser', 'chromium', '--executable-path', chromium.executablePath(), '--image-responses', 'omit'];
  if (headless) args.push('--headless');
  if (outputDir) args.push('--output-dir', outputDir);
  return { command: process.execPath, args };
}

/** Resolves "npx"/"node" style commands for Windows. */
function resolveCommand(command) {
  if (process.platform === 'win32' && ['npx', 'npm'].includes(command)) return `${command}.cmd`;
  if (command === 'node') return process.execPath;
  return command;
}

/**
 * Connects the MCP servers an agent should use. Returns { tools, close(), servers[] }.
 * Playwright MCP is always included; extra servers come from Settings → MCP.
 */
export async function connectMcp({ agent, outputDir, log }) {
  const clients = [];
  const tools = {};
  const servers = [];
  const specs = [{ name: 'playwright', ...playwrightMcpCommand({ outputDir }), env: {} }];
  for (const s of getSettings('mcp').servers) {
    if (s.enabled && s.enabledFor.includes(agent)) specs.push({ name: s.name, command: resolveCommand(s.command), args: s.args, env: s.env });
  }
  try {
    for (const spec of specs) {
      const transport = new StdioMCPTransport({ command: spec.command, args: spec.args, env: { ...process.env, ...spec.env }, stderr: 'ignore' });
      const client = await createMCPClient({ transport, name: `earlybird-${agent}` });
      clients.push(client);
      const t = await client.tools();
      for (const [name, def] of Object.entries(t)) if (!BLOCKED_TOOLS.has(name)) tools[name] = clipTool(def);
      servers.push({ name: spec.name, tools: Object.keys(t).length });
    }
  } catch (err) {
    await Promise.allSettled(clients.map((c) => c.close()));
    throw Object.assign(new Error(`could not start MCP server: ${err.message}`), { type: 'McpError', cause: err });
  }
  log?.info({ servers }, 'MCP servers connected');
  return {
    tools,
    servers,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

/** Starts one MCP server just to list its tools ("Test connection" in Settings). */
export async function testMcpServer(spec) {
  const transport = new StdioMCPTransport({ command: resolveCommand(spec.command), args: spec.args || [], env: { ...process.env, ...(spec.env || {}) }, stderr: 'ignore' });
  const client = await createMCPClient({ transport, name: 'earlybird-test' });
  try {
    return Object.keys(await client.tools());
  } finally {
    await client.close();
  }
}
