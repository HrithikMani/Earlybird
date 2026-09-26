// Mock Discord webhook receiver for e2e tests.
// POST /api/webhooks/:id/:token[?wait=true]  -> records payload, returns {id} when wait=true
// Control: GET /_control/messages, POST /_control/reset, POST /_control/fail {status, retry_after, count}
import http from 'node:http';

export async function startMockDiscord(port = 0) {
  let messages = [];
  let failures = [];
  let seq = 1;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    if (url.pathname === '/_control/messages') return send(200, messages);
    if (url.pathname === '/_control/reset') {
      messages = [];
      failures = [];
      return send(200, { ok: true });
    }
    if (url.pathname === '/_control/fail') {
      const f = JSON.parse(body || '{}');
      for (let i = 0; i < (f.count ?? 1); i++) failures.push(f);
      return send(200, { ok: true });
    }
    const m = url.pathname.match(/^\/api\/webhooks\/([^/]+)\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const f = failures.shift();
      if (f) {
        if (f.status === 429) return send(429, { message: 'You are being rate limited.', retry_after: f.retry_after ?? 0.2, global: false }, { 'retry-after': String(f.retry_after ?? 0.2) });
        return send(f.status || 500, { message: 'mock failure' });
      }
      const payload = JSON.parse(body || '{}');
      const id = String(1000 + seq++);
      messages.push({ id, webhook: m[1], at: Date.now(), payload });
      return url.searchParams.get('wait') === 'true' ? send(200, { id, channel_id: m[1] }) : send(204);
    }
    send(404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    webhookUrl: (name = 'jobs') => `http://127.0.0.1:${actualPort}/api/webhooks/${name}/token-${name}`,
    close: () => new Promise((r) => server.close(r)),
  };
}
