import { describe, expect, it } from 'vitest';
import { checkBasicAuth, isLoopback } from '../src/server/app.js';

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('network password (HTTP Basic)', () => {
  it('accepts the right password with any username', () => {
    expect(checkBasicAuth(basic('me', 'secret-pw'), 'secret-pw')).toBe(true);
    expect(checkBasicAuth(basic('', 'secret-pw'), 'secret-pw')).toBe(true);
  });
  it('rejects a wrong or missing password', () => {
    expect(checkBasicAuth(basic('me', 'nope'), 'secret-pw')).toBe(false);
    expect(checkBasicAuth(undefined, 'secret-pw')).toBe(false);
    expect(checkBasicAuth('Bearer abc', 'secret-pw')).toBe(false);
  });
  it('treats only this computer as local', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.20')).toBe(false);
  });
});
