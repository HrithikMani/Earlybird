import { z } from 'zod';

export const CandidateSchema = z.object({
  strategy: z.enum(['url', 'playwright', 'script']),
  rule: z.record(z.string(), z.any()),
  code: z.string().optional(),
  notes: z.string().optional(),
});

export const DiscoveryResultSchema = z.object({
  candidates: z.array(CandidateSchema).min(1).max(3),
  evidence: z
    .object({
      ats_detected: z.string().optional(),
      source_request: z.string().optional(),
      site_supports_sort_newest: z.boolean().optional(),
      how_to_get_newest: z.string().optional(),
      visible_job_count: z.number().int().nonnegative().optional(),
      visible_role_job_count: z.number().int().nonnegative().optional(),
      newest_titles: z.array(z.string()).default([]),
      example_titles: z.array(z.string()).default([]),
      skipped: z.record(z.string(), z.string()).optional(),
      notes: z.string().optional(),
    })
    .default({ newest_titles: [], example_titles: [] }),
});

export const VerifyReportSchema = z.object({
  verdict: z.enum(['healthy', 'missing_recent', 'stale', 'broken', 'inconclusive']),
  window: z.string(),
  portal_recent_jobs: z.array(z.object({ title: z.string(), url: z.string().optional(), location: z.string().optional(), posted_label: z.string().optional() })).default([]),
  rule_recent_jobs: z.array(z.object({ title: z.string(), url: z.string().optional(), posted_at: z.union([z.string(), z.number()]).optional() })).default([]),
  missing: z.array(z.object({ title: z.string(), url: z.string().optional(), reason: z.string().optional() })).default([]),
  suggested_action: z.enum(['none', 'rerun_discovery', 'promote_fallback', 'edit_rule', 'check_manually']).default('none'),
  suggested_rule_change: z.string().optional(),
  notes: z.string().default(''),
});

export const SynonymsSchema = z.object({
  synonyms: z.array(z.string()).default([]),
  search_terms: z.array(z.string()).default([]),
  exclude_words: z.array(z.string()).default([]),
});

/** Pulls the last JSON object out of a model reply (handles ```json fences and prose around it). */
export function extractJson(text) {
  if (!text) throw new Error('empty response');
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of fenced.reverse()) {
    try {
      return JSON.parse(block);
    } catch {
      // try next
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('no JSON object found in the response');
}
