import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb, newId, schema, tx } from '../db/index.js';
import { parseRule } from '../schema/rule.js';
import { hashCode } from '../runner/script.js';
import { config } from '../config.js';
import { getCompany, updateCompany } from './companies.js';

const R = schema.rules;

export function getRule(id) {
  return getDb().select().from(R).where(eq(R.id, id)).get();
}

export function listRules(companyId) {
  return getDb().select().from(R).where(eq(R.company_id, companyId)).orderBy(desc(R.created_at)).all();
}

export function scriptPathFor(ruleId) {
  return path.join(config.paths.rules, `${ruleId}.mjs`);
}

/** Makes sure a script rule's code exists on disk (data/rules/<id>.mjs) and returns the path. */
export function ensureScriptFile(rule) {
  if (rule.type !== 'script' || !rule.code) return undefined;
  const file = scriptPathFor(rule.id);
  if (!fs.existsSync(file) || hashCode(fs.readFileSync(file, 'utf8')) !== rule.code_hash) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rule.code);
  }
  return file;
}

/**
 * Saves a rule as a new version. slot: active|fallback|candidate. `ruleKey` groups versions of the same rule line.
 * Activating demotes the previous active rule to retired (or keeps it as fallback when asked).
 */
export function saveRule({ companyId, spec, code, slot = 'candidate', createdBy, ruleKey, score, sourceTaskId, notes }) {
  const parsed = parseRule(spec);
  if (parsed.type === 'script' && !code) throw new Error('script rules need code');
  const t = Date.now();
  const id = newId('rul');
  const key = ruleKey || id;
  const prev = getDb().select().from(R).where(eq(R.rule_key, key)).orderBy(desc(R.version)).get();
  const row = {
    id,
    rule_key: key,
    version: (prev?.version ?? 0) + 1,
    company_id: companyId,
    slot: 'candidate',
    type: parsed.type,
    strategy: parsed.strategy,
    spec: { ...parsed, entry: parsed.type === 'script' ? `${id}.mjs` : undefined },
    code: code ?? null,
    code_hash: code ? hashCode(code) : null,
    approved_at: null,
    score: score ?? null,
    source_task_id: sourceTaskId ?? null,
    created_by: createdBy,
    notes: notes ?? null,
    created_at: t,
    updated_at: t,
  };
  getDb().insert(R).values(row).run();
  if (code) ensureScriptFile(row);
  if (slot === 'active') activateRule(id);
  else if (slot === 'fallback') setFallback(id);
  return getRule(id);
}

/** Makes a rule the company's active rule. The old active becomes fallback when `keepOldAsFallback`, else retired. */
export function activateRule(ruleId, { keepOldAsFallback = false, approve = true } = {}) {
  const rule = getRule(ruleId);
  if (!rule) throw new Error(`rule ${ruleId} not found`);
  const company = getCompany(rule.company_id);
  tx(() => {
    const db = getDb();
    const t = Date.now();
    if (company.active_rule_id && company.active_rule_id !== ruleId) {
      db.update(R).set({ slot: keepOldAsFallback ? 'fallback' : 'retired', updated_at: t }).where(eq(R.id, company.active_rule_id)).run();
    }
    if (company.fallback_rule_id === ruleId) {
      db.update(schema.companies).set({ fallback_rule_id: keepOldAsFallback ? company.active_rule_id : null }).where(eq(schema.companies.id, company.id)).run();
    } else if (keepOldAsFallback && company.active_rule_id) {
      if (company.fallback_rule_id) db.update(R).set({ slot: 'retired', updated_at: t }).where(eq(R.id, company.fallback_rule_id)).run();
      db.update(schema.companies).set({ fallback_rule_id: company.active_rule_id }).where(eq(schema.companies.id, company.id)).run();
    }
    db.update(R).set({ slot: 'active', updated_at: t, ...(approve && !rule.approved_at ? { approved_at: t } : {}) }).where(eq(R.id, ruleId)).run();
  });
  const status = ['paused'].includes(company.status) ? company.status : 'active';
  return updateCompany(company.id, { active_rule_id: ruleId, status, using_fallback: false, consecutive_failures: 0, consecutive_zero_runs: 0, next_run_at: null, health_note: null });
}

export function setFallback(ruleId) {
  const rule = getRule(ruleId);
  const company = getCompany(rule.company_id);
  const db = getDb();
  if (company.fallback_rule_id && company.fallback_rule_id !== ruleId) db.update(R).set({ slot: 'candidate', updated_at: Date.now() }).where(eq(R.id, company.fallback_rule_id)).run();
  db.update(R).set({ slot: 'fallback', updated_at: Date.now() }).where(eq(R.id, ruleId)).run();
  return updateCompany(company.id, { fallback_rule_id: ruleId });
}

/** Re-activates the most recent previously active (now retired) version for the company. */
export function rollbackRule(companyId) {
  const company = getCompany(companyId);
  const prev = getDb()
    .select()
    .from(R)
    .where(and(eq(R.company_id, companyId), inArray(R.slot, ['retired', 'fallback'])))
    .orderBy(desc(R.updated_at))
    .all()
    .find((r) => r.id !== company.active_rule_id);
  if (!prev) throw new Error('no previous rule to roll back to');
  activateRule(prev.id);
  return getRule(prev.id);
}

export function approveRule(ruleId) {
  getDb().update(R).set({ approved_at: Date.now(), updated_at: Date.now() }).where(eq(R.id, ruleId)).run();
  return getRule(ruleId);
}

/** The rule the scheduler should run for a company right now. */
export function currentRuleFor(company) {
  if (company.using_fallback && company.fallback_rule_id) return getRule(company.fallback_rule_id);
  return company.active_rule_id ? getRule(company.active_rule_id) : null;
}
