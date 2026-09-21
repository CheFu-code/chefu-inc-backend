import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeviceAuthChallenge,
  isDeviceAuthExpired,
  normalizeDeviceCode,
} from './device-auth';

test('buildDeviceAuthChallenge creates a user code and device code', () => {
  const challenge = buildDeviceAuthChallenge();

  assert.equal(typeof challenge.deviceCode, 'string');
  assert.equal(typeof challenge.userCode, 'string');
  assert.ok(challenge.deviceCode.length >= 20);
  assert.ok(challenge.userCode.length >= 6);
  assert.equal(challenge.userCode.length, 8);
});

test('normalizeDeviceCode strips whitespace and uppercase input', () => {
  assert.equal(normalizeDeviceCode(' chefu-abc123 '), 'chefu-abc123');
  assert.equal(normalizeDeviceCode('CHEFU-ABC123'), 'chefu-abc123');
});

test('isDeviceAuthExpired returns true when a challenge has expired', () => {
  const expired = {
    createdAt: Date.now() - 1000 * 60 * 20,
    expiresAt: Date.now() - 1000 * 10,
  };

  assert.equal(isDeviceAuthExpired(expired), true);
});
