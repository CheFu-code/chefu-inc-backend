import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { TwilioVerificationProvider } from './phone-verification.provider';

const sid = `VE${'1'.repeat(32)}`, serviceSid = `VA${'2'.repeat(32)}`, phone = '+27821234567';
const status = (expected: number) => (cause: any) => cause.getStatus?.() === expected;
const emptyConfig = () => ({ get: () => undefined }) as unknown as ConfigService;
function providerWith(start: () => Promise<any>, check: (options: any) => Promise<any>) {
  const provider = new TwilioVerificationProvider(emptyConfig());
  (provider as any).client = { verify: { v2: { services: () => ({ verifications: { create: start }, verificationChecks: { create: check } }) } } };
  (provider as any).serviceSid = serviceSid;
  (provider as any).logger = { warn: () => undefined };
  return provider;
}

test('missing credentials do not break module construction and cannot trigger an SMS', async () => {
  const provider = new TwilioVerificationProvider(emptyConfig());
  assert.throws(() => provider.assertConfigured(), status(503));
  await assert.rejects(provider.start(phone), status(503));
});

test('provider approval must match the stored SID, phone and service, and must be valid', async () => {
  let result = { status: 'approved', valid: true, sid, to: phone, serviceSid };
  const provider = providerWith(async () => ({ sid, to: phone, status: 'pending' }), async options => {
    assert.deepEqual(options, { verificationSid: sid, code: '123456' }); return result;
  });
  assert.equal(await provider.start(phone), sid);
  assert.equal(await provider.check(sid, phone, '123456'), true);
  result = { ...result, valid: false };
  assert.equal(await provider.check(sid, phone, '123456'), false);
  result = { ...result, to: '+27831234567' };
  await assert.rejects(provider.check(sid, phone, '123456'), status(503));
});

test('expired codes, provider throttles and unknown errors return safe messages', async () => {
  let error: unknown = { code: 20404 };
  const provider = providerWith(async () => { throw error; }, async () => { throw error; });
  await assert.rejects(provider.check(sid, phone, '123456'), status(400));
  for (const code of [60202, 60203]) {
    error = { code };
    await assert.rejects(provider.start(phone), status(429));
  }
  error = { status: 429 };
  await assert.rejects(provider.start(phone), status(429));
  error = null;
  await assert.rejects(provider.start(phone), status(503));
  error = new Error('raw provider detail with private values');
  await assert.rejects(provider.start(phone), cause => {
    assert.equal((cause as any).getStatus(), 503);
    assert.equal((cause as Error).message.includes('private values'), false); return true;
  });
});
