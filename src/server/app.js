import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import middie from '@fastify/middie';
import { config } from '../config.js';
import { logger } from '../log/logger.js';
import { errorDetail } from '../log/logger.js';
import systemRoutes from './routes/system.js';
import settingsRoutes from './routes/settings.js';
import logRoutes from './routes/logs.js';
import modelRoutes from './routes/models.js';
import statsRoutes from './routes/stats.js';
import testRoutes from './routes/test.js';
import authRoutes from './routes/auth.js';
import { SESSION_COOKIE, authRequired, initAuth, readCookie, verifySession } from './auth.js';
import companyRoutes from './routes/companies.js';
import ruleRoutes from './routes/rules.js';
import roleRoutes from './routes/roles.js';
import jobRoutes from './routes/jobs.js';
import taskRoutes from './routes/tasks.js';

/** Route modules registered in order. Later phases append to this list. */
export const routeModules = [authRoutes, systemRoutes, settingsRoutes, logRoutes, modelRoutes, statsRoutes, testRoutes, companyRoutes, ruleRoutes, roleRoutes, jobRoutes, taskRoutes];

export async function buildServer({ extraRoutes = [], withWeb = true } = {}) {
  const app = Fastify({
    loggerInstance: logger.child({ scope: 'http' }),
    disableRequestLogging: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  // Login (when EARLYBIRD_PASSWORD is set): pages redirect to /login, API calls get 401 until signed in.
  // This computer skips it unless EARLYBIRD_AUTH_LOCAL=1, so the CLI and scripts keep working.
  initAuth();
  const PUBLIC_PATHS = new Set(['/login', '/logout', '/api/auth/me', '/favicon.ico']);
  app.addHook('onRequest', (req, reply, done) => {
    if (!authRequired(req.socket.remoteAddress)) return done();
    const pathOnly = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(pathOnly)) return done();
    if (verifySession(readCookie(req.headers.cookie, SESSION_COOKIE))) return done();
    if (req.method === 'GET' && !pathOnly.startsWith('/api/')) {
      reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
      return;
    }
    reply.code(401).send({ error: 'login_required', message: 'Sign in at /login' });
  });

  app.addHook('onResponse', (req, reply, done) => {
    if (req.url.startsWith('/api/') && !req.url.includes('/stream')) {
      const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'debug';
      req.log[level]({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'http request');
    }
    done();
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode < 600 ? err.statusCode : 500;
    req.log.error({ err: errorDetail(err), url: req.url }, 'request failed');
    reply.code(status).send({ error: err.code || 'internal_error', message: err.message });
  });

  for (const mod of [...routeModules, ...extraRoutes]) await app.register(mod);

  if (withWeb) await mountWeb(app);
  return app;
}

async function mountWeb(app) {
  if (!config.isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: config.paths.webRoot,
      configFile: path.join(config.paths.webRoot, '..', 'vite.config.js'),
      server: { middlewareMode: true, hmr: config.isTest ? false : { server: app.server } },
      appType: 'spa',
      logLevel: 'warn',
    });
    await app.register(middie);
    app.use((req, res, next) => (req.url.startsWith('/api/') ? next() : vite.middlewares(req, res, next)));
    app.addHook('onClose', async () => vite.close());
    return;
  }
  if (!fs.existsSync(path.join(config.paths.webDist, 'index.html'))) {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<h1>Earlybird</h1><p>Dashboard not built. Run <code>npm run build</code>.</p>'));
    return;
  }
  await app.register(fastifyStatic, { root: config.paths.webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
}
