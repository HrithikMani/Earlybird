import { z } from 'zod';

const cron = z.string().min(9, 'cron expression like "* * * * *"');

export const DEFAULT_TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gh_src', 'gh_jid_src', 'source', 'src', 'ref', 'referrer', 'lever-source', 'lever-origin',
  'jobsource', 'sessionid', 'session_id', 'jsessionid', 'sid', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
];

// Anthropic first-party prices ($ per 1M tokens) for cost tracking; editable in Settings.
export const DEFAULT_PRICES = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export const SettingsSections = {
  ai: z.object({
    apiKey: z.string().default(''),
    discoveryModel: z.string().min(1).default('claude-sonnet-5'),
    verifyModel: z.string().min(1).default('claude-sonnet-5'),
    effort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']).default('default'),
    maxSteps: z.number().int().min(3).max(200).default(40),
    maxWallTimeMin: z.number().min(1).max(120).default(10),
    maxCostUsd: z.number().min(0.01).max(100).default(1),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    loopRepeatLimit: z.number().int().min(2).max(20).default(3),
    noProgressSteps: z.number().int().min(3).max(50).default(8),
    prices: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })).default(DEFAULT_PRICES),
    scheduledVerify: z
      .object({ enabled: z.boolean().default(false), cron: cron.default('0 9 * * *'), window: z.enum(['10m', '1h', '24h']).default('24h') })
      .default({ enabled: false, cron: '0 9 * * *', window: '24h' }),
  }),
  discord: z.object({
    channels: z
      .array(z.object({ id: z.string().min(1), name: z.string().min(1), webhookUrl: z.string().default('') }))
      .default([]),
    jobsChannelId: z.string().nullable().default(null),
    alertsChannelId: z.string().nullable().default(null),
    batchSize: z.number().int().min(1).max(10).default(10),
  }),
  scheduling: z.object({
    defaultIntervalMin: z.number().int().min(1).default(10),
    minIntervalApiMin: z.number().int().min(1).default(10),
    minIntervalBrowserMin: z.number().int().min(1).default(15),
    fullSweepEveryMin: z.number().int().min(5).default(60),
    jitterSec: z.number().int().min(0).max(600).default(60),
    apiPool: z.number().int().min(1).max(100).default(20),
    browserPool: z.number().int().min(1).max(20).default(3),
    agentPool: z.number().int().min(1).max(5).default(1),
    scrapeCron: cron.default('* * * * *'),
    discoveryCron: cron.default('* * * * *'),
    cleanupCron: cron.default('30 3 * * *'),
  }),
  roles: z.object({ maxTermsPerRun: z.number().int().min(1).max(50).default(10) }),
  filters: z.object({
    excludeKeywords: z.array(z.string()).default([]),
    locations: z.array(z.string()).default([]),
  }),
  dedupe: z.object({
    maxNotifyAgeHours: z.number().min(1).default(72),
    renotifyRepostedAfterDays: z.number().int().min(1).nullable().default(null),
    trackingParams: z.array(z.string()).default(DEFAULT_TRACKING_PARAMS),
  }),
  retention: z.object({
    closedJobDays: z.number().int().min(1).default(3),
    maxJobAgeDays: z.number().int().min(1).default(30),
    seenJobDays: z.number().int().min(30).default(365),
    runDays: z.number().int().min(1).default(30),
    logDays: z.number().int().min(1).default(14),
    taskEventDays: z.number().int().min(1).default(30),
    artifactDays: z.number().int().min(1).default(14),
  }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    saveTraces: z.boolean().default(false),
  }),
  scraping: z.object({
    userAgent: z
      .string()
      .default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Earlybird/0.1 (+job-alerts)'),
    respectRobots: z.boolean().default(true),
    requestTimeoutMs: z.number().int().min(1000).default(30000),
    actionTimeoutMs: z.number().int().min(1000).default(30000),
  }),
  mcp: z.object({
    playwright: z.object({ headless: z.boolean().default(true) }).default({ headless: true }),
    servers: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
          env: z.record(z.string(), z.string()).default({}),
          enabled: z.boolean().default(true),
          enabledFor: z.array(z.enum(['discovery', 'verify'])).default(['discovery', 'verify']),
        }),
      )
      .default([]),
  }),
  scripts: z.object({
    allow: z.boolean().default(true),
    requireApproval: z.boolean().default(false),
    timeoutMs: z.number().int().min(5000).max(600000).default(90000),
    memoryMb: z.number().int().min(64).max(4096).default(256),
  }),
};

export const SECTION_NAMES = Object.keys(SettingsSections);

export function sectionDefaults(name) {
  return SettingsSections[name].parse({});
}
