// Fills in missing posted dates from job detail pages. Many careers sites (Meta, Google, …) show no date in the
// list but embed schema.org JobPosting JSON-LD with `datePosted` on each job page (for Google Jobs).
// Only called for jobs Earlybird has not seen before (plus a small backfill), so it costs a few page loads per run.
import { getBrowser } from './browser-pool.js';
import { parsePostedAt } from './dates.js';

/** Extracts datePosted (epoch ms) from HTML with JSON-LD, or undefined. */
export function extractDatePosted(html) {
  if (!html) return undefined;
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const n of node) {
        const v = visit(n);
        if (v) return v;
      }
      return undefined;
    }
    if (node.datePosted) return node.datePosted;
    return visit(node['@graph']) || undefined;
  };
  for (const b of blocks) {
    try {
      const v = visit(JSON.parse(b.trim()));
      if (v) return parsePostedAt(v, 'iso');
    } catch {
      // malformed JSON-LD: try the regex below
    }
  }
  const m = html.match(/"datePosted"\s*:\s*"([^"]+)"/);
  return m ? parsePostedAt(m[1], 'iso') : undefined;
}

/**
 * Sets posted_at on jobs that lack it and for which `needs(job)` is true, by reading their detail pages.
 * Tries plain HTTP first; if the site blocks it (or the date is only in the rendered page), uses the shared browser.
 * Mutates the jobs; returns { tried, found, via }.
 */
export async function enrichPostedDates(jobs, { needs = () => true, limit = 15, signal, userAgent, timeoutMs = 20000, log, meta } = {}) {
  const targets = jobs.filter((j) => !j.posted_at && j.url && needs(j)).slice(0, limit);
  const stats = { tried: targets.length, found: 0, via: null };
  if (!targets.length) return stats;
  let useBrowser = false;
  let context;
  try {
    for (const job of targets) {
      if (signal?.aborted) break;
      let html;
      if (!useBrowser) {
        try {
          const res = await fetch(job.url, { headers: { 'user-agent': userAgent, 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
          html = res.ok ? await res.text() : null;
        } catch {
          html = null;
        }
        if (!extractDatePosted(html)) useBrowser = true; // blocked or rendered client-side: switch for the rest
      }
      if (useBrowser) {
        context ??= await (await getBrowser()).newContext({ userAgent, locale: 'en-US' });
        const page = await context.newPage();
        try {
          await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          html = await page.content();
          if (!extractDatePosted(html)) {
            await page.waitForTimeout(1500);
            html = await page.content();
          }
        } catch (err) {
          log?.debug({ url: job.url, err: err.message }, 'detail page failed');
        } finally {
          await page.close().catch(() => {});
        }
      }
      const posted = extractDatePosted(html);
      if (posted) {
        job.posted_at = posted;
        job.posted_at_raw = `datePosted ${new Date(posted).toISOString()} (detail page)`;
        stats.found++;
      }
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }
  stats.via = useBrowser ? 'browser' : 'http';
  if (meta) meta.enrich = stats;
  log?.info(stats, `posted dates from detail pages: ${stats.found}/${stats.tried}`);
  return stats;
}
