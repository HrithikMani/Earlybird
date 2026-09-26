import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, newId, schema } from '../db/index.js';

const R = schema.roles;

export const RoleInputSchema = z.object({
  name: z.string().trim().min(1),
  scope: z.enum(['global', 'company']).default('global'),
  company_id: z.string().nullish(),
  search_terms: z.array(z.string().trim().min(1)).optional(),
  synonyms: z.array(z.string().trim().min(1)).default([]),
  exclude_words: z.array(z.string().trim().min(1)).default([]),
  enabled: z.boolean().default(true),
  notify_existing: z.boolean().default(false),
});

export function listRoles({ scope, company_id } = {}) {
  const where = [];
  if (scope) where.push(eq(R.scope, scope));
  if (company_id) where.push(eq(R.company_id, company_id));
  return getDb().select().from(R).where(where.length ? and(...where) : undefined).orderBy(asc(R.name)).all();
}

export function getRole(id) {
  return getDb().select().from(R).where(eq(R.id, id)).get();
}

export function createRole(input) {
  const r = RoleInputSchema.parse(input);
  if (r.scope === 'company' && !r.company_id) throw new Error('company roles need company_id');
  const now = Date.now();
  const row = {
    id: newId('role'),
    name: r.name,
    scope: r.scope,
    company_id: r.scope === 'company' ? r.company_id : null,
    search_terms: r.search_terms?.length ? r.search_terms : [r.name],
    synonyms: r.synonyms,
    exclude_words: r.exclude_words,
    enabled: r.enabled,
    notify_existing: r.notify_existing,
    created_at: now,
    updated_at: now,
  };
  getDb().insert(R).values(row).run();
  return row;
}

export function updateRole(id, patch) {
  const current = getRole(id);
  if (!current) return null;
  const merged = RoleInputSchema.parse({ ...current, ...patch });
  const values = {
    name: merged.name,
    search_terms: merged.search_terms?.length ? merged.search_terms : [merged.name],
    synonyms: merged.synonyms,
    exclude_words: merged.exclude_words,
    enabled: merged.enabled,
    notify_existing: merged.notify_existing,
    updated_at: Date.now(),
  };
  getDb().update(R).set(values).where(eq(R.id, id)).run();
  return getRole(id);
}

export function deleteRole(id) {
  getDb().delete(R).where(eq(R.id, id)).run();
}
