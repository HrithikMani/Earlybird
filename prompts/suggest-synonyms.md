# Suggest synonyms for the role "{{role_name}}"

Earlybird sends a job to Discord when its title matches a role. A title matches when every word of the role name, a search term, or a synonym appears in it (in any order, whole words, case-insensitive), unless it contains an exclude word.

- Current synonyms: {{current_synonyms}}
- Current search terms: {{current_search_terms}}

Suggest:
- **synonyms**: other job titles people use for the same work (5-12, most common first). Keep them specific: for "DevOps Engineer" suggest "Site Reliability Engineer" or "SRE", not just "Engineer".
- **search_terms**: 1-3 short queries that portals' search boxes handle well.
- **exclude_words**: words that usually mean a different job (e.g. "Manager", "Sales" for engineering roles). Leave it empty if none are clearly needed.

Reply with only this JSON object:

```json
{ "synonyms": [], "search_terms": [], "exclude_words": [] }
```
