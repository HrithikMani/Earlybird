import fs from 'node:fs';
import path from 'node:path';
import { getBrowser } from './browser-pool.js';
import { extractHtml, looksLikeCaptcha } from './extract.js';
import { applyTemplate } from './normalize.js';
import { applyPagination, maxPagesFor, pageValue } from './paginate.js';
import { Blocked, Cancelled, HttpError, InvalidRule, RunnerError, SelectorNotFound, Timeout } from './errors.js';
import { BROWSER_ACTIONS } from '../schema/rule.js';

const isTimeout = (e) => e?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(e?.message || '');

async function saveArtifacts(page, context, ctx, label) {
  if (!ctx.artifactsDir) return;
  const dir = ctx.artifactsDir;
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  try {
    const file = path.join(dir, `${label}.png`);
    await page.screenshot({ path: file, fullPage: true, timeout: 10000 });
    out.screenshot = file;
  } catch {
    // page may be gone
  }
  try {
    const file = path.join(dir, `${label}.html`);
    fs.writeFileSync(file, await page.content());
    out.html = file;
  } catch {
    // ignore
  }
  if (ctx.saveTraces) {
    try {
      const file = path.join(dir, `${label}-trace.zip`);
      await context.tracing.stop({ path: file });
      out.trace = file;
    } catch {
      // ignore
    }
  }
  ctx.meta.artifacts = { ...(ctx.meta.artifacts || {}), ...out };
}

/**
 * Runs a `browser` rule for one query. With `pagination` (page/offset param on the first `goto` URL), the actions are
 * repeated per page until the job cap, `max_pages` (or `fast_max_pages`), an empty page or a repeated page.
 */
export async function runBrowser(rule, ctx, query) {
  if (!rule.pagination || rule.pagination.kind === 'cursor') return runBrowserOnce(rule, ctx, query);
  const p = rule.pagination;
  const gotoIndex = rule.actions.findIndex((a) => a.do === 'goto');
  const maxPages = maxPagesFor(rule, ctx.mode);
  const raw = [];
  let baseUrl;
  let prevFirst;
  for (let i = 0; i < maxPages; i++) {
    if (ctx.maxJobs && raw.length >= ctx.maxJobs) {
      ctx.meta.hit_cap = true;
      break;
    }
    const goto = rule.actions[gotoIndex];
    const url = applyPagination({ url: applyTemplate(goto.url, { query }, { urlEncode: true }) }, p, pageValue(p, i)).url;
    // After page 1, an empty page is the normal way to end: don't wait the full timeout for cards that never come.
    const actions = rule.actions.map((a, j) => (j === gotoIndex ? { ...a, url } : i > 0 && a.do === 'wait' && a.selector ? { ...a, optional: true, timeout_ms: 5000 } : a));
    let page;
    try {
      page = await runBrowserOnce({ ...rule, actions, pagination: undefined }, ctx, query);
    } catch (err) {
      if (i > 0 && err.type === 'SelectorNotFound') break; // past the last page
      throw err;
    }
    baseUrl ??= page.baseUrl;
    if (!page.raw.length) break;
    const first = JSON.stringify(page.raw[0]);
    if (first === prevFirst) break; // the site ignored the page param
    prevFirst = first;
    raw.push(...page.raw);
  }
  return { raw, baseUrl };
}

