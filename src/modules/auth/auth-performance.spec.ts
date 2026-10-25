import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { AuthSessionRoutes } from './auth-session.routes';
import { OAuthService } from './oauth.service';
import { AuthOnboardingRoutes } from './auth-onboarding.routes';
import { AuthControllerBase } from './auth.controller.base';
import { ResendService } from '../email/resend.service';
import { afterSuccessfulAuthResponse, authStage } from './auth-performance';

const logger = { log() {}, warn() {}, error() {} };
const request: any = { ip: '127.0.0.1', headers: {}, cookies: {}, socket: {} };

test('session reuse validates the real cookie with revocation checks and never loads ordinary profiles', async () => {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  const calls: unknown[][] = [];
  let decoded: any = { uid: 'uid', email: 'alice@example.test', email_verified: true };
  Object.assign(controller, {
    firebaseAdmin: { auth: () => ({ verifySessionCookie: async (...args: unknown[]) => {
      calls.push(args);
      if (decoded instanceof Error) throw decoded;
      return decoded;
    } }) },
    resolveSessionAppId: () => 'root',
    getUserProfile: () => assert.fail('ordinary reuse must not load or synchronize profiles'),
  });
  const res = response();
  const check = (cookie?: string) => controller.getSessionStatus('root', { cookies: { __session: cookie } }, res);
  assert.deepEqual(await check(), { authenticated: false });
  assert.equal(calls.length, 0);
  assert.deepEqual(await check('signed-cookie'), { authenticated: true });
  assert.deepEqual(calls, [['signed-cookie', true]]);
  assert.equal(res.getHeader('Cache-Control'), 'private, no-store');
  assert.equal(res.cookies.length, 0, 'reuse never renews cookies');
  for (const invalid of [new Error('revoked'), new Error('expired'), { ...decoded, email_verified: false }, { uid: 'uid', email_verified: true }]) {
    decoded = invalid;
    assert.deepEqual(await check('invalid-cookie'), { authenticated: false });
  }
});

test('session reuse checks current admin roles and Flow access without trusting session metadata', async () => {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  let roles = ['user'];
  let flowAllowed = false;
  Object.assign(controller, {
    firebaseAdmin: { auth: () => ({ verifySessionCookie: async () => ({ uid: 'uid', email: 'alice@example.test', email_verified: true }) }) },
    resolveSessionAppId: (app: string) => app,
    getUserProfile: async () => ({ roles }),
    isFlowSessionAllowed: async () => flowAllowed,
  });
  const req = { cookies: { __session: 'cookie', __session_meta: 'forged-admin' } };
  assert.deepEqual(await controller.getSessionStatus('admin', req, response()), { authenticated: false });
  roles = ['admin'];
  assert.deepEqual(await controller.getSessionStatus('admin', req, response()), { authenticated: true });
  assert.deepEqual(await controller.getSessionStatus('flow', req, response()), { authenticated: false });
  flowAllowed = true;
  assert.deepEqual(await controller.getSessionStatus('flow', req, response()), { authenticated: true });
});

