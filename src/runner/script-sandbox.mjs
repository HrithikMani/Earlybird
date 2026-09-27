// Runs one script rule inside a permission-restricted child process. Talks to the parent over IPC.
// The script gets: { terms, mode, signal, fetch, cheerio, page, log } and must return an array of jobs.
import { pathToFileURL } from 'node:url';

const send = (msg) => new Promise((resolve) => process.send(msg, undefined, {}, () => resolve()));
const MAX_LOGS = 200;
let logCount = 0;

function makeLog() {
  const emit = (level) => (msg, data) => {
    if (logCount++ >= MAX_LOGS) return;
    let safe;
    try {
      safe = data === undefined ? undefined : JSON.parse(JSON.stringify(data));
    } catch {
      safe = String(data);
    }
    process.send({ type: 'log', level, msg: String(msg).slice(0, 2000), data: safe });
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

process.once('message', async (msg) => {
  const { scriptPath, terms, mode, usesBrowser, userAgent, actionTimeoutMs } = msg;
  const controller = new AbortController();
  process.on('message', (m) => m?.type === 'abort' && controller.abort('cancelled'));
  let browser;
  try {
    const cheerio = await import('cheerio');
    const mod = await import(pathToFileURL(scriptPath).href);
    const fn = mod.default ?? mod.fetchJobs;
    if (typeof fn !== 'function') throw new Error('script must `export default async function fetchJobs(ctx)`');
    let page;
    if (usesBrowser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ userAgent, locale: 'en-US' });
      page = await context.newPage();
      page.setDefaultTimeout(actionTimeoutMs || 30000);
    }
    const wrappedFetch = (input, init = {}) =>
      fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal, headers: { 'user-agent': userAgent, ...(init.headers || {}) } });
    const jobs = await fn({ terms, mode, signal: controller.signal, fetch: wrappedFetch, cheerio, page, log: makeLog() });
    await send({ type: 'result', jobs: Array.isArray(jobs) ? jobs : { notArray: typeof jobs } });
  } catch (e) {
    await send({ type: 'error', name: e?.name, message: String(e?.message ?? e), stack: String(e?.stack ?? '') });
  } finally {
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  }
});