async function runBrowserOnce(rule, ctx, query) {
  for (const a of rule.actions) if (!BROWSER_ACTIONS.includes(a.do)) throw new InvalidRule(`unknown browser action "${a.do}"`);
  const fast = ctx.mode === 'fast' && rule.sorted_newest_first;
  const vars = { query };
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: ctx.userAgent, locale: 'en-US', viewport: { width: 1366, height: 900 } });
  if (ctx.saveTraces) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(ctx.actionTimeoutMs);
  page.setDefaultNavigationTimeout(ctx.actionTimeoutMs);
  let closed = false;
  const onAbort = () => {
    closed = true;
    context.close().catch(() => {});
  };
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  ctx.meta.actions ??= [];
  let baseUrl = rule.url_prefix;
  let extracted;
  let current;
  try {
    for (let i = 0; i < rule.actions.length; i++) {
      if (ctx.signal?.aborted) throw new Cancelled();
      const a = rule.actions[i];
      current = { i, ...a };
      const t0 = Date.now();
      const rec = { i, do: a.do, selector: a.selector, ms: 0, ok: true };
      ctx.meta.actions.push(rec);
      switch (a.do) {
        case 'goto': {
          const url = applyTemplate(a.url, vars, { urlEncode: true });
          const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
          baseUrl = page.url();
          const status = res?.status();
          rec.status = status;
          ctx.meta.requests.push({ method: 'GET', url, status, ms: Date.now() - t0, browser: true });
          ctx.meta.last_status = status;
          if (status === 403 || status === 429) throw new Blocked(`${status} loading ${url}`, { status, detail: { url, status } });
          if (status >= 400) throw new HttpError(status, `HTTP ${status} loading ${url}`, { detail: { url, status } });
          const html = await page.content();
          if (looksLikeCaptcha(html)) throw new Blocked(`captcha / bot challenge page at ${url}`, { detail: { url } });
          break;
        }
        case 'wait': {
          if (a.selector) {
            try {
              await page.locator(a.selector).first().waitFor({ state: a.state, timeout: a.timeout_ms });
            } catch (e) {
              if (!a.optional) throw e;
              rec.skipped = true;
            }
          } else if (a.ms) await page.waitForTimeout(a.ms);
          break;
        }
        case 'click': {
          const limit = a.repeat_until_gone ? (fast ? Math.max(0, (rule.fast_max_pages ?? 1) - 1) : a.max_repeats) : 1;
          let clicks = 0;
          for (; clicks < limit; clicks++) {
            const loc = page.locator(a.selector).first();
            const visible = await loc.isVisible().catch(() => false);
            if (!visible) {
              if (clicks === 0 && !a.repeat_until_gone && !a.optional) await loc.waitFor({ state: 'visible' });
              else break;
            }
            await loc.click();
            if (a.wait_after_ms) await page.waitForTimeout(a.wait_after_ms);
          }
          rec.repeats = clicks;
          break;
        }
        case 'fill': {
          const loc = page.locator(a.selector).first();
          await loc.fill(applyTemplate(a.value, vars));
          if (a.press_enter) await loc.press('Enter');
          if (a.wait_after_ms) await page.waitForTimeout(a.wait_after_ms);
          break;
        }
        case 'select': {
          const loc = page.locator(a.selector).first();
          const value = applyTemplate(a.value, vars);
          try {
            await loc.selectOption(value, { timeout: 5000 });
          } catch {
            await loc.selectOption({ label: value });
          }
          if (a.wait_after_ms) await page.waitForTimeout(a.wait_after_ms);
          break;
        }
        case 'scroll': {
          const limit = fast ? Math.max(0, (rule.fast_max_pages ?? 1) - 1) : a.max_scrolls;
          let lastHeight = -1;
          let n = 0;
          for (; n < limit; n++) {
            const h = await page.evaluate(() => {
              window.scrollTo(0, document.body.scrollHeight);
              return document.body.scrollHeight;
            });
            await page.waitForTimeout(a.wait_after_ms);
            if (a.until_no_change && h === lastHeight) break;
            lastHeight = h;
          }
          rec.repeats = n;
          break;
        }
        case 'extract': {
          const html = await page.content();
          baseUrl = page.url();
          extracted = extractHtml(html, rule.item_selector, rule.fields);
          break;
        }
        default:
          throw new InvalidRule(`unknown browser action "${a.do}"`);
      }
      rec.ms = Date.now() - t0;
      if (extracted) break;
    }
    if (!extracted) extracted = extractHtml(await page.content(), rule.item_selector, rule.fields);
    ctx.meta.pages++;
    if (extracted.selectorError) throw new SelectorNotFound(`invalid selector: ${extracted.selectorError.message}`, { detail: { item_selector: rule.item_selector } });
    if (extracted.count === 0 && !query) {
      throw new SelectorNotFound(`item_selector "${rule.item_selector}" matched nothing after actions`, { detail: { item_selector: rule.item_selector, page_url: page.url(), page_title: extracted.title } });
    }
    return { raw: extracted.items, baseUrl };
  } catch (err) {
    if (closed || ctx.signal?.aborted) throw new Cancelled('cancelled during browser run');
    const last = ctx.meta.actions[ctx.meta.actions.length - 1];
    if (last) last.ok = false;
    const where = { action_index: current?.i, action: current, page_url: page.url() };
    await saveArtifacts(page, context, ctx, `failure-${(query || 'all').replace(/[^\w-]+/g, '_').slice(0, 40)}`);
    if (err instanceof RunnerError) {
      err.detail = { ...where, ...(err.detail || {}), artifacts: ctx.meta.artifacts };
      throw err;
    }
    if (isTimeout(err)) {
      const Cls = current?.selector ? SelectorNotFound : Timeout;
      throw new Cls(`action #${current?.i} ${current?.do}${current?.selector ? ` "${current.selector}"` : ''} timed out`, { cause: err, detail: { ...where, playwright: err.message.split('\n')[0], artifacts: ctx.meta.artifacts } });
    }
    throw new RunnerError('BrowserError', `action #${current?.i} ${current?.do} failed: ${err.message.split('\n')[0]}`, { cause: err, detail: { ...where, artifacts: ctx.meta.artifacts } });
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort);
    if (!closed) await context.close().catch(() => {});
  }
}
