// Builds the dashboard once so every worker's app instance serves the same production bundle.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default async function globalSetup() {
  if (process.env.EARLYBIRD_SKIP_BUILD === '1') return;
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const res = spawnSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) throw new Error('vite build failed');
}
