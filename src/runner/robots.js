// Minimal robots.txt support: honours "User-agent: *" (and "earlybird") Allow/Disallow groups. Cached per origin for 1h.
const cache = new Map();
const TTL = 3600 * 1000;

function parse(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

function matches(pattern, path) {
  if (!pattern) return false;
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(path);
}

export async function isAllowedByRobots(url, { userAgent = '', signal } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  let entry = cache.get(u.origin);
  if (!entry || Date.now() - entry.at > TTL) {
    let groups = [];
    try {
      const res = await fetch(`${u.origin}/robots.txt`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), headers: { 'user-agent': userAgent } });
      if (res.ok) groups = parse(await res.text());
    } catch {
      // unreachable robots.txt -> allowed
    }
    entry = { at: Date.now(), groups };
    cache.set(u.origin, entry);
  }
  const ua = userAgent.toLowerCase();
  const group = entry.groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a))) || entry.groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  const path = u.pathname + u.search;
  let best = null;
  for (const r of group.rules) {
    if (r.path === '' && !r.allow) continue; // "Disallow:" (empty) allows everything
    if (matches(r.path, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

export function clearRobotsCache() {
  cache.clear();
}
