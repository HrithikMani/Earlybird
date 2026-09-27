import { createRole, deleteRole, getRole, listRoles, updateRole } from '../../roles/store.js';
import { formatZodError } from '../../schema/rule.js';
import { getSqlite } from '../../db/index.js';
import { matchRoles } from '../../roles/match.js';

export default async function roleRoutes(app) {
  app.get('/api/roles', async (req) => {
    const roles = listRoles({ scope: req.query.scope, company_id: req.query.company_id });
    // Open jobs matching each role (across companies) for the Roles page.
    const jobs = getSqlite().prepare('select title from jobs where closed_at is null').all();
    return { items: roles.map((r) => ({ ...r, open_jobs: jobs.filter((j) => matchRoles(j.title, [r]).length).length })) };
  });

  app.post('/api/roles', async (req, reply) => {
    try {
      const role = createRole(req.body || {});
      req.log.info({ scope: 'audit', role: role.name, role_scope: role.scope, company_id: role.company_id }, 'role added');
      return { role };
    } catch (e) {
      return reply.code(400).send({ error: 'validation_failed', message: formatZodError(e) });
    }
  });

  app.put('/api/roles/:id', async (req, reply) => {
    try {
      const role = updateRole(req.params.id, req.body || {});
      if (!role) return reply.code(404).send({ error: 'not_found' });
      req.log.info({ scope: 'audit', role: role.name }, 'role updated');
      return { role };
    } catch (e) {
      return reply.code(400).send({ error: 'validation_failed', message: formatZodError(e) });
    }
  });

  app.delete('/api/roles/:id', async (req) => {
    const role = getRole(req.params.id);
    deleteRole(req.params.id);
    req.log.info({ scope: 'audit', role: role?.name }, 'role deleted');
    return { ok: true };
  });
}
