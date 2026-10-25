import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { AuthSessionRoutes } from './auth-session.routes';
import { TRUSTED_DEVICE_COOKIE_NAME } from './auth.controller.base';
import { SESSION_COOKIE_NAME } from './session.constants';

// Exercise the real session and device-trust methods, replacing only external
// Firebase/email dependencies. No emails or production requests are issued.
function setup() {
  const uid = 'alice';
  const token = 'a-test-browser-cookie-with-more-than-32-characters';
  const deviceKey = `auth_trusted_devices/${createHash('sha256').update(token).digest('hex')}`;
  const stateKey = `auth_trusted_device_state/${uid}`;
  const records = new Map<string, Record<string, any>>();
  let boundary = Math.floor(Date.now() / 1000) * 1000 - 100_000;
  let alerts = 0;
  let revocations = 0;
  let publications = 0;
  records.set(deviceKey, {
    uid, createdAt: Timestamp.fromMillis(boundary + 1000),
    expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000), revokedAt: null,
  });
  const snapshot = (key: string) => ({ exists: records.has(key), data: () => records.get(key), ref: { key } });
  const update = (key: string, data: Record<string, unknown>) => records.set(key, { ...records.get(key), ...data });
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => ({ key: `${collection}/${id}`, get: async () => snapshot(`${collection}/${id}`), set: async (data: Record<string, unknown>) => update(`${collection}/${id}`, data) }),
      where: (_field: string, _op: string, owner: string) => ({ get: async () => ({ docs: [...records].filter(([key, value]) => key.startsWith(`${collection}/`) && value.uid === owner).map(([key]) => snapshot(key)) }) }),
    }),
    runTransaction: async (fn: any) => fn({ get: async (ref: { key: string }) => snapshot(ref.key), update: (ref: { key: string }, data: Record<string, unknown>) => update(ref.key, data) }),
    batch: () => {
      const writes: (() => unknown)[] = [];
      return { update: (ref: { key: string }, data: Record<string, unknown>) => writes.push(() => update(ref.key, data)), commit: async () => writes.forEach((write) => write()) };
    },
  };
  const auth = {
    verifySessionCookie: async () => ({ uid, email: 'alice@example.test' }),
    verifyIdToken: async () => ({ uid, email: 'alice@example.test', email_verified: true, auth_time: Math.floor(Date.now() / 1000) }),
    createSessionCookie: async () => 'test-session',
    revokeRefreshTokens: async () => { revocations++; boundary += 10_000; },
    getUser: async () => ({ tokensValidAfterTime: new Date(boundary).toISOString() }),
  };
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  Object.assign(controller, {
    firebaseAdmin: { db: () => db, auth: () => auth, projectId: () => 'test-project' },
    securityEvents: { publishSubjectRevocation: async () => { publications++; } },
    sessionSigner: { sign: () => 'test-meta' },
    logger: { log() {}, warn() {}, error() {} },
    resolveSessionAppId: () => 'root',
    ensureUserProfile: async () => {},
    consumeSignupSignInAlertSuppression: async () => false,
    getUserProfile: async () => ({ roles: [], fullname: 'Alice', securityEmailsEnabled: true }),
    sendThrottledSignInNotification: async () => { alerts++; },
  });
  const request: any = { socket: { remoteAddress: "127.0.0.1" }, path: "/auth/session", method: "POST", cookies: { [TRUSTED_DEVICE_COOKIE_NAME]: token, [SESSION_COOKIE_NAME]: 'test-session' }, headers: { 'user-agent': 'Test Browser' } };
  const response: any = { cookie() {}, clearCookie() {} };
  const idToken = `header.${Buffer.from(JSON.stringify({ firebase: { sign_in_provider: 'password' } })).toString('base64url')}.signature`;
  const signIn = () => controller.createSession(`Bearer ${idToken}`, undefined, undefined, request, response);
  return { controller, request, response, records, deviceKey, stateKey, signIn, changeCredentials: () => { boundary += 20_000; }, counts: () => ({ alerts, revocations, publications }) };
}

test('trusted browser survives global logout; sessions still revoke and subsequent sign-in sends no alert', async () => {
  const state = setup();
  await state.controller.revokeCurrentSession(state.request);
  assert.deepEqual(state.counts(), { alerts: 0, revocations: 1, publications: 1 });
  assert.ok(state.records.get(state.stateKey)?.sessionOnlyValidAfterMs);
  assert.equal(state.records.get(state.deviceKey)?.revokedAt, null);
  const result = await state.signIn();
  assert.equal(result.ok, true);
  assert.equal(state.counts().alerts, 0);
});

test('unknown credential revocation after logout invalidates trust and sends a sign-in alert', async () => {
  const state = setup();
  await state.controller.revokeCurrentSession(state.request);
  state.changeCredentials();
  await state.signIn();
  assert.ok(state.records.get(state.deviceKey)?.revokedAt);
  assert.equal(state.counts().alerts, 1);
});

test('a password reset before global logout cannot be hidden by its session-only boundary', async () => {
  const state = setup();
  state.changeCredentials();
  await state.controller.revokeCurrentSession(state.request);
  assert.ok(state.records.get(state.deviceKey)?.revokedAt);
  await state.signIn();
  assert.equal(state.counts().alerts, 1);
});

test('explicit password changes still revoke trusted devices even at a known logout boundary', async () => {
  const state = setup();
  await state.controller.revokeCurrentSession(state.request);
  await state.controller.revokeCredentialSessions('alice', 'alice@example.test', 'password_changed');
  assert.ok(state.records.get(state.deviceKey)?.revokedAt);
  await state.signIn();
  assert.equal(state.counts().alerts, 1);
});

test('missing, expired, revoked and another account\'s device cookies never suppress alerts', async () => {
  for (const kind of ['missing', 'expired', 'revoked', 'wrong-user']) {
    const state = setup();
    if (kind === 'missing') delete state.request.cookies[TRUSTED_DEVICE_COOKIE_NAME];
    if (kind === 'expired') state.records.get(state.deviceKey)!.expiresAt = Timestamp.fromMillis(1);
    if (kind === 'revoked') state.records.get(state.deviceKey)!.revokedAt = Timestamp.now();
    if (kind === 'wrong-user') state.records.get(state.deviceKey)!.uid = 'bob';
    await state.signIn();
    assert.equal(state.counts().alerts, 1, kind);
  }
});
