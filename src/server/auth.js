// Login for the dashboard: username + password (from .env), signed session cookie, failed-attempt limiting.
// Enabled when EARLYBIRD_PASSWORD is set. Requests from this computer skip it unless EARLYBIRD_AUTH_LOCAL=1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const SESSION_COOKIE = 'eb_session';
const SESSION_DAYS = 7;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60_000;

let state = null;

/** Loads (or creates) the per-install session secret in the data dir; hashes the configured password. */
export function initAuth() {
  const enabled = !!config.password;
  let secret = '';
  if (enabled) {
    const file = path.join(config.dataDir, '.session-secret');
    try {
      secret = fs.readFileSync(file, 'utf8').trim();
    } catch {
      secret = '';
    }
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  const salt = crypto.randomBytes(16);
  state = {
    enabled,
    username: config.username,
    salt,
    // The plain password is only kept long enough to hash it.
    hash: enabled ? crypto.scryptSync(config.password, salt, 64) : null,
    // Sessions are bound to the credentials: changing the password in .env logs everyone out.
    secret: enabled ? crypto.createHash('sha256').update(`${secret}|${config.username}|${config.password}`).digest() : null,
    fails: new Map(),
  };
  return state;
}

export function authState() {
  return state ?? initAuth();
}

export function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Whether this request must be logged in. */
export function authRequired(remoteAddress) {
  const s = authState();
  if (!s.enabled) return false;
  return config.authLocal || !isLoopback(remoteAddress);
}

export function verifyCredentials(username, password) {
  const s = authState();
  if (!s.enabled || typeof username !== 'string' || typeof password !== 'string') return false;
  const userOk = crypto.timingSafeEqual(crypto.createHash('sha256').update(username).digest(), crypto.createHash('sha256').update(s.username).digest());
  const passOk = crypto.timingSafeEqual(crypto.scryptSync(password, s.salt, 64), s.hash);
  return userOk && passOk;
}

const sign = (payload) => crypto.createHmac('sha256', authState().secret).update(payload).digest('base64url');

/** Cookie value: "<user>.<expiresMs>.<hmac>". */
export function createSession(username) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${Buffer.from(username).toString('base64url')}.${exp}`;
  return { value: `${payload}.${sign(payload)}`, maxAge: SESSION_DAYS * 86400 };
}

/** Returns the username for a valid, unexpired session cookie, else null. */
export function verifySession(value) {
  if (!value || !authState().enabled) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [user, exp, mac] = parts;
  const expected = sign(`${user}.${exp}`);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  return Buffer.from(user, 'base64url').toString();
}

export function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(value, maxAge, secure) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Failed-login limiting per IP: true when this IP must wait. */
export function isLockedOut(ip) {
  const f = authState().fails.get(ip);
  return !!f && f.count >= MAX_FAILS && Date.now() - f.first < FAIL_WINDOW_MS;
}

export function recordFailure(ip) {
  const fails = authState().fails;
  const f = fails.get(ip);
  if (!f || Date.now() - f.first >= FAIL_WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

export function clearFailures(ip) {
  authState().fails.delete(ip);
}
