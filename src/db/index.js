import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { nanoid, customAlphabet } from 'nanoid';
import { config } from '../config.js';
import * as schema from './schema.js';

export { schema };

let sqlite;
let db;

/** Opens (once) the SQLite DB in WAL mode and runs migrations. */
export function openDb(file = config.paths.db) {
  if (db) return db;
  sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: config.paths.migrations });
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not opened; call openDb() first');
  return db;
}

export function getSqlite() {
  if (!sqlite) throw new Error('DB not opened');
  return sqlite;
}

export function closeDb() {
  if (sqlite) {
    try {
      sqlite.close();
    } finally {
      sqlite = undefined;
      db = undefined;
    }
  }
}

/** Runs fn inside a synchronous SQLite transaction. */
export function tx(fn) {
  return getSqlite().transaction(fn)();
}

const shortId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

/** Prefixed id, e.g. newId('rul') -> rul_k3j2h1g0f9 */
export function newId(prefix) {
  return `${prefix}_${shortId()}`;
}

export { nanoid };
