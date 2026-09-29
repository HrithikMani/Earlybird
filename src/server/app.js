import crypto from 'node:crypto';
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
import companyRoutes from './routes/companies.js';
import ruleRoutes from './routes/rules.js';
import roleRoutes from './routes/roles.js';
import jobRoutes from './routes/jobs.js';
import taskRoutes from './routes/tasks.js';

/** Route modules registered in order. Later phases append to this list. */
export const routeModules = [systemRoutes, settingsRoutes, logRoutes, modelRoutes, statsRoutes, testRoutes, companyRoutes, ruleRoutes, roleRoutes, jobRoutes, taskRoutes];

export async function buildServer({ extraRoutes = [], withWeb = true } = {}) {
  const app = Fastify({
    loggerInstance: logger.child({ scope: 'http' }),
    disableRequestLogging: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  // Password for other devices on the network. The local machine (CLI, scripts, doctor) is always allowed.
  app.addHook('onRequest', (req, reply, done) => {
    if (isLoopback(req.socket.remoteAddress)) return done();
    if (!config.password) {
      reply.code(403).type('text/plain').send('Earlybird is not open to the network: set EARLYBIRD_PASSWORD in .env and restart.');
      return;
    }
    if (checkBasicAuth(req.headers.authorization, config.password)) return done();
    reply.code(401).header('www-authenticate', 'Basic realm="Earlybird", charset="UTF-8"').type('text/plain').send('Password required');
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

export function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** HTTP Basic auth check (any username), constant-time on the password. */
export function checkBasicAuth(header, password) {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(password);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
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
