import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, newId, schema } from '../db/index.js';
import { now } from '../runtime.js';

const C = schema.companies;

export const CompanyInputSchema = z.object({
  name: z.string().trim().min(1),
  careers_url: z.string().trim().url(),
  role_mode: z.enum(['global_plus_company', 'company_only', 'all_jobs']).default('global_plus_company'),
  interval_min: z.number().int().min(1).nullish(),
  source_filters: z.object({ location: z.string().optional(), department: z.string().optional() }).partial().nullish(),
  notify_filters: z.object({ excludeKeywords: z.array(z.string()).optional(), locations: z.array(z.string()).optional(), maxJobAgeDays: z.number().min(1).max(365).optional() }).partial().nullish(),
  discord_channel_id: z.string().nullish(),
  notes: z.string().nullish(),
});

export function listCompanies() {
  return getDb().select().from(C).orderBy(asc(C.name)).all();
}

export function getCompany(id) {
  return getDb().select().from(C).where(eq(C.id, id)).get();
}

export function createCompany(input, { status = 'pending_discovery' } = {}) {
  const c = CompanyInputSchema.parse(input);
  const t = Date.now();
  const row = {
    id: newId('cmp'),
    name: c.name,
    careers_url: c.careers_url,
    status,
    role_mode: c.role_mode,
    interval_min: c.interval_min ?? null,
    source_filters: c.source_filters ?? null,
    notify_filters: c.notify_filters ?? null,
    discord_channel_id: c.discord_channel_id ?? null,
    notes: c.notes ?? null,
    created_at: t,
    updated_at: t,
  };
  getDb().insert(C).values(row).run();
  return getCompany(row.id);
}

export function updateCompany(id, patch) {
  getDb().update(C).set({ ...patch, updated_at: Date.now() }).where(eq(C.id, id)).run();
  return getCompany(id);
}

export function editCompany(id, input) {
  const current = getCompany(id);
  if (!current) return null;
  const c = CompanyInputSchema.partial().parse(input);
  return updateCompany(id, c);
}

export function deleteCompany(id) {
  const db = getDb();
  for (const t of [schema.jobs, schema.seenJobs, schema.notifications, schema.runs, schema.rules, schema.verifications, schema.alerts, schema.companyTerms]) {
    db.delete(t).where(eq(t.company_id, id)).run();
  }
  db.delete(schema.roles).where(eq(schema.roles.company_id, id)).run();
  db.delete(C).where(eq(C.id, id)).run();
}

/** When the company should next run (its interval, or backoff interval when blocked). */
export function intervalMinFor(company, rule, scheduling) {
  const isBrowser = rule && (rule.type === 'browser' || (rule.type === 'script' && rule.spec?.uses_browser));
  const min = isBrowser ? scheduling.minIntervalBrowserMin : scheduling.minIntervalApiMin;
  const base = company.effective_interval_min || company.interval_min || rule?.spec?.interval_min || scheduling.defaultIntervalMin;
  return Math.max(min, base);
}

export function isDue(company, t = now()) {
  return !company.next_run_at || company.next_run_at <= t;
}