test('OAuth independently revalidates reused cookies and only issues codes for registered PKCE requests', async () => {
  const service: any = Object.create(OAuthService.prototype);
  const codes: any[] = [];
  let revoked = false;
  const client = { id: 'liftwise-mobile', appId: 'liftwise', scopes: ['openid', 'profile'], redirectUris: ['liftwise://sso-callback'] };
  Object.assign(service, {
    logger, issuer: 'https://api.chefu.co.za', accountUrl: 'https://myaccount.chefu.co.za', authorizationCodeTtlMs: 60_000,
    appsService: { resolveOauthClient: (id: string) => id === client.id ? client : null },
    firebaseAdmin: {
      auth: () => ({ verifySessionCookie: async (cookie: string, checkRevoked: boolean) => {
        assert.equal(cookie, 'real-session'); assert.equal(checkRevoked, true);
        if (revoked) throw new Error('revoked');
        return { uid: 'uid', email: 'alice@example.test', auth_time: 123 };
      } }),
      db: () => ({ collection: () => ({ doc: () => ({ set: async (data: unknown) => { codes.push(data); } }) }) }),
    },
  });
  const params = { client_id: client.id, redirect_uri: client.redirectUris[0], response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', scope: 'openid profile', state: 'state-that-is-long-enough', nonce: 'nonce-that-is-long-enough' };
  const req = { ...request, cookies: { __session: 'real-session' } };
  const destination = new URL((await service.authorize(params, req)).redirectTo);
  assert.equal(destination.searchParams.get('state'), params.state);
  assert.ok(destination.searchParams.get('code'));
  assert.equal(codes[0].codeChallenge, params.code_challenge);
  assert.equal(codes[0].uid, 'uid');
  await assert.rejects(service.authorize({ ...params, redirect_uri: 'https://evil.example' }, req));
  await assert.rejects(service.authorize({ ...params, code_challenge_method: 'plain' }, req));
  revoked = true;
  const expired = new URL((await service.authorize(params, req)).redirectTo);
  assert.equal(expired.origin, 'https://myaccount.chefu.co.za');
  assert.equal(expired.pathname, '/login');
  assert.equal(codes.length, 1, 'invalid requests and revoked sessions issue no codes');
});
function response() {
  const headers = new Map<string, unknown>();
  const cookies: unknown[] = [];
  return Object.assign(new EventEmitter(), {
    statusCode: 200, destroyed: false, headersSent: false, cookies,
    setHeader: (name: string, value: unknown) => headers.set(name, value),
    getHeader: (name: string) => headers.get(name),
    cookie: (...args: unknown[]) => cookies.push(args), clearCookie() {},
  }) as any;
}

test('browser password sessions skip custom tokens; legacy login retains its response and rate limit', async t => {
  const originalKey = process.env.FIREBASE_WEB_API_KEY;
  process.env.FIREBASE_WEB_API_KEY = 'test-key';
  t.after(() => {
    if (originalKey === undefined) delete process.env.FIREBASE_WEB_API_KEY;
    else process.env.FIREBASE_WEB_API_KEY = originalKey;
  });
  let customTokens = 0;
  let rateLimits = 0;
  let sessions = 0;
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  Object.assign(controller, {
    logger,
    enforceAuthRateLimit: async () => { rateLimits++; },
    inspectPasswordForBreach: async () => {},
    firebaseAdmin: { auth: () => ({ createCustomToken: async () => { customTokens++; return 'custom'; } }) },
    createSession: async (...args: any[]) => { sessions++; assert.equal(args[0], 'Bearer id'); return { ok: true }; },
  });
  let upstream: any = { idToken: 'id', localId: 'uid', refreshToken: 'refresh', expiresIn: '3600' };
  let ok = true;
  t.mock.method(globalThis, 'fetch', async () => ({ ok, json: async () => upstream }));
  const credentials = { email: 'alice@example.test', password: 'test-password' };
  assert.deepEqual(await controller.createPasswordSession(credentials, 'root', undefined, request, response()), { ok: true });
  assert.equal(customTokens, 0);
  const legacy = await controller.login(credentials, request);
  assert.equal(legacy.customToken, 'custom');
  assert.equal(legacy.idToken, 'id');
  assert.equal(legacy.refreshToken, 'refresh');
  assert.equal(customTokens, 1);
  assert.equal(rateLimits, 2);

  for (const successfulResponse of [false, true]) {
    ok = successfulResponse;
    upstream = { mfaPendingCredential: 'pending', mfaInfo: [{ mfaEnrollmentId: 'totp', totpInfo: {} }] };
    await assert.rejects(controller.createPasswordSession(credentials, 'root', undefined, request, response()), (error: any) => {
      assert.equal(error.getStatus(), 409);
      assert.equal(error.getResponse().mfaRequired, true);
      return true;
    });
  }
  ok = false;
  upstream = { error: { message: 'INVALID_LOGIN_CREDENTIALS' } };
  await assert.rejects(controller.createPasswordSession(credentials, 'root', undefined, request, response()), (error: any) => error.getStatus() === 401);
  assert.equal(sessions, 1, 'failures never reach session creation');
  assert.equal(customTokens, 1);
  assert.equal(rateLimits, 5, 'all attempts still enforce rate limits');
});

function sessionSetup(app = 'root') {
  const events: string[] = [];
  const decoded: any = { uid: 'uid', email: 'alice@example.test', email_verified: true, auth_time: Math.floor(Date.now() / 1000) };
  const auth = {
    verifyIdToken: async (_token: string, revoked: boolean) => { assert.equal(revoked, true); events.push('verify'); return decoded; },
    createSessionCookie: async () => { events.push('cookie'); return 'session'; },
  };
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  Object.assign(controller, {
    logger,
    firebaseAdmin: { auth: () => auth, projectId: () => 'test-project' },
    resolveSessionAppId: () => app,
    ensureUserProfile: async () => { events.push('sync'); },
    consumeSignupSignInAlertSuppression: async () => false,
    isTrustedAuthDevice: async () => false,
    getUserProfile: async () => { events.push('profile'); return { roles: ['user'], fullname: 'Alice', securityEmailsEnabled: false }; },
    sessionSigner: { sign: () => 'signed-meta' },
  });
  const res = response();
  return { controller, auth, decoded, events, res, signIn: () => controller.createSession('Bearer test-id', app, undefined, request, res) };
}

test('ordinary sessions read the profile once, after persistence and fresh token verification', async () => {
  const state = sessionSetup();
  assert.equal((await state.signIn()).ok, true);
  assert.deepEqual(state.events, ['verify', 'cookie', 'sync', 'profile']);
  assert.equal(state.res.cookies.length, 2);
});

test('admin access still checks current roles before creating a session or writing profiles', async () => {
  const state = sessionSetup('admin');
  await assert.rejects(state.signIn(), (error: any) => error.getStatus() === 403);
  assert.deepEqual(state.events, ['verify', 'profile']);
  assert.ok(state.res.cookies.length > 0, 'existing sessions are explicitly cleared');
  assert.ok(state.res.cookies.every((cookie: any[]) => cookie[1] === '' && cookie[2].maxAge === 0));
});

test('valid admins retain both role checks and the final fresh metadata read', async () => {
  const state = sessionSetup('admin');
  state.controller.getUserProfile = async () => { state.events.push('profile'); return { roles: ['admin'] }; };
  await state.signIn();
  assert.deepEqual(state.events, ['verify', 'profile', 'cookie', 'sync', 'profile']);
});

test('revoked, unverified, old-auth and failed profile writes never issue browser cookies', async () => {
  for (const failure of ['revoked', 'unverified', 'old-auth', 'profile']) {
    const state = sessionSetup();
    if (failure === 'revoked') state.auth.verifyIdToken = async () => { throw new Error('revoked'); };
    if (failure === 'unverified') state.decoded.email_verified = false;
    if (failure === 'old-auth') state.decoded.auth_time = 1;
    if (failure === 'profile') state.controller.ensureUserProfile = async () => { throw new Error('write failed'); };
    await assert.rejects(state.signIn());
    assert.equal(state.res.cookies.length, 0, failure);
    if (failure !== 'profile') assert.ok(!state.events.includes('cookie'), failure);
  }
});

test('profile synchronization commits two merge writes atomically and awaits security activity', async () => {
  for (const fail of [false, true]) {
    const events: string[] = [];
    const writes: any[] = [];
    const appRef = { id: 'root', get: async () => ({ exists: false }) };
    const userRef = { id: 'alice@example.test', get: async () => ({ data: () => ({ createdAt: Timestamp.now(), roles: ['user'], fullname: 'Alice' }) }), collection: () => ({ doc: () => appRef }) };
    const controller: any = Object.create(AuthControllerBase.prototype);
    Object.assign(controller, {
      logger,
      firebaseAdmin: { db: () => ({
        collection: () => ({ doc: () => userRef }),
        batch: () => ({ set: (...args: any[]) => writes.push(args), commit: async () => { events.push('commit'); if (fail) throw new Error('unavailable'); } }),
      }) },
      securityEvents: { recordAccountActivity: async () => { events.push('activity'); } },
    });
    const task = controller.ensureUserProfile({ uid: 'uid', email: 'alice@example.test' }, 'root');
    if (fail) await assert.rejects(task, /unavailable/);
    else await task;
    assert.equal(writes.length, 2, 'same two billable writes');
    assert.deepEqual(writes.map(write => write[2]), [{ merge: true }, { merge: true }]);
    assert.deepEqual(writes.map(write => write[0]), [userRef, appRef]);
    assert.deepEqual(events, fail ? ['commit'] : ['commit', 'activity']);
  }
});

test('informational welcome email waits for a successful response; aborts and errors do not send it', async () => {
  for (const outcome of ['success', 'error', 'closed', 'destroyed']) {
    const res = response();
    let sent = 0;
    if (outcome === 'error') res.statusCode = 500;
    if (outcome === 'destroyed') res.destroyed = true;
    afterSuccessfulAuthResponse(res, async () => { sent++; }, () => assert.fail('unexpected failure'));
    await Promise.resolve();
    assert.equal(sent, 0);
    if (outcome === 'closed') res.emit('close');
    res.emit('finish');
    res.emit('finish');
    await Promise.resolve();
    assert.equal(sent, outcome === 'success' ? 1 : 0);
    assert.equal(res.listenerCount('finish'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
  const res = response();
  const failure = new Error('email unavailable');
  let reported: unknown;
  afterSuccessfulAuthResponse(res, async () => { throw failure; }, error => { reported = error; });
  res.emit('finish');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reported, failure);
});

test('timings preserve results and failures, exposing only stage names and durations', async () => {
  const res = response();
  assert.equal(await authStage(res, 'password', async () => 42), 42);
  await assert.rejects(authStage(res, 'verify_token', async () => { throw new Error('private detail'); }), /private detail/);
  assert.match(res.getHeader('Server-Timing'), /^password;dur=\d+\.\d, verify_token;dur=\d+\.\d$/);
});

test('welcome email uses a bounded request and a hashed per-account idempotency key without retries', async t => {
  const service: any = new ResendService();
  service.getApiKey = () => 'test-key';
  service.logger = logger;
  let calls = 0;
  let upstreamOk = true;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: any) => {
    calls++;
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.headers['Idempotency-Key'], `signup-welcome/${createHash('sha256').update('uid').digest('hex')}`);
    assert.deepEqual(JSON.parse(options.body).to, ['alice@example.test']);
    return { ok: upstreamOk, status: 503, text: async () => 'unavailable' };
  });
  const data = { userId: 'uid', email: 'alice@example.test', appName: 'LiftWise' };
  await service.sendSignupWelcomeEmail(data);
  upstreamOk = false;
  await assert.rejects(service.sendSignupWelcomeEmail(data), /503/);
  assert.equal(calls, 2, 'one request per call, no retry loop');
});

