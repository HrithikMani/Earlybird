// Starts an isolated Earlybird instance for one Playwright worker: own port, own temp data dir, test mode.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startApp({ port, env = {}, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'earlybird-e2e-'));
  const logFile = path.join(dir, 'app-output.log');
  let child;
  let out;

  const spawn = async () => {
    out = fs.createWriteStream(logFile, { flags: 'a' });
    child = fork(path.join(root, 'src', 'main.js'), ['--prod'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        EARLYBIRD_TEST: '1',
        EARLYBIRD_SKIP_DOTENV: '1',
        ANTHROPIC_API_KEY: '',
        LOG_LEVEL: process.env.EARLYBIRD_E2E_LOG_LEVEL || 'info',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`app exited early (code ${child.exitCode}); see ${logFile}`);
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.status) return; // any HTTP answer means it's up (401 when a login is required)
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`app did not start within 30s; see ${logFile}`);
  };

  const stop = async ({ graceful = true } = {}) => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    if (graceful && child.connected) child.send('shutdown');
    else child.kill('SIGKILL');
    const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(t);
    out.end();
  };

  await spawn();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    dataDir: dir,
    logFile,
    stop,
    /** Restart the same instance (same data dir). `crash: true` kills it without a graceful shutdown. */
    async restart({ crash = false } = {}) {
      await stop({ graceful: !crash });
      await spawn();
    },
    async dispose() {
      await stop();
      if (!process.env.EARLYBIRD_KEEP_E2E_DATA) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
