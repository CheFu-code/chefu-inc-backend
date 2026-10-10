import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findPasswordBreachCount,
  getPasswordBreachRange,
} from './password-breach';

void test('creates a local range key without transmitting the password', () => {
  assert.deepEqual(getPasswordBreachRange('password'), {
    prefix: '5BAA6',
    suffix: '1E4C9B93F3F0682250B6CF8331B7EE68FD8',
  });
});

void test('finds matching suffixes in a HIBP range response', () => {
  assert.equal(
    findPasswordBreachCount('0123456789ABCDEF0123456789ABCDEF012:7\nFEDCBA9876543210FEDCBA9876543210FED:42', 'fedcba9876543210fedcba9876543210fed'),
    42,
  );
});

void test('returns zero when a suffix is absent from the range response', () => {
  assert.equal(
    findPasswordBreachCount('0123456789ABCDEF0123456789ABCDEF012:7\n', 'FEDCBA9876543210FEDCBA9876543210FED'),
    0,
  );
});

void test('ignores malformed or invalid-count entries', () => {
  assert.equal(
    findPasswordBreachCount('malformed\nFEDCBA9876543210FEDCBA9876543210FED:not-a-count', 'FEDCBA9876543210FEDCBA9876543210FED'),
    0,
  );
});
