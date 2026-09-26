// Shared helpers for setup / preflight / doctor. Plain Node, works on Windows, macOS and Linux.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isWin = process.platform === 'win32';
export const require = createRequire(path.join(ROOT, 'package.json'));

const color = (c) => (s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
export const green = color(32);
export const yellow = color(33);
export const red = color(31);
export const bold = color(1);

export const ok = (msg) => console.log(`${green('✔')} ${msg}`);
export const warn = (msg) => console.log(`${yellow('!')} ${msg}`);
export const fail = (msg) => console.log(`${red('✖')} ${msg}`);

/** Runs a command with inherited stdio. npm/npx resolve to .cmd on Windows. */
export function run(cmd, args, opts = {}) {
  const bin = isWin && ['npm', 'npx'].includes(cmd) ? `${cmd}.cmd` : cmd;
  const res = spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit', shell: isWin && bin.endsWith('.cmd'), ...opts });
  return res.status === 0;
}

export function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

export function dataDir() {
  loadEnv();
  return path.resolve(ROOT, process.env.DATA_DIR || 'data');
}

let envLoaded = false;
export function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  const f = path.join(ROOT, '.env');
  if (fs.existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      // ignore
    }
  }
}

export function checkDeps() {
  return fs.existsSync(path.join(ROOT, 'node_modules', 'fastify'));
}

export function checkChromium() {
  try {
    const { chromium } = require('playwright');
    const exe = chromium.executablePath();
    return { ok: fs.existsSync(exe), path: exe };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function checkSqlite() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    const v = db.prepare('select sqlite_version() as v').get().v;
    db.close();
    return { ok: true, version: v };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function checkDataDirWritable() {
  const dir = dataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, dir, error: e.message };
  }
}

export function sqliteFixHint() {
  if (isWin) return 'Run "npm rebuild better-sqlite3". If it still fails, install "Visual Studio Build Tools" (Desktop development with C++).';
  if (process.platform === 'darwin') return 'Run "npm rebuild better-sqlite3". If it still fails, run "xcode-select --install" first.';
  return 'Run "npm rebuild better-sqlite3". If it still fails, install build-essential and python3.';
}
