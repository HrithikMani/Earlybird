const UNIT_MS = {
  second: 1000, sec: 1000, s: 1000,
  minute: 60000, min: 60000, m: 60000,
  hour: 3600000, hr: 3600000, h: 3600000,
  day: 86400000, d: 86400000,
  week: 604800000, wk: 604800000, w: 604800000,
  month: 2592000000, mo: 2592000000,
  year: 31536000000, yr: 31536000000, y: 31536000000,
};

/** Parses "3 hours ago", "Posted 2 Days Ago", "30+ days ago", "yesterday", "today", "just now". */
export function parseRelative(text, now = Date.now()) {
  const s = String(text).toLowerCase();
  if (/just now|moments? ago|few (seconds|minutes) ago/.test(s)) return now;
  if (/\btoday\b/.test(s)) return now;
  if (/\byesterday\b/.test(s)) return now - 86400000;
  const m = s.match(/(\d+)\+?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|[smhdwy])\b\s*(ago)?/);
  if (!m) {
    const a = s.match(/\b(an?|one)\s+(second|minute|hour|day|week|month|year)\s+ago/);
    if (a) return now - UNIT_MS[a[2]];
    return undefined;
  }
  const n = Number(m[1]);
  const unit = m[2].replace(/s$/, '');
  const ms = UNIT_MS[unit] ?? UNIT_MS[m[2]];
  return ms ? now - n * ms : undefined;
}

/**
 * Parses a posted date value into epoch ms. Accepts numbers (sec or ms), ISO strings, "Sep 20, 2026",
 * and relative labels. Returns undefined when unparseable.
 */
export function parsePostedAt(value, format = 'auto', now = Date.now()) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  const s = String(value).trim();
  if (/^\d{9,13}$/.test(s)) return parsePostedAt(Number(s), format, now);
  if (format === 'relative') return parseRelative(s, now);
  const cleaned = s.replace(/^(posted|published|updated|date posted|listed)\s*(on|:)?\s*/i, '');
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t) && /\d{4}|\d{1,2}[/-]\d{1,2}/.test(cleaned)) {
    // Guard against obviously wrong years (e.g. "2 days" parsed oddly).
    const year = new Date(t).getUTCFullYear();
    if (year > 1995 && year < 2100) return t;
  }
  return parseRelative(s, now);
}
