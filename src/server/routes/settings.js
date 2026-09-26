import { SECTION_NAMES } from '../../schema/settings.js';
import { publicSettings, updateSettings } from '../../settings/index.js';
import { formatZodError } from '../../schema/rule.js';

export default async function settingsRoutes(app) {
  app.get('/api/settings', async () => publicSettings());

  app.put('/api/settings/:section', async (req, reply) => {
    const { section } = req.params;
    if (!SECTION_NAMES.includes(section)) return reply.code(404).send({ error: `unknown section ${section}` });
    try {
      updateSettings(section, req.body ?? {});
      req.log.info({ scope: 'audit', section, keys: Object.keys(req.body ?? {}) }, 'settings updated');
      return publicSettings();
    } catch (e) {
      return reply.code(400).send({ error: 'validation_failed', message: formatZodError(e) });
    }
  });
}
