import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RuntimeLimitService } from '../../common/runtime-limit.service';
import { PhoneVerificationPolicy } from './phone-verification.policy';

test('send budgets include shared account, IP, phone and deployment-wide limits', async () => {
  const buckets = new Map<string, { count: number; limit: number }>();
  const limits = { reserve: async (input: { key: string; limit: number }) => {
    const count = (buckets.get(input.key)?.count || 0) + 1;
    buckets.set(input.key, { count, limit: input.limit });
    return { limited: count > input.limit, retryAfterSeconds: 30 };
  } } as unknown as RuntimeLimitService;
  const policy = new PhoneVerificationPolicy(new ConfigService({ PHONE_VERIFICATION_DAILY_SEND_LIMIT: '2' }), limits);
  await policy.send('owner', '+27821234567', 'ip-one');
  await assert.rejects(policy.send('owner', '+27821234567', 'ip-one'), (cause: any) => cause.getStatus() === 429 && cause.getResponse().retryAfterSeconds === 30);
  assert.equal(buckets.get('send:global')?.limit, 2);
  assert.equal(buckets.get('send:ip:ip-one')?.limit, 20);
  assert.equal(buckets.get('send:uid:owner')?.limit, 5);
});

test('distributed limiter failure blocks verification and never falls back in the phone module', async () => {
  const limits = { reserve: async () => { throw new ServiceUnavailableException('Security checks unavailable.'); } } as unknown as RuntimeLimitService;
  const policy = new PhoneVerificationPolicy(new ConfigService(), limits);
  await assert.rejects(policy.send('owner', '+27821234567', 'ip'), (cause: any) => cause.getStatus() === 503);
  await assert.rejects(policy.check('owner', 'ip'), (cause: any) => cause.getStatus() === 503);
});
