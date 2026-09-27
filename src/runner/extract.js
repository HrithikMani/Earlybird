import * as cheerio from 'cheerio';

/** Reads a dot-path ("a.b.0.c") from an object. Empty path returns the object itself. */
export function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

/** Sets a dot-path on an object (creating objects as needed). */
export function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] ??= {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

const clean = (s) => (s === null || s === undefined ? undefined : String(s).replace(/\s+/g, ' ').trim() || undefined);

function toStr(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'object') {
    if (Array.isArray(v)) return clean(v.map((x) => (typeof x === 'object' ? x?.name ?? x?.text ?? '' : x)).filter(Boolean).join(', '));
    return clean(v.name ?? v.text ?? v.label ?? JSON.stringify(v));
  }
  return clean(v);
}

/** Maps an API item to raw fields using dot-paths. */
export function mapApiItem(item, fields) {
  const out = {};
  for (const [k, path] of Object.entries(fields)) {
    const v = getPath(item, path);
    out[k] = k === 'posted_at' && typeof v === 'number' ? v : toStr(v);
  }
  return out;
}

/**
 * Selector syntax: "a.title" = text, "a.title@href" = attribute, "@data-id" = attribute of the item itself,
 * "." or "" = the item's own text.
 */
export function parseSelector(spec) {
  const at = spec.lastIndexOf('@');
  if (at > 0 && !/[\]\s'"]/.test(spec.slice(at + 1))) return { sel: spec.slice(0, at).trim(), attr: spec.slice(at + 1) };
  if (at === 0) return { sel: '', attr: spec.slice(1) };
  return { sel: spec.trim() === '.' ? '' : spec.trim(), attr: null };
}

/** Extracts raw items from HTML with an item selector + field selectors. */
export function extractHtml(html, itemSelector, fields) {
  const $ = cheerio.load(html);
  const items = [];
  let selectorError;
  try {
    $(itemSelector).each((_, el) => {
      const $el = $(el);
      const out = {};
      for (const [k, spec] of Object.entries(fields)) {
        const { sel, attr } = parseSelector(spec);
        const target = sel ? $el.find(sel).first() : $el;
        if (!target.length) continue;
        out[k] = clean(attr ? target.attr(attr) : target.text());
      }
      items.push(out);
    });
  } catch (e) {
    selectorError = e;
  }
  return { items, count: $(itemSelector).length, selectorError, title: clean($('title').text()) };
}

const CAPTCHA_MARKERS = [/g-recaptcha/i, /h-captcha|hcaptcha/i, /cf-challenge|challenge-platform|cf_chl_/i, /verify you are (a )?human/i, /are you a robot/i, /px-captcha/i];

export function looksLikeCaptcha(html) {
  return CAPTCHA_MARKERS.some((re) => re.test(html.slice(0, 200000)));
}
