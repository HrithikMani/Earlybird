import { Blocked, Cancelled, HttpError, NetworkError, Timeout } from './errors.js';
import { looksLikeCaptcha } from './extract.js';

const KEEP_HEADERS = ['content-type', 'content-length', 'server', 'retry-after', 'cf-ray', 'x-cache', 'location', 'www-authenticate'];

function pickHeaders(headers) {
  const out = {};
  for (const k of KEEP_HEADERS) {
    const v = headers.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * fetch() wrapper used by all HTTP rules. Records every request in `meta.requests`,
 * converts failures into typed RunnerErrors with debugging detail.
 */
export async function httpRequest({ method = 'GET', url, headers = {}, body, signal, timeoutMs = 30000, userAgent, meta, log }) {
  const started = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const reqHeaders = { 'user-agent': userAgent, accept: 'application/json, text/html;q=0.9, */*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...headers };
  let payload;
  if (body !== undefined && method !== 'GET') {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string' && !Object.keys(reqHeaders).some((h) => h.toLowerCase() === 'content-type')) reqHeaders['content-type'] = 'application/json';
  }
  const entry = { method, url, status: null, ms: null, bytes: null };
  meta?.requests?.push(entry);
  let res;
  try {
    res = await fetch(url, { method, headers: reqHeaders, body: payload, signal: combined, redirect: 'follow' });
  } catch (err) {
    entry.ms = Date.now() - started;
    if (signal?.aborted) throw new Cancelled('cancelled during request', { detail: { url, method } });
    if (timeout.aborted) throw new Timeout(`request timed out after ${timeoutMs} ms`, { detail: { url, method, timeoutMs } });
    const code = err.cause?.code || err.code;
    entry.error = code || err.message;
    throw new NetworkError(`${method} ${url} failed: ${code || err.message}`, { cause: err, detail: { url, method, code } });
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new Cancelled('cancelled while reading body');
    throw new NetworkError(`reading response body failed: ${err.message}`, { cause: err, detail: { url, method } });
  }
  entry.status = res.status;
  entry.ms = Date.now() - started;
  entry.bytes = text.length;
  if (meta) {
    meta.bytes = (meta.bytes || 0) + text.length;
    meta.last_status = res.status;
    meta.final_url = res.url;
  }
  log?.debug({ method, url, status: res.status, ms: entry.ms, bytes: entry.bytes }, 'http request');

  const detail = { url, final_url: res.url, method, status: res.status, headers: pickHeaders(res.headers), body_snippet: text.slice(0, 2048) };
  if (res.status === 403 || res.status === 429) {
    throw new Blocked(`${res.status === 429 ? 'rate limited' : 'forbidden'} (${res.status}) at ${url}`, { status: res.status, detail: { ...detail, retry_after: res.headers.get('retry-after') } });
  }
  if (res.status >= 400) throw new HttpError(res.status, `HTTP ${res.status} from ${url}`, { detail });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('html') && looksLikeCaptcha(text)) throw new Blocked(`captcha / bot challenge page at ${url}`, { detail });
  return { status: res.status, headers: res.headers, text, url: res.url, contentType, detail };
}
