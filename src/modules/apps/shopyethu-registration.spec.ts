import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registeredAppOrigins, resolveChefuAppId, resolveOauthClient } from './app-registry';

test('ShopYethu has a dedicated OAuth identity with exact callbacks and profile scopes', () => {
  assert.equal(resolveChefuAppId('shopyethu'), 'shopyethu');
  assert.ok(registeredAppOrigins().includes('https://shopyethu-admin.chefu.co.za'));
  const client = resolveOauthClient('shopyethu-web');
  assert.ok(client);
  assert.equal(client.appId, 'shopyethu');
  assert.deepEqual(client.redirectUris, [
    'https://shopyethu-admin.chefu.co.za/auth/callback',
  ]);
  assert.deepEqual(client.scopes, ['openid', 'profile', 'email']);
});
