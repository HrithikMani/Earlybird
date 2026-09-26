// Cross-platform first-time setup. Idempotent: safe to re-run.
// Usage: npm run setup [-- --yes]
import fs from 'node:fs';
import path from 'node:path';
import { bold, checkChromium, checkSqlite, fail, isWin, nodeMajor, ok, ROOT, run, sqliteFixHint, warn } from './lib.mjs';

const yes = process.argv.includes('--yes') || process.argv.includes('-y') || !process.stdin.isTTY;

console.log(bold('\n🐦 Earlybird setup\n'));
console.log(`  OS: ${process.platform}/${process.arch} · Node ${process.versions.node}\n`);

// 1. Node version
if (nodeMajor() < 22) {
  fail(`Node ${process.versions.node} is too old. Install Node 22 LTS from https://nodejs.org and re-run.`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

// 2. Dependencies
const hasLock = fs.existsSync(path.join(ROOT, 'package-lock.json'));
console.log(`\n→ Installing dependencies (${hasLock ? 'npm ci' : 'npm install'})…`);
if (!run('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'])) {
  fail('npm install failed. See the output above.');
  process.exit(1);
}
ok('Dependencies installed');

// 3. Chromium for Playwright
console.log('\n→ Installing Playwright Chromium…');
const pwArgs = ['playwright', 'install', 'chromium'];
if (process.platform === 'linux') pwArgs.push('--with-deps');
if (!run('npx', pwArgs)) warn('Chromium install reported a problem; browser rules and e2e tests need it. Re-run "npx playwright install chromium".');
checkChromium().ok ? ok('Chromium ready') : warn('Chromium not found after install.');

// 4. SQLite native driver
const sq = checkSqlite();
if (!sq.ok) {
  fail(`SQLite driver failed to load: ${sq.error}`);
  console.log(`  ${sqliteFixHint()}`);
  process.exit(1);
}
ok(`SQLite ${sq.version}`);

// 5. Data dirs + .env
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) {
  fs.copyFileSync(path.join(ROOT, '.env.example'), envFile);
  ok('Created .env from .env.example');
} else ok('.env exists');

// 6 + 7. Migrations and optional questions run in a child process (needs the freshly installed deps).
console.log('\n→ Preparing database…');
if (!run(process.execPath, [path.join(ROOT, 'scripts', 'setup-config.mjs'), ...(yes ? ['--yes'] : [])])) {
  fail('Database setup failed. See the output above.');
  process.exit(1);
}

// 8. Doctor
console.log('');
run(process.execPath, [path.join(ROOT, 'scripts', 'doctor.mjs')]);
console.log(bold(`\nDone. Start Earlybird with:  npm run dev   →  http://localhost:3000${isWin ? '' : ''}\n`));
