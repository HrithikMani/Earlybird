// Masks secrets anywhere they appear in a string (log lines, error messages, payloads).
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, (m) => `sk-ant-…${m.slice(-4)}`],
  [/(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)([\w-]+)/g, (_m, base, token) => `${base}…${token.slice(-4)}`],
  [/("?(?:x-api-key|authorization)"?\s*[:=]\s*"?)([^",\s]+)/gi, (_m, key, val) => `${key}…${val.slice(-4)}`],
];

export function redactString(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, fn] of PATTERNS) out = out.replace(re, fn);
  return out;
}

/** Mask a secret for display: keep the last 4 characters. */
export function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

export function isMasked(value) {
  return typeof value === 'string' && value.startsWith('••••');
}
