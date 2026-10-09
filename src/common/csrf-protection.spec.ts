import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedCookieMutationOrigin } from './csrf-protection';

const allowedOrigins = ['https://myaccount.chefu.co.za'];

void test('allows cookie mutations from a configured Origin', () => {
  assert.equal(
    isAllowedCookieMutationOrigin(
      'https://myaccount.chefu.co.za',
      undefined,
      allowedOrigins,
    ),
    true,
  );
});

void test('allows a configured Referer when Origin is absent', () => {
  assert.equal(
    isAllowedCookieMutationOrigin(
      undefined,
      'https://myaccount.chefu.co.za/account/security',
      allowedOrigins,
    ),
    true,
  );
});

void test('rejects missing, malformed, and untrusted cookie mutation origins', () => {
  assert.equal(isAllowedCookieMutationOrigin(undefined, undefined, allowedOrigins), false);
  assert.equal(
    isAllowedCookieMutationOrigin('https://attacker.example', undefined, allowedOrigins),
    false,
  );
  assert.equal(
    isAllowedCookieMutationOrigin(undefined, 'not a URL', allowedOrigins),
    false,
  );
});

void test('does not fall back to Referer when an Origin is present but untrusted', () => {
  assert.equal(
    isAllowedCookieMutationOrigin(
      'https://attacker.example',
      'https://myaccount.chefu.co.za/account',
      allowedOrigins,
    ),
    false,
  );
});
