import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export class PromptMissing extends Error {
  constructor(file) {
    super(`Prompt file ${path.relative(config.paths.prompts + '/..', file)} is missing. Add it (see CLAUDE.md "Prompts") and retry the task.`);
    this.type = 'PromptMissing';
  }
}

/**
 * Loads prompts/<name>.md fresh (edits apply without restart) and fills {{placeholders}}.
 * Returns { text, file, hash }.
 */
export function loadPrompt(name, vars = {}) {
  const file = path.join(config.paths.prompts, `${name}.md`);
  let template;
  if (fs.existsSync(file)) template = fs.readFileSync(file, 'utf8');
  else if (config.isTest) template = `(test stub for ${name})\n{{company_name}} {{careers_url}}`;
  else throw new PromptMissing(file);
  const text = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] === undefined ? m : typeof vars[k] === 'string' ? vars[k] : JSON.stringify(vars[k], null, 2)));
  return { text, file: `prompts/${name}.md`, hash: crypto.createHash('sha256').update(template).digest('hex').slice(0, 12) };
}
