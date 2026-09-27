import { httpRequest } from './http.js';
import { getPath, mapApiItem } from './extract.js';
import { applyTemplate } from './normalize.js';
import { applyPagination, maxPagesFor, pageValue } from './paginate.js';
import { ParseError, throwIfAborted } from './errors.js';

/** Fetches raw items for one query from an `api` rule. */
export async function runApi(rule, ctx, query) {
  const vars = { query };
  let req = {
    url: applyTemplate(rule.url, vars, { urlEncode: true }),
    body: rule.body === undefined ? undefined : applyTemplate(rule.body, vars),
  };
  const headers = applyTemplate(rule.headers || {}, vars);
  const p = rule.pagination;
  const maxPages = maxPagesFor(rule, ctx.mode);
  const items = [];
  let baseUrl = req.url;
  let cursor;
  let prevFirst;

  for (let i = 0; i < maxPages; i++) {
    throwIfAborted(ctx.signal);
    let pageReq = req;
    if (p?.kind === 'cursor') {
      if (i > 0) pageReq = applyPagination(req, p, cursor);
    } else if (p) {
      pageReq = applyPagination(req, p, pageValue(p, i));
    }
    const res = await httpRequest({ method: rule.method, url: pageReq.url, headers, body: pageReq.body, signal: ctx.signal, timeoutMs: ctx.timeoutMs, userAgent: ctx.userAgent, meta: ctx.meta, log: ctx.log });
    if (i === 0) baseUrl = res.url || pageReq.url;
    let data;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      throw new ParseError(`response from ${pageReq.url} is not JSON (${res.contentType || 'unknown content-type'})`, { cause: e, detail: res.detail });
    }
    const arr = getPath(data, rule.jobs_path);
    if (!Array.isArray(arr)) {
      throw new ParseError(`jobs_path "${rule.jobs_path}" does not point to an array`, {
        detail: { ...res.detail, top_level_keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : typeof data },
      });
    }
    ctx.meta.pages++;
    if (!p || arr.length === 0) {
      items.push(...arr);
      break;
    }
    const first = JSON.stringify(arr[0]);
    if (i > 0 && first === prevFirst) break; // pagination param ignored by server
    prevFirst = first;
    items.push(...arr);
    if (p.kind === 'cursor') {
      cursor = getPath(data, p.cursor_path);
      if (!cursor) break;
    } else if (arr.length < p.page_size) break;
  }
  return { raw: items.map((it) => mapApiItem(it, rule.fields)), baseUrl };
}
