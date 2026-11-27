import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AuthSecurityRoutes } from './auth-security.routes';

test('TOTP enrollment start sends the required provider enrollment info', async t => {
  const controller: any = Object.create(AuthSecurityRoutes.prototype);
  const reauthToken = 'reauth-token-that-is-long-enough-for-the-route';
  let requestBody: unknown;
  let storedSetup: Record<string, unknown> | undefined;
  let storedSetupId = '';

  Object.assign(controller, {
    getFirebaseWebApiKey: () => 'test-api-key',
    getReauthenticationSession: async () => ({ idToken: 'recent-id-token' }),
    firebaseAdmin: {
      db: () => ({
        collection: (name: string) => {
          assert.equal(name, 'auth_totp_setups');
          return {
            doc: (id: string) => {
              storedSetupId = id;
              return {
                create: async (data: Record<string, unknown>) => {
                  storedSetup = data;
                },
              };
            },
          };
        },
      }),
    },
  });

  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestBody = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({
      totpSessionInfo: {
        sharedSecretKey: 'BASE32SECRET',
        sessionInfo: 'provider-session',
      },
    }), { status: 200 });
  });

  const result = await controller.startTotpEnrollment(
    { user: { uid: 'user-1', email: 'alice@example.test' } },
    { reauthToken },
  );

  assert.deepEqual(requestBody, {
    idToken: 'recent-id-token',
    totpEnrollmentInfo: {},
  });
  assert.equal(storedSetup?.sessionInfo, 'provider-session');
  assert.equal(
    storedSetup?.reauthTokenHash,
    createHash('sha256').update(reauthToken).digest('hex'),
  );
  assert.ok(storedSetupId);
  assert.equal(result.secret, 'BASE32SECRET');
  assert.match(result.otpauthUrl, /^otpauth:\/\/totp\//);
});
