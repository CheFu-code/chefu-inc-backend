import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registeredAppOrigins, resolveChefuAppId, resolveOauthClient } from './app-registry';

test('ShopYethu web keeps central sessions and Android has an exact native PKCE callback', () => {
  assert.equal(resolveChefuAppId('shopyethu'), 'shopyethu');
  assert.ok(registeredAppOrigins().includes('https://shopyethu-admin.chefu.co.za'));
  assert.equal(resolveOauthClient('shopyethu-web'), null);
  assert.deepEqual(resolveOauthClient('shopyethu-mobile'), {
    id: 'shopyethu-mobile', appId: 'shopyethu', name: 'ShopYethu Android',
    redirectUris: ['shopyethu://sso-callback'], scopes: ['openid', 'profile', 'email'],
  });
});
