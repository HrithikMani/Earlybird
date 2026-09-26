// Diagnoses the environment and prints what's missing and how to fix it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, checkChromium, checkDataDirWritable, checkDeps, checkSqlite, dataDir, fail, loadEnv, nodeMajor, ok, sqliteFixHint, warn, require } from './lib.mjs';

export async function doctor({ quiet = false } = {}) {
  loadEnv();
  let problems = 0;
  const bad = (m) => {
    problems++;
    fail(m);
  };
  if (!quiet) console.log(bold('\nEarlybird doctor'));
  console.log(`  OS: ${process.platform}/${process.arch} · Node ${process.versions.node}`);

  nodeMajor() >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node}: need 22+ (https://nodejs.org)`);
  if (!checkDeps()) {
    bad('Dependencies missing: run "npm install"');
    return problems;
  }
  ok('Dependencies installed');

  const sq = checkSqlite();
  sq.ok ? ok(`SQLite ${sq.version}`) : bad(`SQLite driver: ${sq.error}\n    ${sqliteFixHint()}`);

  const ch = checkChromium();
  ch.ok ? ok('Playwright Chromium installed') : bad('Playwright Chromium missing: run "npx playwright install chromium"');

  const dd = checkDataDirWritable();
  dd.ok ? ok(`Data dir ${dd.dir}`) : bad(`Data dir ${dd.dir} not writable: ${dd.error}`);

  const dbFile = path.join(dataDir(), 'earlybird.db');
  if (fs.existsSync(dbFile) && sq.ok) {
    const Database = require('better-sqlite3');
    const db = new Database(dbFile, { readonly: true });
    const get = (key) => {
      try {
        const row = db.prepare('select value from settings where key = ?').get(key);
        return row ? JSON.parse(row.value) : {};
      } catch {
        return {};
      }
    };
    const ai = get('ai');
    const discord = get('discord');
    ai.apiKey || process.env.ANTHROPIC_API_KEY ? ok('Anthropic API key set') : warn('No Anthropic API key (Settings → AI). Discovery/verification disabled.');
    const chans = discord.channels || [];
    const jobs = chans.find((c) => c.id === discord.jobsChannelId);
    jobs?.webhookUrl ? ok(`Discord jobs channel: ${jobs.name}`) : warn('No Discord jobs channel (Settings → Discord). Jobs are stored but not sent.');
    try {
      const n = db.prepare('select count(*) as n from companies').get().n;
      ok(`${n} compan${n === 1 ? 'y' : 'ies'} configured`);
    } catch {
      // not migrated yet
    }
    db.close();
  } else {
    warn('Database not created yet; it is created on first "npm run dev" or "npm run setup".');
  }

  const port = Number(process.env.PORT || 3000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const h = await res.json();
    h.ok ? ok(`Server running on http://localhost:${port}`) : warn(`Server on :${port} reports problems: ${JSON.stringify({ db: h.db, stalled: h.scheduler?.stalled })}`);
  } catch {
    console.log(`  Server not running on :${port} (start it with "npm run dev").`);
  }
  console.log(problems ? `\n${problems} problem(s) found.` : '\nAll good.');
  return problems;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const n = await doctor();
  process.exit(n ? 1 : 0);
}
