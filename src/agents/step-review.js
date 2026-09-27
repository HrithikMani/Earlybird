// Turns an agent task's raw events into a readable step-by-step log, flags steps the prompt should prevent,
// and suggests prompt changes. Used by the task page ("Step-by-step AI log") and GET /api/tasks/:id/review.

// Per-phase step budgets from prompts/discover-rule.md (explore ≤4, analyze ≤4 + reference ≤3, build/test ≤10).
const PHASE_BUDGET = { explore: 4, analyze: 7, build: 10, test: 10, commit: 3 };

const FLAG_INFO = {
  tool_failed: {
    label: 'Tool call failed',
    advice: 'Tell the agent how to call this tool correctly (e.g. pass a snapshot ref or a Playwright selector as the click target).',
  },
  repeated_failure: {
    label: 'Retried a failing action',
    advice: 'Add a rule: "If the same action fails twice, stop and try a different approach (e.g. a URL parameter)."',
  },
  description_target: {
    label: 'Click target was a description',
    advice: 'Say: "Pass the snapshot ref (e.g. e586) or a selector like text=Newest as target, never a description."',
  },
  ui_filter: {
    label: 'Set up UI filters (not needed)',
    advice: 'Say: "Do not set location/team filters in the UI; Earlybird filters locations and titles itself."',
  },
  private_api: {
    label: 'Dug into private API internals',
    advice: 'Say: "If the data comes from a private/authenticated API (GraphQL doc_id, CSRF tokens, cookies), use a Playwright rule; do not read its request bodies."',
  },
  reinspect: {
    label: 'Re-inspected the page',
    advice: 'Say: "Read one job card\'s outerHTML once, then write selectors; don\'t keep re-inspecting the page."',
  },
  big_read: {
    label: 'Very large page read',
    advice: 'Prefer browser_find / a narrow browser_evaluate over full snapshots and big network dumps.',
  },
  no_action: {
    label: 'Step without any action',
    advice: 'Usually fine (planning), but many in a row means the agent is unsure what to do next: make the procedure more explicit.',
  },
  phase_over_budget: {
    label: 'Phase over its step budget',
    advice: 'Tighten the instructions for this phase, or give the missing hint (e.g. the URL parameter) directly.',
  },
  pagination: {
    label: 'Built pagination / load-more',
    advice: 'Say: "One page of the newest ~10 jobs is enough; no pagination or load-more."',
  },
};

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

/** Plain-language one-liner for a tool call. */
function describeCall(tool, input = {}) {
  const i = typeof input === 'object' && input ? input : {};
  switch (tool) {
    case 'browser_navigate':
      return `Opened ${i.url}`;
    case 'browser_snapshot':
      return i.target ? `Took a snapshot of element ${i.target}` : 'Took a full page snapshot';
    case 'browser_network_requests':
      return `Listed network requests${i.filter ? ` matching "${i.filter}"` : ''}`;
    case 'browser_network_request':
      return `Read the ${i.part || 'body'} of network request #${i.index}`;
    case 'browser_click':
      return `Clicked "${i.target}"${i.element && i.element !== i.target ? ` (${i.element})` : ''}`;
    case 'browser_type':
      return `Typed "${i.text}" into ${i.target || i.element}`;
    case 'browser_select_option':
      return `Selected ${JSON.stringify(i.values || i.value)} in ${i.target || i.element}`;
    case 'browser_find':
      return `Searched the page for ${i.text ? `"${i.text}"` : i.regex}`;
    case 'browser_evaluate':
      return `Ran JavaScript in the page: ${clip(String(i.function || '').replace(/\s+/g, ' '), 140)}`;
    case 'browser_wait_for':
      return i.time ? `Waited ${i.time}s` : `Waited for ${i.text || i.textGone || 'the page'}`;
    case 'run_rule': {
      const r = i.rule || {};
      return i.rule_id ? `Tested stored rule ${i.rule_id}` : `Tested a ${r.type || '?'} rule${r.url ? ` on ${r.url}` : r.actions ? ` (${r.actions.map((a) => a.do).join(' → ')})` : ''}`;
    }
    case 'get_recent_jobs':
      return `Looked up jobs stored in the last ${i.window}`;
    default:
      return `${tool} ${clip(JSON.stringify(i), 120)}`;
  }
}

