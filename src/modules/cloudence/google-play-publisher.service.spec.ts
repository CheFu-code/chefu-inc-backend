import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { IdentityPoolClient, OAuth2Client } from 'google-auth-library';
import { GooglePlayPublisherService } from './google-play-publisher.service';

function configure(t: TestContext) {
  const settings = {
    GOOGLE_PLAY_BILLING_ENABLED: 'true',
    GOOGLE_PLAY_PACKAGE_NAME: 'za.co.chefu.cloudence',
    GOOGLE_PLAY_WIF_AUDIENCE: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/fly-billing/providers/fly',
    GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL: 'billing@chefu-technologies.iam.gserviceaccount.com',
    GOOGLE_PLAY_RTDN_AUDIENCE: 'https://api.example.com/notifications',
    GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: 'push@chefu-technologies.iam.gserviceaccount.com',
  };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  return settings;
}

void test('Publisher uses one federated client for subscription verification and acknowledgement', async (t) => {
  configure(t);
  const clients = new Set<IdentityPoolClient>();
  const calls: Array<{ url: string; method: string; data?: unknown }> = [];
  t.mock.method(IdentityPoolClient.prototype, 'getAccessToken', async () => ({ token: 'billing-access-token' }));
  t.mock.method(IdentityPoolClient.prototype, 'request', async function (
    this: IdentityPoolClient, options: { url: string; method: string; data?: unknown },
  ) {
    clients.add(this);
    calls.push(options);
    return { data: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } };
  });
  const publisher = new GooglePlayPublisherService();
  assert.equal(publisher.isConfigured(), true);
  assert.equal((await publisher.getSubscription('purchase/token')).subscriptionState, 'SUBSCRIPTION_STATE_ACTIVE');
  await publisher.acknowledge('product/id', 'purchase/token');
  assert.equal(clients.size, 1);
  assert.equal(calls[0].method, 'GET');
  assert.ok(calls[0].url.endsWith('/purchases/subscriptionsv2/tokens/purchase%2Ftoken'));
  assert.equal(calls[1].method, 'POST');
  assert.ok(calls[1].url.endsWith('/purchases/subscriptions/product%2Fid/tokens/purchase%2Ftoken:acknowledge'));
  assert.deepEqual(calls[1].data, {});
});

void test('missing WIF configuration and failed authentication cannot verify a purchase or expose credentials', async (t) => {
  const settings = configure(t);
  const publisher = new GooglePlayPublisherService();
  process.env.GOOGLE_PLAY_WIF_AUDIENCE = '';
  assert.equal(publisher.isConfigured(), false);
  await assert.rejects(publisher.getSubscription('purchase'), /not configured/);
  process.env.GOOGLE_PLAY_WIF_AUDIENCE = settings.GOOGLE_PLAY_WIF_AUDIENCE;
  t.mock.method(IdentityPoolClient.prototype, 'getAccessToken', async () => {
    throw new Error('sensitive-subject-token');
  });
  await assert.rejects(publisher.getSubscription('purchase'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Google Play workload identity authentication is unavailable.');
    return true;
  });
});

void test('RTDN still validates its own audience and verified service account email', async (t) => {
  const settings = configure(t);
  let verified = true;
  let email = settings.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL;
  t.mock.method(OAuth2Client.prototype, 'verifyIdToken', async (options: { audience: string; idToken: string }) => {
    assert.equal(options.audience, settings.GOOGLE_PLAY_RTDN_AUDIENCE);
    assert.equal(options.idToken, 'push-id-token');
    return { getPayload: () => ({ email, email_verified: verified }) };
  });
  const publisher = new GooglePlayPublisherService();
  assert.equal(await publisher.verifyNotificationToken('push-id-token'), true);
  verified = false;
  assert.equal(await publisher.verifyNotificationToken('push-id-token'), false);
  verified = true;
  email = settings.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL;
  assert.equal(await publisher.verifyNotificationToken('push-id-token'), false);
});
