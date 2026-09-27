import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

const ts = (name) => integer(name, { mode: 'number' });
const json = (name) => text(name, { mode: 'json' });
const timestamps = {
  created_at: ts('created_at').notNull(),
  updated_at: ts('updated_at').notNull(),
};

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json('value').notNull(),
  updated_at: ts('updated_at').notNull(),
});

export const companies = sqliteTable('companies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  careers_url: text('careers_url').notNull(),
  status: text('status').notNull(), // pending_discovery|discovering|active|degraded|failing|needs_review|paused
  role_mode: text('role_mode').notNull().default('global_plus_company'),
  active_rule_id: text('active_rule_id'),
  fallback_rule_id: text('fallback_rule_id'),
  using_fallback: integer('using_fallback', { mode: 'boolean' }).notNull().default(false),
  baseline_rule_id: text('baseline_rule_id'),
  last_alert_state: text('last_alert_state'),
  interval_min: integer('interval_min'),
  effective_interval_min: integer('effective_interval_min'),
  source_filters: json('source_filters'),
  notify_filters: json('notify_filters'),
  discord_channel_id: text('discord_channel_id'),
  last_run_at: ts('last_run_at'),
  next_run_at: ts('next_run_at'),
  last_success_at: ts('last_success_at'),
  last_full_sweep_at: ts('last_full_sweep_at'),
  last_new_job_at: ts('last_new_job_at'),
  consecutive_failures: integer('consecutive_failures').notNull().default(0),
  consecutive_zero_runs: integer('consecutive_zero_runs').notNull().default(0),
  last_job_count: integer('last_job_count'),
  last_full_job_count: integer('last_full_job_count'),
  health_note: text('health_note'),
  notes: text('notes'),
  ...timestamps,
});

