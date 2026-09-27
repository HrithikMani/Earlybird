import { httpRequest } from './http.js';
import { extractHtml } from './extract.js';
import { applyTemplate } from './normalize.js';
import { applyPagination, maxPagesFor, pageValue } from './paginate.js';
import { SelectorNotFound, throwIfAborted } from './errors.js';

/** Fetches raw items for one query from an `html` rule. */
export async function runHtml(rule, ctx, query) {
  const vars = { query };
  const req = {
    url: applyTemplate(rule.url, vars, { urlEncode: true }),
    body: rule.body === undefined ? undefined : applyTemplate(rule.body, vars),
  };
  const headers = applyTemplate(rule.headers || {}, vars);
  const p = rule.pagination?.kind === 'cursor' ? undefined : rule.pagination;
  const maxPages = maxPagesFor(rule, ctx.mode);
  const items = [];
  let baseUrl = req.url;
  let prevFirst;

  for (let i = 0; i < maxPages; i++) {
    throwIfAborted(ctx.signal);
    const pageReq = p ? applyPagination(req, p, pageValue(p, i)) : req;
    const res = await httpRequest({ method: rule.method, url: pageReq.url, headers, body: pageReq.body, signal: ctx.signal, timeoutMs: ctx.timeoutMs, userAgent: ctx.userAgent, meta: ctx.meta, log: ctx.log });
    if (i === 0) baseUrl = res.url || pageReq.url;
    const { items: found, count, selectorError, title } = extractHtml(res.text, rule.item_selector, rule.fields);
    if (selectorError) throw new SelectorNotFound(`invalid selector: ${selectorError.message}`, { detail: { ...res.detail, item_selector: rule.item_selector } });
    ctx.meta.pages++;
    if (i === 0 && count === 0 && !query) {
      throw new SelectorNotFound(`item_selector "${rule.item_selector}" matched nothing`, {
        detail: { ...res.detail, item_selector: rule.item_selector, page_title: title },
      });
    }
    if (!p || count === 0) {
      items.push(...found);
      break;
    }
    const first = JSON.stringify(found[0]);
    if (i > 0 && first === prevFirst) break;
    prevFirst = first;
    items.push(...found);
    if (count < p.page_size) break;
  }
  return { raw: items, baseUrl };
}
