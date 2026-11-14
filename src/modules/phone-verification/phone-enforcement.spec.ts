import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthGuard } from '../auth/auth.guard';
import { AuthSessionRoutes } from '../auth/auth-session.routes';
import { AuthSecurityRoutes } from '../auth/auth-security.routes';
import { OAuthService } from '../auth/oauth.service';
import { readAuthUserProfile } from '../auth/auth-user-profile';

const phone = '+27821234567', verified = { phone, phoneVerifiedFor: phone, phoneVerifiedAt: '2026-01-01T00:00:00.000Z' };
const logger = { log() {}, warn() {}, error() {} };
const denied = (cause: any) => cause.getStatus() === 403 && cause.getResponse().code === 'phone_verification_required';
test('stale cookie claims cannot bypass application access, and authorization reuses one request profile read', async () => {
  let profile: object = verified, reads = 0;
  const firebase = { db: () => ({ collection: (name: string) => {
    assert.equal(name, 'users'); return { doc: () => ({ get: async () => { reads++; return { data: () => profile }; } }) };
  } }) };
  const guard: any = Object.create(AuthGuard.prototype);
  Object.assign(guard, { firebaseAdmin: firebase, logger, honeytokens: { inspectRequest: async () => {} },
    resolveSessionUser: async () => ({ source: 'session_cookie', user: { uid: 'owner', email: 'owner@example.test', roles: ['admin'] } }),
  });
  const request = () => ({ path: '/auth/shopyethu/session', headers: {}, cookies: { __session: 'stale-signed-cookie' }, socket: {} });
  const context = (req: object) => ({ switchToHttp: () => ({ getRequest: () => req }) });
  const first: any = request();
  assert.equal(await guard.canActivate(context(first)), true);
  await readAuthUserProfile(firebase as any, 'owner@example.test', first);
  assert.equal(reads, 1, 'downstream role checks share the same profile snapshot');
  profile = { ...verified, phone: '+27831234567' };
  await assert.rejects(guard.canActivate(context(request())), denied);
  assert.equal(reads, 2, 'the next HTTP request must see current state');
  await guard.canActivate(context({ ...request(), path: '/phone-verification/check' }));
  assert.equal(reads, 2, 'recovery does not add an enforcement read');
});
test('OAuth user access checks current contact state and keeps OTP recovery reachable', async () => {
  let reads = 0;
  const service: any = Object.create(OAuthService.prototype);
  Object.assign(service, {
    issuer: 'https://api.chefu.co.za', verifyJwt: () => ({ typ: 'access_token', email: 'owner@example.test', sub: 'owner' }),
    securityEvents: { assertTokenNotRevoked: async () => {} }, enforceDpopBinding: async () => {},
    firebaseAdmin: { db: () => ({ collection: () => ({ doc: () => ({ get: async () => { reads++; return { data: () => ({ phone }) }; } }) }) }) },
  });
  await assert.rejects(service.verifyAccessToken('signed-token', { path: '/shopyethu/orders' }), denied);
  await service.verifyAccessToken('signed-token', { path: '/phone-verification/send' });
  assert.equal(reads, 1);
});
test('OAuth authorization redirects pending users before creating a code, preserving PKCE and state', async () => {
  let profile: object = { phone }, writes = 0;
  const service: any = Object.create(OAuthService.prototype);
  Object.assign(service, {
    logger, issuer: 'https://api.chefu.co.za', accountUrl: 'https://myaccount.chefu.co.za', authorizationCodeTtlMs: 60000,
    validateAuthorizeParams: () => ({ appId: 'shopyethu', id: 'shopyethu-mobile' }),
    getSessionUser: async () => ({ uid: 'owner', email: 'owner@example.test' }), resolveScopes: () => ['openid'],
    randomToken: () => 'opaque-code', authorizationCodes: () => ({ doc: () => ({ set: async () => { writes++; } }) }),
    firebaseAdmin: { db: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ data: () => profile }) }) }) }) },
  });
  const params = { client_id: 'shopyethu-mobile', redirect_uri: 'shopyethu://sso-callback', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'original-state', nonce: 'original-nonce', response_type: 'code' };
  const result = new URL((await service.authorize(params, { headers: {}, socket: {} })).redirectTo);
  assert.equal(writes, 0); assert.equal(result.pathname, '/verify-phone'); assert.equal(result.searchParams.get('app'), 'shopyethu');
  const original = new URL(result.searchParams.get('returnTo')!);
  assert.equal(original.searchParams.get('state'), params.state);
  assert.equal(original.searchParams.get('code_challenge'), params.code_challenge);
  profile = verified;
  await service.authorize(params, { headers: {}, socket: {} }); assert.equal(writes, 1);
});
test('session reuse returns the flag from one profile load, with no receipt reads, provider calls or writes', async () => {
  let reads = 0;
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  Object.assign(controller, {
    firebaseAdmin: { auth: () => ({ verifySessionCookie: async () => ({ uid: 'owner', email: 'owner@example.test', email_verified: true }) }) },
    getUserProfile: async () => { reads++; return { phone, roles: [] }; }, resolveSessionAppId: () => 'shopyethu',
  });
  const result = await controller.getSessionStatus('shopyethu', { cookies: { __session: 'cookie' } }, { setHeader() {} });
  assert.equal(result.authenticated, true); assert.equal(result.phoneVerificationRequired, true); assert.equal(reads, 1);
});

test('refreshing a stale user session fails before rotating or spending a refresh token', async () => {
  let writes = 0, profileReads = 0;
  const record = { clientId: 'shopyethu-mobile', email: 'owner@example.test', uid: 'owner', expiresAt: Date.now() + 60000 };
  const ref = { get: async () => ({ exists: true, data: () => record }) };
  const service: any = Object.create(OAuthService.prototype);
  Object.assign(service, {
    appsService: { resolveOauthClient: () => ({ id: 'shopyethu-mobile' }) }, hash: (value: string) => value,
    randomToken: () => 'next-token', refreshTokens: () => ({ doc: () => ref }), issueRefreshTokens: true,
    firebaseAdmin: { db: () => ({ collection: () => ({ doc: () => 'profile' }), runTransaction: async (work: any) => work({
      get: async (target: unknown) => target === ref ? { exists: true, data: () => record } : (profileReads++, { data: () => ({ phone }) }),
      update: () => { writes++; }, set: () => { writes++; },
    }) }) },
  });
  await assert.rejects(service.exchangeRefreshToken({ client_id: 'shopyethu-mobile', refresh_token: 'refresh' }, {}), denied);
  assert.equal(writes, 0); assert.equal(profileReads, 1);
});

test('deleting an account also deletes its private phone challenge and receipt', async () => {
  const deleted: string[] = [];
  const controller: any = Object.create(AuthSecurityRoutes.prototype);
  controller.firebaseAdmin = { db: () => ({ collection: (table: string) => ({
    where: () => ({ get: async () => ({ docs: [] }) }),
    doc: (id: string) => ({ delete: async () => { deleted.push(`${table}/${id}`); } }),
  }) }) };
  await controller.clearAccountDeletionDocuments('owner');
  assert.equal(deleted.filter(path => /^phone_verification_(challenges|verified)\/[a-f\d]{64}$/.test(path)).length, 2);
  assert.equal(deleted.some(path => path.includes('owner@example.test')), false);
});