test('signup awaits verification, profile/session creation, challenge cleanup and audit before scheduling welcome', async () => {
  const events: string[] = [];
  const challenge: any = { codeHash: createHash('sha256').update('123456').digest('hex'), expiresAt: Timestamp.fromMillis(Date.now() + 60_000) };
  const db = {
    collection: () => ({ doc: () => ({ set: async () => { events.push('suppression'); } }) }),
    runTransaction: async (fn: any) => fn({
      get: async () => ({ exists: true, data: () => challenge, get: (key: string) => challenge[key] }),
      update: (_ref: unknown, data: any) => { Object.assign(challenge, data); events.push('claim'); },
      delete: () => { events.push('cleanup'); },
    }),
  };
  const controller: any = Object.create(AuthOnboardingRoutes.prototype);
  Object.assign(controller, {
    logger,
    resolveSessionAppId: () => 'root', enforceAuthRateLimit: async () => { events.push('rate-limit'); },
    firebaseAdmin: { db: () => db, auth: () => ({
      getUserByEmail: async () => { throw { code: 'auth/user-not-found' }; },
      createUser: async (data: any) => { assert.equal(data.emailVerified, true); events.push('user'); return { uid: 'uid' }; },
      createCustomToken: async () => 'custom',
    }) },
    exchangeCustomTokenForIdToken: async () => 'id',
    createSession: async (...args: any[]) => { assert.equal(args[6], true); events.push('session'); },
    recordAccountSecurityActivity: async () => { events.push('audit'); },
    resendService: { sendSignupWelcomeEmail: async () => { events.push('welcome'); } },
  });
  const res = response();
  const result = await controller.verifyEmailVerificationCode({ email: 'alice@example.test', code: '123456', password: 'test-password', displayName: 'Alice' }, 'root', undefined, request, res);
  assert.equal(result.success, true);
  assert.deepEqual(events, ['rate-limit', 'claim', 'user', 'suppression', 'session', 'cleanup', 'audit']);
  res.emit('finish');
  await Promise.resolve();
  assert.equal(events.at(-1), 'welcome');
});
