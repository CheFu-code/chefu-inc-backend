import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeviceAuthChallenge,
  hashDevicePollSecret,
  isTrustedDeviceInvalidatedByCredentialChange,
  isDeviceAuthExpired,
  matchesDevicePollSecret,
  normalizeDeviceCode,
  resolveDeviceAuthPollResult,
} from './device-auth';

void test('buildDeviceAuthChallenge creates a user code and device code', () => {
  const challenge = buildDeviceAuthChallenge();

  assert.equal(typeof challenge.deviceCode, 'string');
  assert.equal(typeof challenge.userCode, 'string');
  assert.ok(challenge.deviceCode.length >= 20);
  assert.ok(challenge.pollSecret.length >= 32);
  assert.ok(challenge.userCode.length >= 6);
  assert.equal(challenge.userCode.length, 14);
  assert.notEqual(challenge.pollSecret, challenge.deviceCode);
});

void test('normalizeDeviceCode strips the prefix, whitespace, and uppercase input', () => {
  assert.equal(normalizeDeviceCode(' chefu-abc123 '), 'abc123');
  assert.equal(normalizeDeviceCode('CHEFU-ABC123'), 'abc123');
});

void test('isDeviceAuthExpired returns true when a challenge has expired', () => {
  const expired = {
    createdAt: Date.now() - 1000 * 60 * 20,
    expiresAt: Date.now() - 1000 * 10,
  };

  assert.equal(isDeviceAuthExpired(expired), true);
});

void test('device poll secrets are verified by their stored digest', () => {
  const secret = 'a-secure-poll-secret-value-that-is-at-least-32-characters';
  const digest = hashDevicePollSecret(secret);

  assert.equal(matchesDevicePollSecret(secret, digest), true);
  assert.equal(matchesDevicePollSecret(`${secret}x`, digest), false);
  assert.equal(matchesDevicePollSecret(secret, 'invalid'), false);
});

void test('approved device credentials are exposed only while unclaimed', () => {
  assert.deepEqual(
    resolveDeviceAuthPollResult({
      status: 'approved',
      email: 'person@example.com',
      idToken: 'firebase-id-token',
    }),
    {
      kind: 'approved',
      status: 'approved',
      email: 'person@example.com',
      token: 'firebase-id-token',
    },
  );
  assert.deepEqual(
    resolveDeviceAuthPollResult({
      status: 'approved',
      email: 'person@example.com',
      idToken: 'firebase-id-token',
      credentialClaimedAt: new Date(),
    }),
    { kind: 'claimed', status: 'claimed' },
  );
  assert.deepEqual(
    resolveDeviceAuthPollResult({
      status: 'pending',
      email: 'person@example.com',
      idToken: 'not-exposed',
    }),
    { kind: 'waiting', status: 'pending' },
  );
});

void test('credential changes invalidate trusted devices created before token revocation', () => {
  assert.equal(isTrustedDeviceInvalidatedByCredentialChange(99, 100), true);
  assert.equal(isTrustedDeviceInvalidatedByCredentialChange(100, 100), false);
  assert.equal(isTrustedDeviceInvalidatedByCredentialChange(101, 100), false);
});