export const roles = sqliteTable(
  'roles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    scope: text('scope').notNull(), // global|company
    company_id: text('company_id'),
    search_terms: json('search_terms').notNull(),
    synonyms: json('synonyms').notNull(),
    exclude_words: json('exclude_words').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    notify_existing: integer('notify_existing', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => [index('roles_company_idx').on(t.company_id)],
);

/** Which search terms have already been baselined for a company (silent first run per new term). */
export const companyTerms = sqliteTable(
  'company_terms',
  {
    company_id: text('company_id').notNull(),
    term: text('term').notNull(),
    baselined_at: ts('baselined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.company_id, t.term] })],
);

export const rules = sqliteTable(
  'rules',
  {
    id: text('id').primaryKey(),
    rule_key: text('rule_key').notNull(),
    version: integer('version').notNull(),
    company_id: text('company_id').notNull(),
    slot: text('slot').notNull(), // active|fallback|candidate|retired
    type: text('type').notNull(), // api|html|browser|script
    strategy: text('strategy').notNull(), // url|playwright|script
    spec: json('spec').notNull(),
    code: text('code'),
    code_hash: text('code_hash'),
    approved_at: ts('approved_at'),
    score: json('score'),
    source_task_id: text('source_task_id'),
    created_by: text('created_by').notNull(), // discovery|manual|promotion|cli|seed
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [index('rules_company_idx').on(t.company_id), index('rules_key_idx').on(t.rule_key)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    company_id: text('company_id').notNull(),
    rule_id: text('rule_id'),
    job_key: text('job_key').notNull(),
    external_id: text('external_id'),
    canonical_url: text('canonical_url').notNull(),
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    location: text('location'),
    department: text('department'),
    posted_at: ts('posted_at'),
    posted_at_raw: text('posted_at_raw'),
    matched_roles: json('matched_roles'),
    search_term: text('search_term'),
    first_seen_at: ts('first_seen_at').notNull(),
    last_seen_at: ts('last_seen_at').notNull(),
    seen_count: integer('seen_count').notNull().default(1),
    missing_sweeps: integer('missing_sweeps').notNull().default(0),
    closed_at: ts('closed_at'),
    notify_status: text('notify_status').notNull(), // pending|sent|skipped
    notify_skip_reason: text('notify_skip_reason'),
  },
  (t) => [
    uniqueIndex('jobs_company_key_uq').on(t.company_id, t.job_key),
    index('jobs_first_seen_idx').on(t.first_seen_at),
    index('jobs_rule_idx').on(t.rule_id),
  ],
);

export const seenJobs = sqliteTable(
  'seen_jobs',
  {
    company_id: text('company_id').notNull(),
    job_key: text('job_key').notNull(),
    external_id: text('external_id'),
    canonical_url: text('canonical_url').notNull(),
    fingerprint: text('fingerprint').notNull(),
    aliases: json('aliases'),
    title: text('title').notNull(),
    first_seen_at: ts('first_seen_at').notNull(),
    last_seen_at: ts('last_seen_at').notNull(),
    first_rule_id: text('first_rule_id'),
    notified_at: ts('notified_at'),
    posted_at: ts('posted_at'), // remembered so detail pages are read at most once per job
  },
  (t) => [
    primaryKey({ columns: [t.company_id, t.job_key] }),
    index('seen_url_idx').on(t.company_id, t.canonical_url),
    index('seen_fp_idx').on(t.company_id, t.fingerprint),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    company_id: text('company_id').notNull(),
    job_key: text('job_key').notNull(),
    job_id: text('job_id'),
    channel_id: text('channel_id').notNull(),
    kind: text('kind').notNull().default('job'), // job|resend
    status: text('status').notNull(), // pending|sent|failed
    discord_message_id: text('discord_message_id'),
    attempts: integer('attempts').notNull().default(0),
    next_attempt_at: ts('next_attempt_at'),
    last_error: text('last_error'),
    created_at: ts('created_at').notNull(),
    sent_at: ts('sent_at'),
  },
  (t) => [
    uniqueIndex('notif_uq').on(t.company_id, t.job_key, t.channel_id, t.kind),
    index('notif_status_idx').on(t.status),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    company_id: text('company_id').notNull(),
    rule_id: text('rule_id'),
    mode: text('mode').notNull(), // fast|full
    trigger: text('trigger').notNull(), // schedule|manual|fallback|baseline
    status: text('status').notNull(), // running|ok|error|cancelled|interrupted
    started_at: ts('started_at').notNull(),
    duration_ms: integer('duration_ms'),
    http_status: integer('http_status'),
    job_count: integer('job_count'),
    new_job_count: integer('new_job_count'),
    notified_count: integer('notified_count'),
    closed_job_count: integer('closed_job_count'),
    stats: json('stats'),
    error_type: text('error_type'),
    error_message: text('error_message'),
    error_detail: json('error_detail'),
    artifacts: json('artifacts'),
  },
  (t) => [index('runs_company_idx').on(t.company_id, t.started_at), index('runs_rule_idx').on(t.rule_id)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // discovery|verify|run_now|synonyms
    company_id: text('company_id'),
    rule_id: text('rule_id'),
    parent_task_id: text('parent_task_id'),
    attempt: integer('attempt').notNull().default(1),
    status: text('status').notNull(),
    input: json('input'),
    result: json('result'),
    error_type: text('error_type'),
    error_message: text('error_message'),
    model: text('model'),
    prompt_file: text('prompt_file'),
    prompt_hash: text('prompt_hash'),
    steps: integer('steps').notNull().default(0),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    cost_usd: real('cost_usd').notNull().default(0),
    operator_note: text('operator_note'),
    created_at: ts('created_at').notNull(),
    started_at: ts('started_at'),
    finished_at: ts('finished_at'),
  },
  (t) => [index('tasks_status_idx').on(t.status), index('tasks_company_idx').on(t.company_id)],
);

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    task_id: text('task_id').notNull(),
    ts: ts('ts').notNull(),
    seq: integer('seq').notNull(),
    level: text('level').notNull(),
    type: text('type').notNull(), // status|step|tool_call|tool_result|model_text|guard|log
    data: json('data'),
  },
  (t) => [index('task_events_task_idx').on(t.task_id, t.seq)],
);

export const verifications = sqliteTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    rule_id: text('rule_id').notNull(),
    company_id: text('company_id').notNull(),
    task_id: text('task_id'),
    source: text('source').notNull().default('app'), // app|cli
    window: text('window').notNull(),
    verdict: text('verdict').notNull(),
    report: json('report').notNull(),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('verif_rule_idx').on(t.rule_id)],
);

export const logs = sqliteTable(
  'logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: ts('ts').notNull(),
    level: text('level').notNull(),
    msg: text('msg'),
    scope: text('scope'),
    company_id: text('company_id'),
    rule_id: text('rule_id'),
    run_id: text('run_id'),
    task_id: text('task_id'),
    data: json('data'),
  },
  (t) => [
    index('logs_ts_idx').on(t.ts),
    index('logs_run_idx').on(t.run_id),
    index('logs_task_idx').on(t.task_id),
    index('logs_company_idx').on(t.company_id),
  ],
);

export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    company_id: text('company_id'),
    rule_id: text('rule_id'),
    kind: text('kind').notNull(),
    state: text('state').notNull(), // open|resolved
    message: text('message').notNull(),
    sent_at: ts('sent_at'),
    created_at: ts('created_at').notNull(),
    resolved_at: ts('resolved_at'),
  },
  (t) => [index('alerts_company_idx').on(t.company_id, t.kind)],
);
