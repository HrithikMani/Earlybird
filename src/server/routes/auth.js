import {
  SESSION_COOKIE,
  authRequired,
  authState,
  clearFailures,
  createSession,
  isLockedOut,
  readCookie,
  recordFailure,
  sessionCookie,
  verifyCredentials,
  verifySession,
} from '../auth.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function loginPage({ error = '', next = '/', username = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Earlybird</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #1b1f24; }
  @media (prefers-color-scheme: dark) { body { background: #0f1115; color: #e6e8eb; } .card { background: #171a21 !important; border-color: #2a2f3a !important; } input { background: #10131a !important; color: #e6e8eb !important; border-color: #2a2f3a !important; } }
  .card { width: min(360px, 92vw); background: #fff; border: 1px solid #e4e7ec; border-radius: 12px; padding: 28px 28px 24px; box-shadow: 0 8px 30px rgba(0,0,0,.06); }
  h1 { font-size: 20px; margin: 0 0 4px; } p.sub { margin: 0 0 20px; color: #667085; font-size: 13px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #667085; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 10px; border: 1px solid #d0d5dd; border-radius: 8px; }
  input:focus { outline: 2px solid #c7d7fe; border-color: #2563eb; }
  button { margin-top: 18px; width: 100%; font: inherit; font-weight: 600; padding: 10px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
  .error { background: #fee4e2; color: #b42318; border-radius: 8px; padding: 8px 10px; font-size: 13px; margin-bottom: 8px; }
</style></head><body>
<form class="card" method="post" action="/login" data-testid="login-form">
  <h1>🐦 Earlybird</h1><p class="sub">Sign in to the dashboard</p>
  ${error ? `<div class="error" role="alert" data-testid="login-error">${esc(error)}</div>` : ''}
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="username">Username</label><input id="username" name="username" autocomplete="username" value="${esc(username)}" required autofocus data-testid="login-username">
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required data-testid="login-password">
  <button type="submit" data-testid="login-submit">Sign in</button>
</form></body></html>`;
}

export default async function authRoutes(app) {
  // Login form posts application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 10_000 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  app.get('/login', async (req, reply) => {
    if (!authState().enabled) return reply.redirect('/');
    if (verifySession(readCookie(req.headers.cookie, SESSION_COOKIE))) return reply.redirect(safeNext(req.query.next));
    return reply.type('text/html; charset=utf-8').send(loginPage({ next: safeNext(req.query.next) }));
  });

  app.post('/login', async (req, reply) => {
    const { username = '', password = '', next } = req.body || {};
    const ip = req.socket.remoteAddress;
    const wantsJson = (req.headers['content-type'] || '').includes('json');
    const fail = (status, error) => (wantsJson ? reply.code(status).send({ error }) : reply.code(status).type('text/html; charset=utf-8').send(loginPage({ error, next: safeNext(next), username })));
    if (isLockedOut(ip)) {
      req.log.warn({ scope: 'audit', ip }, 'login blocked: too many failed attempts');
      return fail(429, 'Too many failed attempts. Wait a minute and try again.');
    }
    if (!verifyCredentials(username, password)) {
      recordFailure(ip);
      req.log.warn({ scope: 'audit', ip, username }, 'login failed');
      return fail(401, 'Wrong username or password.');
    }
    clearFailures(ip);
    const s = createSession(username);
    reply.header('set-cookie', sessionCookie(s.value, s.maxAge, req.protocol === 'https'));
    req.log.info({ scope: 'audit', ip, username }, 'login');
    return wantsJson ? { ok: true } : reply.redirect(safeNext(next));
  });

  app.post('/logout', async (req, reply) => {
    reply.header('set-cookie', sessionCookie('', 0, req.protocol === 'https'));
    req.log.info({ scope: 'audit', ip: req.socket.remoteAddress }, 'logout');
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = verifySession(readCookie(req.headers.cookie, SESSION_COOKIE));
    return { enabled: authState().enabled, required: authRequired(req.socket.remoteAddress), user };
  });
}
