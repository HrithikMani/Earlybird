import { z } from 'zod';

/** Field mapping: dot-paths (api) or CSS selectors (html/browser). "sel@attr" reads an attribute. */
export const FieldsSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  url: z.string().min(1),
  location: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  posted_at: z.string().min(1).optional(),
});

export const PaginationSchema = z.object({
  kind: z.enum(['offset', 'page', 'cursor']),
  param: z.string().min(1),
  in: z.enum(['query', 'body']).default('query'),
  page_size: z.number().int().positive().default(20),
  size_param: z.string().optional(),
  start: z.number().int().optional(),
  cursor_path: z.string().optional(),
  max_pages: z.number().int().positive().max(200).default(20),
});

export const SearchSchema = z.object({
  mode: z.enum(['per_term', 'combined', 'none']).default('none'),
  combine_with: z.string().default(' OR '),
  term_source: z.literal('roles').default('roles'),
});

const Common = {
  search: SearchSchema.default({ mode: 'none', combine_with: ' OR ', term_source: 'roles' }),
  sorted_newest_first: z.boolean().default(false),
  fast_max_pages: z.number().int().positive().default(1),
  expected_min_jobs: z.number().int().nonnegative().default(1),
  interval_min: z.number().int().positive().optional(),
  id_from_url: z.string().optional(),
  posted_at_format: z.enum(['relative', 'iso', 'custom', 'auto']).default('auto'),
  posted_at_pattern: z.string().optional(),
  url_prefix: z.string().url().optional(),
};

const HttpCommon = {
  url: z.string().url(),
  method: z.enum(['GET', 'POST']).default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.any().optional(),
  pagination: PaginationSchema.optional(),
};

export const ApiRuleSchema = z.object({
  type: z.literal('api'),
  strategy: z.literal('url').default('url'),
  ...HttpCommon,
  jobs_path: z.string().default(''),
  fields: FieldsSchema,
  ...Common,
});

export const HtmlRuleSchema = z.object({
  type: z.literal('html'),
  strategy: z.literal('url').default('url'),
  ...HttpCommon,
  item_selector: z.string().min(1),
  fields: FieldsSchema,
  ...Common,
});

export const BROWSER_ACTIONS = ['goto', 'wait', 'click', 'fill', 'select', 'scroll', 'extract'];

export const ActionSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('goto'), url: z.string().min(1) }),
  z.object({
    do: z.literal('wait'),
    selector: z.string().min(1).optional(),
    state: z.enum(['attached', 'visible']).default('visible'),
    ms: z.number().int().positive().max(30000).optional(),
    optional: z.boolean().default(false),
  }),
  z.object({
    do: z.literal('click'),
    selector: z.string().min(1),
    repeat_until_gone: z.boolean().default(false),
    max_repeats: z.number().int().positive().max(200).default(20),
    optional: z.boolean().default(false),
    wait_after_ms: z.number().int().nonnegative().max(10000).default(500),
  }),
  z.object({
    do: z.literal('fill'),
    selector: z.string().min(1),
    value: z.string(),
    press_enter: z.boolean().default(false),
    wait_after_ms: z.number().int().nonnegative().max(10000).default(800),
  }),
  z.object({ do: z.literal('select'), selector: z.string().min(1), value: z.string(), wait_after_ms: z.number().int().nonnegative().max(10000).default(800) }),
  z.object({
    do: z.literal('scroll'),
    until_no_change: z.boolean().default(true),
    max_scrolls: z.number().int().positive().max(200).default(20),
    wait_after_ms: z.number().int().nonnegative().max(10000).default(600),
  }),
  z.object({ do: z.literal('extract') }),
]);

export const BrowserRuleSchema = z.object({
  type: z.literal('browser'),
  strategy: z.literal('playwright').default('playwright'),
  actions: z.array(ActionSchema).min(2),
  // Optional URL pagination: the page/offset param is applied to the first goto URL and the actions repeat per page.
  pagination: PaginationSchema.optional(),
  item_selector: z.string().min(1),
  fields: FieldsSchema,
  ...Common,
});

export const ScriptRuleSchema = z.object({
  type: z.literal('script'),
  strategy: z.literal('script').default('script'),
  uses_browser: z.boolean().default(false),
  entry: z.string().optional(),
  ...Common,
});

export const RuleSchema = z.discriminatedUnion('type', [ApiRuleSchema, HtmlRuleSchema, BrowserRuleSchema, ScriptRuleSchema]);

/** Parses and normalizes a rule. Throws a ZodError with readable issues. */
export function parseRule(input) {
  const rule = RuleSchema.parse(input);
  if (rule.type === 'browser' && !rule.actions.some((a) => a.do === 'extract')) {
    throw new z.ZodError([{ code: 'custom', path: ['actions'], message: 'browser rules need an "extract" action', input }]);
  }
  if (rule.id_from_url) {
    try {
      new RegExp(rule.id_from_url);
    } catch (e) {
      throw new z.ZodError([{ code: 'custom', path: ['id_from_url'], message: `invalid regex: ${e.message}`, input }]);
    }
  }
  return rule;
}

export function safeParseRule(input) {
  try {
    return { success: true, data: parseRule(input) };
  } catch (error) {
    return { success: false, error };
  }
}

export function formatZodError(err) {
  if (!err?.issues) return String(err?.message ?? err);
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function ruleJsonSchema() {
  return z.toJSONSchema(RuleSchema, { io: 'input', unrepresentable: 'any' });
}
