import { and, desc, eq } from 'drizzle-orm';
import { getDb, newId, schema } from '../db/index.js';
import { childLogger } from '../log/logger.js';
import { sendAlertToDiscord } from '../notify/discord.js';

const A = schema.alerts;
const log = childLogger('alerts');

export function listAlerts({ state, companyId, limit = 100 } = {}) {
  const where = [];
  if (state) where.push(eq(A.state, state));
  if (companyId) where.push(eq(A.company_id, companyId));
  return getDb().select().from(A).where(where.length ? and(...where) : undefined).orderBy(desc(A.created_at)).limit(limit).all();
}

/**
 * Raises an alert once per (company, kind) while it's open. Resolved alerts can be raised again.
 * Returns the alert row, or null when an identical open alert already exists.
 */
export async function raiseAlert({ companyId = null, ruleId = null, kind, message, level = 'warn' }) {
  const db = getDb();
  const open = db
    .select()
    .from(A)
    .where(and(companyId ? eq(A.company_id, companyId) : undefined, eq(A.kind, kind), eq(A.state, 'open')))
    .get();
  if (open) return null;
  const row = { id: newId('alt'), company_id: companyId, rule_id: ruleId, kind, state: 'open', message, created_at: Date.now(), sent_at: null, resolved_at: null };
  db.insert(A).values(row).run();
  log[level]({ company_id: companyId, rule_id: ruleId, kind, scope: 'run' }, `alert: ${message}`);
  const sent = await sendAlertToDiscord({ kind, message, companyId, level });
  if (sent) db.update(A).set({ sent_at: Date.now() }).where(eq(A.id, row.id)).run();
  return row;
}

/** Resolves open alerts of the given kinds for a company; optionally announces recovery once. */
export async function resolveAlerts(companyId, kinds, { announce } = {}) {
  const db = getDb();
  const open = db.select().from(A).where(and(eq(A.company_id, companyId), eq(A.state, 'open'))).all().filter((a) => !kinds || kinds.includes(a.kind));
  if (!open.length) return 0;
  for (const a of open) db.update(A).set({ state: 'resolved', resolved_at: Date.now() }).where(eq(A.id, a.id)).run();
  if (announce) await sendAlertToDiscord({ kind: 'recovered', message: announce, companyId, level: 'info' });
  return open.length;
}

export function resolveAlertById(id) {
  getDb().update(A).set({ state: 'resolved', resolved_at: Date.now() }).where(eq(A.id, id)).run();
}