function summarizeOutput(tool, output) {
  if (output === undefined || output === null) return '';
  if (tool === 'run_rule' && typeof output === 'object') {
    if (output.ok === false) return `${output.error_type || 'error'}: ${output.message}`;
    return `${output.job_count} jobs${output.per_query ? ` (${Object.entries(output.per_query).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}${output.newest_jobs?.[0] ? `; newest: "${output.newest_jobs[0].title}"` : ''}`;
  }
  const text = typeof output === 'object' ? (output.content || []).map((c) => c.text || '').join(' ') || output.preview || JSON.stringify(output) : String(output);
  const t = text.replace(/### Ran Playwright code[\s\S]*?```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return clip(t, 220);
}

const outputSize = (o) => (o === undefined ? 0 : (typeof o === 'string' ? o : JSON.stringify(o)).length);

/**
 * Builds the step-by-step review from task events (ordered by seq).
 * Events belong to the step whose `step` event precedes them (works for old tasks too).
 */
export function buildStepReview(events) {
  const steps = [];
  const phases = [];
  let current = null;
  let phase = 'start';
  let prevTs = events[0]?.ts;
  const pending = []; // tool_calls waiting for their result
  let pendingPhase = null; // report_phase runs before its step event

  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'phase') {
      phase = d.phase;
      phases.push({ phase: d.phase, note: d.note, ts: e.ts });
      pendingPhase = d;
      continue;
    }
    if (e.type === 'step') {
      current = { n: d.step, phase: d.phase || phase, ts: e.ts, seconds: prevTs ? Math.round((e.ts - prevTs) / 100) / 10 : null, text: '', calls: [], input_tokens: d.input_tokens, output_tokens: d.output_tokens, cost_usd: d.step_cost_usd ?? null, flags: [] };
      if (pendingPhase) current.reported_phase = { phase: pendingPhase.phase, note: pendingPhase.note };
      pendingPhase = null;
      prevTs = e.ts;
      steps.push(current);
      pending.length = 0;
      continue;
    }
    if (!current) continue;
    if (e.type === 'model_text') current.text = d.text;
    else if (e.type === 'tool_call') {
      const call = { tool: d.tool, input: d.input, description: describeCall(d.tool, d.input), ok: true, result: '', output_chars: 0, repeat: d.repeat };
      current.calls.push(call);
      pending.push(call);
    } else if (e.type === 'tool_result') {
      const call = pending.find((c) => c.tool === d.tool && !c.done) || current.calls.find((c) => c.tool === d.tool && !c.done);
      if (!call) continue;
      call.done = true;
      call.ok = !d.error;
      call.error = d.error;
      call.result = d.error ? d.error : summarizeOutput(d.tool, d.output);
      call.output_chars = outputSize(d.output);
    }
  }

  // Flag steps the prompt should prevent.
  const evalSeen = new Map();
  let lastFailed = null;
  for (const s of steps) {
    const flag = (code, detail) => {
      if (!s.flags.some((f) => f.code === code)) s.flags.push({ code, label: FLAG_INFO[code].label, detail });
    };
    if (!s.calls.length && !s.reported_phase && s.text.trim() === '' && s !== steps[steps.length - 1]) flag('no_action');
    for (const c of s.calls) {
      const inp = typeof c.input === 'object' && c.input ? c.input : {};
      if (!c.ok) {
        flag('tool_failed', `${c.tool}: ${clip(c.error, 160)}`);
        const key = `${c.tool}`;
        if (lastFailed === key) flag('repeated_failure', `${c.tool} failed again`);
        lastFailed = key;
      } else lastFailed = null;
      if (c.tool === 'browser_click' && inp.target && !/^[ef]\d+$/.test(inp.target) && !/[=[\].#>:]/.test(inp.target)) flag('description_target', `target "${inp.target}"`);
      const haystack = `${inp.target || ''} ${inp.element || ''} ${inp.text || ''}`.toLowerCase();
      if (['browser_click', 'browser_type', 'browser_select_option'].includes(c.tool) && /(location|country|city|filter|team|department|apply)/.test(haystack) && !/sort|newest|recent|search/.test(haystack)) flag('ui_filter', c.description);
      if (c.tool === 'browser_network_request' && /request-body|request-headers/.test(inp.part || '')) flag('private_api', c.description);
      if (c.tool === 'browser_evaluate' && /graphql|lsd|doc_id|csrf/i.test(String(inp.function || ''))) flag('private_api', 'called a private API from the page');
      if (c.output_chars > 8000) flag('big_read', `${c.tool} returned ${c.output_chars.toLocaleString()} chars`);
      if (c.tool === 'run_rule' && (inp.rule?.pagination || (inp.rule?.actions || []).some((a) => a.repeat_until_gone))) flag('pagination', 'rule uses pagination / load-more');
      if (c.tool === 'browser_evaluate' || c.tool === 'browser_snapshot') {
        const key = c.tool === 'browser_snapshot' ? 'snapshot' : String(inp.function || '').replace(/\s+/g, ' ').slice(0, 60);
        const n = (evalSeen.get(key) || 0) + 1;
        evalSeen.set(key, n);
        if (n >= 3) flag('reinspect', `${c.tool === 'browser_snapshot' ? 'snapshot' : 'the same JavaScript'} ×${n}`);
      }
    }
  }

  // Phase budgets.
  const byPhase = {};
  for (const s of steps) {
    const p = (byPhase[s.phase] ??= { phase: s.phase, steps: 0, cost_usd: 0, seconds: 0, flagged: 0, budget: PHASE_BUDGET[s.phase] ?? null });
    p.steps++;
    p.cost_usd += s.cost_usd || 0;
    p.seconds += s.seconds || 0;
    if (s.flags.length) p.flagged++;
  }
  for (const p of Object.values(byPhase)) {
    p.cost_usd = Number(p.cost_usd.toFixed(4));
    p.seconds = Math.round(p.seconds);
    p.over_budget = p.budget !== null && p.steps > p.budget;
    if (p.over_budget) {
      const last = steps.filter((s) => s.phase === p.phase).at(-1);
      if (last && !last.flags.some((f) => f.code === 'phase_over_budget')) last.flags.push({ code: 'phase_over_budget', label: FLAG_INFO.phase_over_budget.label, detail: `${p.phase}: ${p.steps} steps (budget ${p.budget})` });
    }
  }

  // What to change in the prompt: one finding per flag type, with the steps it happened in.
  const findings = {};
  let wastedCost = 0;
  for (const s of steps) {
    if (s.flags.some((f) => f.code !== 'no_action')) wastedCost += s.cost_usd || 0;
    for (const f of s.flags) {
      const x = (findings[f.code] ??= { code: f.code, label: FLAG_INFO[f.code].label, advice: FLAG_INFO[f.code].advice, steps: [], examples: [] });
      x.steps.push(s.n);
      if (f.detail && x.examples.length < 3) x.examples.push(f.detail);
    }
  }
  const findingList = Object.values(findings).sort((a, b) => b.steps.length - a.steps.length);
  return {
    steps: steps.map(({ ts, ...s }) => ({ ...s, time: ts, calls: s.calls.map(({ done, ...c }) => c) })),
    phases: Object.values(byPhase),
    phase_notes: phases,
    findings: findingList,
    totals: {
      steps: steps.length,
      flagged_steps: steps.filter((s) => s.flags.some((f) => f.code !== 'no_action')).length,
      cost_usd: Number(steps.reduce((a, s) => a + (s.cost_usd || 0), 0).toFixed(4)),
      flagged_cost_usd: Number(wastedCost.toFixed(4)),
      seconds: steps.length ? Math.round((events.at(-1).ts - events[0].ts) / 1000) : 0,
    },
  };
}
