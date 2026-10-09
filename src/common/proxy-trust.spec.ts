import test from 'node:test';
import assert from 'node:assert/strict';

import { getTrustedProxyAddresses } from './proxy-trust';

void test('proxy trust defaults to no forwarded-header trust', () => {
  assert.deepEqual(getTrustedProxyAddresses(undefined), []);
  assert.deepEqual(getTrustedProxyAddresses('  '), []);
});

void test('proxy trust accepts only explicit IP addresses and CIDR ranges', () => {
  assert.deepEqual(
    getTrustedProxyAddresses('10.0.0.8, 2001:db8::/32, 192.0.2.0/24'),
    ['10.0.0.8', '2001:db8::/32', '192.0.2.0/24'],
  );
  assert.deepEqual(getTrustedProxyAddresses('10.0.0.8,10.0.0.8'), ['10.0.0.8']);
});

void test('proxy trust rejects wildcard, hop-count, and malformed settings', () => {
  for (const setting of ['*', 'true', '2', 'proxy.internal', '10.0.0.1/33']) {
    assert.throws(() => getTrustedProxyAddresses(setting), /TRUSTED_PROXY_IPS/);
  }
});
