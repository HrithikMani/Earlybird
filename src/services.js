// Starts/stops the background services (scheduler, notifier, task queue).
import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { childLogger } from './log/logger.js';
import { startScheduler, stopScheduler, tick } from './worker/scheduler.js';
import { drainOutbox } from './notify/discord.js';
import { runCleanup } from './worker/cleanup.js';
import { closeBrowser } from './runner/browser-pool.js';
import * as registry from './tasks/registry.js';
import { testHooks } from './testing.js';

const log = childLogger('server');
const stops = [];

export function registerStop(fn) {
  stops.push(fn);
}

/** Marks work left "running" by a crash as interrupted. */
function recoverInterrupted() {
  const db = getDb();
  const runs = db.update(schema.runs).set({ status: 'interrupted', error_type: 'Interrupted', error_message: 'server stopped during the run' }).where(eq(schema.runs.status, 'running')).run();
  const tasks = db
    .update(schema.tasks)
    .set({ status: 'interrupted', error_type: 'Interrupted', error_message: 'server stopped during the task', finished_at: Date.now() })
    .where(inArray(schema.tasks.status, ['running', 'cancelling']))
    .run();
  if (runs.changes || tasks.changes) log.warn({ runs: runs.changes, tasks: tasks.changes }, 'marked work from a previous crash as interrupted');
}

export async function startServices(_app) {
  recoverInterrupted();
  startScheduler();
  testHooks.tick = tick;
  testHooks.drainOutbox = drainOutbox;
  testHooks.cleanup = async () => runCleanup();
  const { startTaskQueue } = await import('./tasks/queue.js').catch(() => ({}));
  if (startTaskQueue) startTaskQueue();
}

export async function stopServices() {
  stopScheduler();
  registry.stopAll('server shutting down');
  for (const stop of stops.reverse()) await stop();
  await new Promise((r) => setTimeout(r, 300));
  await closeBrowser();
}
