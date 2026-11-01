import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthControllerBase, TRUSTED_DEVICE_COOKIE_NAME } from './auth.controller.base';

function fixture(lastSeenAtMs: number, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const writes: unknown[] = [];
  const doc = {
    uid: 'uid-1',
    revokedAt: null,
    expiresAt: now + 3_600_000,
    lastSeenAtMs,
    ...overrides,
  };
  const db = {
    collection: () => ({ doc: () => ({}) }),
    runTransaction: async (callback: (tx: {
      get: () => Promise<{ exists: boolean; data: () => typeof doc }>;
      update: (_ref: unknown, data: unknown) => void;
    }) => Promise<boolean>) => callback({
      get: async () => ({ exists: true, data: () => doc }),
      update: (_ref, data) => { writes.push(data); },
    }),
  };
  const controller = Object.create(AuthControllerBase.prototype) as any;
  Object.assign(controller, {
    firebaseAdmin: { db: () => db },
    revokeTrustedDevicesInvalidatedByCredentialChange: async () => {},
    timestampToMillis: (value: number) => value,
  });
  const request = { cookies: { [TRUSTED_DEVICE_COOKIE_NAME]: 'a'.repeat(48) } };
  return { controller, request, writes };
}

test('known recent device remains trusted without a Firestore update', async () => {
  const { controller, request, writes } = fixture(Date.now() - 60_000);
  assert.equal(await controller.isTrustedAuthDevice('uid-1', request), true);
  assert.equal(writes.length, 0);
});

test('known stale device retains accurate last-seen data with one update', async () => {
  const { controller, request, writes } = fixture(Date.now() - 16 * 60_000);
  assert.equal(await controller.isTrustedAuthDevice('uid-1', request), true);
  assert.equal(writes.length, 1);
});

test('revoked, expired, or wrong-account devices never become trusted', async () => {
  for (const overrides of [
    { revokedAt: Date.now() - 1 },
    { expiresAt: Date.now() - 1 },
    { uid: 'someone-else' },
  ]) {
    const { controller, request, writes } = fixture(Date.now(), overrides);
    assert.equal(await controller.isTrustedAuthDevice('uid-1', request), false);
    assert.equal(writes.length, 0);
  }
});
