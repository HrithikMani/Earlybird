import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { authRequired, createSession, initAuth, isLockedOut, isLoopback, readCookie, recordFailure, verifyCredentials, verifySession } from '../src/server/auth.js';

beforeAll(() => {
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-auth-'));
  config.username = 'admin';
  config.password = 'Test-only-Pw-7731!';
  config.authLocal = false;
  initAuth();
});

describe('dashboard login', () => {
  it('accepts the right username and password only', () => {
    expect(verifyCredentials('admin', 'Test-only-Pw-7731!')).toBe(true);
    expect(verifyCredentials('admin', 'test-only-pw-7731!')).toBe(false);
    expect(verifyCredentials('root', 'Test-only-Pw-7731!')).toBe(false);
    expect(verifyCredentials(undefined, undefined)).toBe(false);
  });

  it('issues a session cookie that verifies, and rejects tampered ones', () => {
    const { value } = createSession('admin');
    expect(verifySession(value)).toBe('admin');
    const [u, exp, mac] = value.split('.');
    expect(verifySession(`${u}.${Number(exp) + 1}.${mac}`)).toBeNull();
    expect(verifySession(`${u}.${exp}.${mac.slice(0, -2)}xx`)).toBeNull();
    expect(verifySession('garbage')).toBeNull();
  });

  it('keeps the session secret in the data dir (sessions survive restarts)', () => {
    const { value } = createSession('admin');
    initAuth();
    expect(verifySession(value)).toBe('admin');
    expect(fs.existsSync(path.join(config.dataDir, '.session-secret'))).toBe(true);
  });

  it('requires login from other devices, not from this computer (unless forced)', () => {
    expect(authRequired('10.20.69.5')).toBe(true);
    expect(authRequired('127.0.0.1')).toBe(false);
    config.authLocal = true;
    expect(authRequired('127.0.0.1')).toBe(true);
    config.authLocal = false;
    expect(isLoopback('::1')).toBe(true);
  });

  it('locks an address out after 5 failed attempts', () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 4; i++) recordFailure(ip);
    expect(isLockedOut(ip)).toBe(false);
    recordFailure(ip);
    expect(isLockedOut(ip)).toBe(true);
  });

  it('reads cookies', () => {
    expect(readCookie('a=1; eb_session=abc%2Edef; b=2', 'eb_session')).toBe('abc.def');
    expect(readCookie('', 'eb_session')).toBeNull();
  });
});
