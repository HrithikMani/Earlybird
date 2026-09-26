// Quick checks before `npm run dev` / `npm start`. Exits non-zero with a clear fix instead of crashing later.
import { checkChromium, checkDataDirWritable, checkDeps, checkSqlite, fail, nodeMajor, sqliteFixHint } from './lib.mjs';

const problems = [];
if (nodeMajor() < 22) problems.push(`Node ${process.versions.node} is too old; Earlybird needs Node 22+.`);
if (!checkDeps()) problems.push('Dependencies are not installed.');
else {
  const sq = checkSqlite();
  if (!sq.ok) problems.push(`SQLite driver failed to load: ${sq.error}\n  ${sqliteFixHint()}`);
  if (!checkChromium().ok) problems.push('Playwright Chromium is not installed.');
}
const dd = checkDataDirWritable();
if (!dd.ok) problems.push(`Data directory ${dd.dir} is not writable: ${dd.error}`);

if (problems.length) {
  for (const p of problems) fail(p);
  console.log('\nRun "npm run setup" to fix this (safe to re-run), then try again.');
  process.exit(1);
}
