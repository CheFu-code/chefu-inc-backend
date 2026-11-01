import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSessionRisk } from './session-risk';

test('known device with ordinary browser has low advisory risk', () => {
  assert.deepEqual(assessSessionRisk({
    trustedDevice: true,
    userAgent: 'Mozilla/5.0',
    appId: 'academy',
  }), { score: 0, level: 'low', reasons: [] });
});

test('unrecognized device is flagged without blocking sign-in', () => {
  const result = assessSessionRisk({
    trustedDevice: false,
    userAgent: 'Mozilla/5.0',
    appId: 'liftwise',
  });
  assert.equal(result.level, 'elevated');
  assert.deepEqual(result.reasons, ['unrecognized_device']);
});

test('unrecognized admin automation gets high advisory risk', () => {
  const result = assessSessionRisk({
    trustedDevice: false,
    userAgent: 'curl/8.0',
    appId: 'admin',
  });
  assert.equal(result.level, 'high');
  assert.equal(result.score, 80);
  assert.deepEqual(result.reasons, [
    'unrecognized_device', 'automation_user_agent', 'unrecognized_admin_device',
  ]);
});

test('missing user agent is recognized and score remains bounded', () => {
  const result = assessSessionRisk({
    trustedDevice: false,
    userAgent: '',
    appId: 'admin',
  });
  assert.equal(result.score, 65);
  assert.equal(result.level, 'high');
});
