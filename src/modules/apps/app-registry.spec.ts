import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOauthClient } from './app-registry';

void test('Nook Matrix Synapse is a public OIDC client with PKCE callback scope', () => {
  const client = resolveOauthClient('nook-matrix-synapse');

  assert.deepEqual(client, {
    id: 'nook-matrix-synapse',
    appId: 'nook',
    name: 'Nook Matrix Homeserver',
    redirectUris: ['https://matrix.chefu.co.za/_synapse/client/oidc/callback'],
    scopes: ['openid', 'profile', 'email'],
  });
});
