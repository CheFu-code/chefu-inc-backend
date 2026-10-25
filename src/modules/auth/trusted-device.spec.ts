import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { AuthSessionRoutes } from './auth-session.routes';
import { TRUSTED_DEVICE_COOKIE_NAME } from './auth.controller.base';
import { SESSION_COOKIE_NAME } from './session.constants';
import { trustedBrowserStatus } from './trusted-browser-status';
import { TrustedBrowserLimits } from './trusted-browser-limits';
import { RateLimitMiddleware } from '../../common/rate-limit.middleware';

// Exercise the real session and device-trust methods, replacing only external
// Firebase/email dependencies. No emails or production requests are issued.
function setup() {
  const uid = 'alice';
  const token = `test-browser-cookie-${randomUUID()}`;
  const deviceKey = `auth_trusted_devices/${createHash('sha256').update(token).digest('hex')}`;
  const stateKey = `auth_trusted_device_state/${uid}`;
  const records = new Map<string, Record<string, any>>();
  let boundary = Math.floor(Date.now() / 1000) * 1000 - 100_000;
  let alerts = 0;
  let revocations = 0;
  let publications = 0;
  let documentLookups = 0;
  let authLookups = 0;
  records.set(deviceKey, {
    uid, createdAt: Timestamp.fromMillis(boundary + 1000),
    expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000), revokedAt: null,
  });
  const snapshot = (key: string) => ({ exists: records.has(key), data: () => records.get(key), ref: { key } });
  const update = (key: string, data: Record<string, unknown>) => records.set(key, { ...records.get(key), ...data });
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => ({ key: `${collection}/${id}`, get: async () => { documentLookups++; return snapshot(`${collection}/${id}`); }, set: async (data: Record<string, unknown>) => update(`${collection}/${id}`, data) }),
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
    getUser: async () => { authLookups++; return { email: "alice@example.test", emailVerified: true, disabled: false, tokensValidAfterTime: new Date(boundary).toISOString() }; },
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
  return { controller, request, response, records, deviceKey, stateKey, signIn, lookups: () => ({ documents: documentLookups, auth: authLookups }), changeCredentials: () => { boundary += 20_000; }, counts: () => ({ alerts, revocations, publications }) };
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


test('pre-sign-in trust status is read-only, account-aware and returns no account details', async () => {
  const state = setup();
  const before = JSON.stringify([...state.records]);
  const check = (email?: unknown) => trustedBrowserStatus(state.controller.firebaseAdmin, state.request, TRUSTED_DEVICE_COOKIE_NAME, email);
  assert.deepEqual(await check(), { trusted: true });
  assert.deepEqual(await check(' Alice@Example.Test '), { trusted: true });
  assert.deepEqual(await check('bob@example.test'), { trusted: false });
  assert.deepEqual(await check('invalid-email'), { trusted: false });
  assert.deepEqual(await check({ email: 'alice@example.test' }), { trusted: false });
  assert.equal(JSON.stringify([...state.records]), before, 'status must not renew trust, touch lastSeenAt or create records');
});

test('trust status recognizes a known logout but rejects a later password reset', async () => {
  const state = setup();
  await state.controller.revokeCurrentSession(state.request);
  const check = () => trustedBrowserStatus(state.controller.firebaseAdmin, state.request, TRUSTED_DEVICE_COOKIE_NAME, 'alice@example.test');
  assert.deepEqual(await check(), { trusted: true });
  state.changeCredentials();
  // A fresh reader sees the reset. A prior UI hint may be cached for 30s;
  // actual sign-in always performs its own fresh trust enforcement.
  assert.deepEqual(await trustedBrowserStatus({ ...state.controller.firebaseAdmin }, state.request, TRUSTED_DEVICE_COOKIE_NAME, 'alice@example.test'), { trusted: false });
  assert.equal(state.records.get(state.deviceKey)?.revokedAt, null, 'the UI check is read-only; actual sign-in enforces revocation');
});

test('trust status rejects missing, malformed, expired and revoked cookies and disabled accounts', async () => {
  for (const kind of ['missing', 'malformed', 'expired', 'revoked', 'disabled', 'unverified']) {
    const state = setup();
    if (kind === 'missing') delete state.request.cookies[TRUSTED_DEVICE_COOKIE_NAME];
    if (kind === 'malformed') state.request.cookies[TRUSTED_DEVICE_COOKIE_NAME] = 'x'.repeat(1000);
    if (kind === 'expired') state.records.get(state.deviceKey)!.expiresAt = Timestamp.fromMillis(1);
    if (kind === 'revoked') state.records.get(state.deviceKey)!.revokedAt = Timestamp.now();
    if (kind === 'disabled' || kind === 'unverified') {
      const auth = state.controller.firebaseAdmin.auth();
      const original = auth.getUser;
      auth.getUser = async () => ({ ...await original(), disabled: kind === 'disabled', emailVerified: kind !== 'unverified' });
    }
    assert.deepEqual(await trustedBrowserStatus(state.controller.firebaseAdmin, state.request, TRUSTED_DEVICE_COOKIE_NAME), { trusted: false }, kind);
  }
});


test('changing emails reuses one coalesced browser lookup; cookie throttling rejects further requests before database access', async () => {
  const state = setup();
  const emails = ['alice@example.test', ...Array.from({ length: 11 }, (_, index) => `other-${index}@example.test`)];
  const values = await Promise.all(emails.map(email => trustedBrowserStatus(state.controller.firebaseAdmin, state.request, TRUSTED_DEVICE_COOKIE_NAME, email)));
  assert.equal(values[0].trusted, true);
  assert.ok(values.slice(1).every(result => !result.trusted));
  assert.deepEqual(state.lookups(), { documents: 1, auth: 1 }, '12 requests perform one Firestore lookup and one Auth lookup in this adapter');
  await assert.rejects(trustedBrowserStatus(state.controller.firebaseAdmin, state.request, TRUSTED_DEVICE_COOKIE_NAME, 'another@example.test'), (error: any) => error.getStatus() === 429);
  assert.deepEqual(state.lookups(), { documents: 1, auth: 1 });
});

test('the cold lookup budget cannot be evicted by rotating identifiers, and resets after its window', () => {
  let now = 1000;
  const limits = new TrustedBrowserLimits(() => now);
  limits.reserve('database', 1);
  for (let index = 0; index < 6000; index++) limits.reserve(`ip:${index}`, 1);
  assert.throws(() => limits.reserve('database', 1), (error: any) => error.getStatus() === 429);
  now += 60_001;
  assert.doesNotThrow(() => limits.reserve('database', 1));
});

test('status IP throttling uses no Firestore-backed rate counters and cannot be bypassed with path casing', async () => {
  let nextCalls = 0;
  let status = 200;
  const headers: Record<string, string> = {};
  const middleware = new RateLimitMiddleware({ reserve: async () => { throw new Error('Status checks must not write rate counters'); } } as any);
  const response = { setHeader: (name: string, value: string) => { headers[name] = value; }, status: (code: number) => { status = code; return response; }, json: () => {} } as any;
  for (let index = 0; index < 61; index++) {
    const request = { method: 'POST', path: '/', originalUrl: index % 2 ? '/AUTH/TRUSTED-DEVICES/STATUS/?ignored=1' : '/auth/trusted-devices/status', ip: '198.51.100.219', socket: {}, headers: {} } as any;
    await middleware.use(request, response, () => { nextCalls++; });
  }
  assert.equal(nextCalls, 60);
  assert.equal(status, 429);
  assert.ok(Number(headers['Retry-After']) > 0);
});
