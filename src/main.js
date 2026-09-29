import os from 'node:os';
import { config, ensureDataDirs, APP_VERSION } from './config.js';
import { logger, attachFileSink, errorDetail } from './log/logger.js';
import { attachDbSink, flushDbSink } from './log/db-sink.js';
import { openDb, closeDb } from './db/index.js';
import { getSettings } from './settings/index.js';
import { buildServer } from './server/app.js';
import { startServices, stopServices } from './services.js';
import { runtime } from './runtime.js';

const log = logger.child({ scope: 'server' });

process.on('uncaughtException', (err) => log.fatal({ err: errorDetail(err) }, 'uncaught exception'));
process.on('unhandledRejection', (err) => log.fatal({ err: errorDetail(err) }, 'unhandled rejection'));

async function main() {
  ensureDataDirs();
  openDb();
  attachDbSink();
  await attachFileSink(getSettings('retention').logDays);
  log.info(
    { version: APP_VERSION, node: process.version, platform: `${process.platform}/${process.arch}`, dataDir: config.dataDir, mode: config.isProd ? 'production' : config.isTest ? 'test' : 'development' },
    'earlybird starting',
  );

  const app = await buildServer();
  await startServices(app);
  await app.listen({ port: config.port, host: config.host });
  log.info({ url: `http://localhost:${config.port}` }, 'earlybird ready');
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => `http://${a.address}:${config.port}`);
    if (config.password) log.info({ urls: lan }, `reachable on the network (password required): ${lan.join(' ')}`);
    else log.warn({ urls: lan }, `reachable on the network WITHOUT a password (anyone on this network can use it): ${lan.join(' ')}`);
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    runtime.shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15000);
    force.unref();
    try {
      await stopServices();
      await app.close();
    } catch (err) {
      log.error({ err: errorDetail(err) }, 'error during shutdown');
    }
    flushDbSink();
    closeDb();
    log.info('bye');
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  // Test harness / parent process can ask for a graceful stop over IPC (works on Windows).
  process.on('message', (m) => m === 'shutdown' && shutdown('ipc'));
}

main().catch((err) => {
  log.fatal({ err: errorDetail(err) }, 'failed to start');
  flushDbSink();
  setTimeout(() => process.exit(1), 200);
});
