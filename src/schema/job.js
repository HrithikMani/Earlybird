import { z } from 'zod';

const absoluteUrl = z
  .string()
  .min(1)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL');

/** A job as returned by the runner (after normalization). */
export const RunnerJobSchema = z.object({
  external_id: z.string().min(1).optional(),
  title: z.string().trim().min(1, 'title is empty'),
  url: absoluteUrl,
  location: z.string().optional(),
  department: z.string().optional(),
  posted_at: z.number().int().optional(), // epoch ms, parsed
  posted_at_raw: z.string().optional(),
  search_term: z.string().optional(),
});

/** What a script rule may return (looser; normalized afterwards). */
export const ScriptJobSchema = z.object({
  external_id: z.union([z.string(), z.number()]).optional(),
  title: z.string(),
  url: z.string(),
  location: z.string().nullish(),
  department: z.string().nullish(),
  posted_at: z.union([z.string(), z.number()]).nullish(),
  search_term: z.string().optional(),
});

export function jobJsonSchema() {
  return z.toJSONSchema(RunnerJobSchema, { io: 'input' });
}
