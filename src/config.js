import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env is optional; it only bootstraps a few values.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && !process.env.EARLYBIRD_SKIP_DOTENV) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env must not stop the app from booting.
  }
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  dataDir,
  logLevel: process.env.LOG_LEVEL || 'info',
  isTest: process.env.EARLYBIRD_TEST === '1',
  isProd: process.env.NODE_ENV === 'production' || process.argv.includes('--prod'),
  anthropicApiKeyEnv: process.env.ANTHROPIC_API_KEY || '',
  mockPortalUrl: process.env.EARLYBIRD_MOCK_PORTAL_URL || '',
  paths: {
    db: path.join(dataDir, 'earlybird.db'),
    logs: path.join(dataDir, 'logs'),
    artifacts: path.join(dataDir, 'artifacts'),
    rules: path.join(dataDir, 'rules'),
    drafts: path.join(dataDir, 'drafts'),
    prompts: path.join(ROOT, 'prompts'),
    webRoot: path.join(ROOT, 'web'),
    webDist: path.join(ROOT, 'web', 'dist'),
    migrations: path.join(ROOT, 'src', 'db', 'migrations'),
  },
};

export function ensureDataDirs() {
  for (const dir of [config.dataDir, config.paths.logs, config.paths.artifacts, config.paths.rules, config.paths.drafts]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
