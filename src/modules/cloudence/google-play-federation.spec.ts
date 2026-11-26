import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGooglePlayFederatedClient, requestFlyIdentityToken } from './google-play-federation';

const audience = '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/fly-billing/providers/fly';
const email = 'billing@chefu-technologies.iam.gserviceaccount.com';
const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmbHktbWFjaGluZSJ9.signature';

async function flyApi(t: TestContext, listener: RequestListener) {
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\cloudence-wif-${randomUUID()}`
    : join(tmpdir(), `wif-${randomUUID()}.sock`);
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return socketPath;
}

void test('requests a raw identity JWT over the Fly local socket with the exact WIF audience', async (t) => {
  let body = '';
  const path = await flyApi(t, (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/tokens/oidc');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.authorization, undefined);
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => { res.end(` ${jwt}\n`); });
  });
  assert.equal(await requestFlyIdentityToken(audience, path), jwt);
  assert.deepEqual(JSON.parse(body), { aud: audience });
});

void test('fails closed on Fly API errors, malformed tokens, and oversized responses without exposing their contents', async (t) => {
  for (const [status, content] of [
    [403, 'private-fly-error'], [302, jwt], [200, ''], [200, 'not-a-token'], [200, 'a'.repeat(17000)],
  ] as const) {
    const path = await flyApi(t, (_req, res) => {
      res.statusCode = status;
      res.end(content);
    });
    await assert.rejects(requestFlyIdentityToken(audience, path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Fly workload identity/);
      assert.ok(!error.message.includes('private-fly-error'));
      assert.ok(!error.message.includes(jwt));
      return true;
    });
  }
});

void test('bounds slow local API requests and rejects missing sockets', async (t) => {
  const path = await flyApi(t, () => {});
  await assert.rejects(requestFlyIdentityToken(audience, path, 50), /unavailable/);
  await assert.rejects(requestFlyIdentityToken(audience, `${path}-missing`), /unavailable/);
});

void test('rejects a disconnected local API response without an unhandled stream error', async (t) => {
  const path = await flyApi(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': 1000 });
    res.write('partial');
    setImmediate(() => res.destroy());
  });
  await assert.rejects(requestFlyIdentityToken(audience, path), /unavailable/);
});

void test('exchanges the Fly JWT, impersonates only the billing account, caches credentials and refreshes them', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const client = createGooglePlayFederatedClient({ audience, serviceAccountEmail: email });
  let subjectRequests = 0;
  let exchanges = 0;
  let impersonations = 0;
  t.mock.method(client, 'retrieveSubjectToken', async () => { subjectRequests++; return jwt; });
  // Both STS and IAM calls use Gaxios; intercept its transport so no requests leave the test.
  t.mock.method(Object.getPrototypeOf(client.transporter), 'request', async (options: {
    url: string; headers: Headers | Record<string, string>; data: unknown;
  }) => {
    const url = String(options.url);
    if (url === 'https://sts.googleapis.com/v1/token') {
      exchanges++;
      const form = options.data as URLSearchParams;
      assert.equal(form.get('subject_token'), jwt);
      assert.equal(form.get('audience'), audience);
      assert.equal(form.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:jwt');
      return { data: { access_token: 'sts-token', expires_in: 3600 } };
    }
    assert.equal(url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`);
    impersonations++;
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer sts-token');
    assert.deepEqual(options.data, { scope: ['https://www.googleapis.com/auth/androidpublisher'], lifetime: '3600s' });
    return { data: { accessToken: `billing-token-${impersonations}`, expireTime: new Date(Date.now() + 3600000).toISOString() } };
  });

  await Promise.all(Array.from({ length: 5 }, () => client.getAccessToken()));
  assert.equal((await client.getAccessToken()).token, 'billing-token-1');
  assert.deepEqual([subjectRequests, exchanges, impersonations], [1, 1, 1]);
  t.mock.timers.tick(3600001);
  assert.equal((await client.getAccessToken()).token, 'billing-token-2');
  assert.deepEqual([subjectRequests, exchanges, impersonations], [2, 2, 2]);
});
