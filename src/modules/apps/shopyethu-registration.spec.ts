import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registeredAppOrigins, resolveChefuAppId, resolveOauthClient } from './app-registry';

test('ShopYethu registers its central-session browser origin without an OAuth client', () => {
  assert.equal(resolveChefuAppId('shopyethu'), 'shopyethu');
  assert.ok(registeredAppOrigins().includes('https://shopyethu-admin.chefu.co.za'));
  assert.equal(resolveOauthClient('shopyethu-web'), null);
});
