import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import pino from 'pino';
import pretty from 'pino-pretty';
import pinoRoll from 'pino-roll';
import path from 'node:path';
import { config } from '../config.js';
import { redactString } from './redact.js';

/** Every log entry (parsed) is emitted here for the live tail + DB sink. */
export const logBus = new EventEmitter();
logBus.setMaxListeners(100);

const LEVEL_NAMES = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

function busStream() {
  return new Writable({
    write(chunk, _enc, cb) {
      try {
        const entry = JSON.parse(chunk.toString());
        entry.levelName = LEVEL_NAMES[entry.level] || String(entry.level);
        logBus.emit('entry', entry);
      } catch {
        // ignore unparsable lines
      }
      cb();
    },
  });
}

const streams = pino.multistream(
  [
    {
      level: config.logLevel,
      stream: config.isProd || config.isTest
        ? pino.destination({ dest: 1, sync: false })
        : pretty({ colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,app,reqId', singleLine: true, sync: true }),
    },
    { level: 'trace', stream: busStream() },
  ],
  { dedupe: false },
);

export const logger = pino(
  {
    level: 'trace',
    base: { app: 'earlybird' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['apiKey', '*.apiKey', 'webhookUrl', '*.webhookUrl', '*.*.webhookUrl', 'headers.authorization', 'headers["x-api-key"]'],
      censor: '[redacted]',
    },
    hooks: {
      streamWrite: (s) => redactString(s),
    },
    serializers: { err: pino.stdSerializers.errWithCause, error: pino.stdSerializers.errWithCause },
  },
  streams,
);

let fileStreamAdded = false;

/** Adds the daily rotating JSON log file under data/logs/. */
export async function attachFileSink(retentionDays = 14) {
  if (fileStreamAdded) return;
  const stream = await pinoRoll({
    file: path.join(config.paths.logs, 'earlybird'),
    frequency: 'daily',
    dateFormat: 'yyyy-MM-dd',
    extension: '.log',
    mkdir: true,
    limit: { count: retentionDays },
  });
  streams.add({ level: 'debug', stream });
  fileStreamAdded = true;
}

/** Child logger with Earlybird context fields. */
export function childLogger(scope, ctx = {}) {
  return logger.child({ scope, ...ctx });
}

/** Flattens an error (with cause chain and RunnerError detail) for storage. */
export function errorDetail(err) {
  if (!err) return null;
  const chain = [];
  let cur = err.cause;
  while (cur && chain.length < 5) {
    chain.push({ name: cur.name, message: redactString(String(cur.message ?? cur)), code: cur.code });
    cur = cur.cause;
  }
  return {
    type: err.type || err.name || 'Error',
    message: redactString(String(err.message ?? err)),
    stack: redactString(err.stack || ''),
    code: err.code,
    detail: err.detail ? JSON.parse(redactString(JSON.stringify(err.detail))) : undefined,
    cause: chain.length ? chain : undefined,
  };
}
