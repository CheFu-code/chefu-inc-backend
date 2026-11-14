import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { validate } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { TestRepository } from '../shopyethu/marketplace.testing';
import { PhoneVerificationController } from './phone-verification.controller';
import { CheckCodeDto } from './phone-verification.dto';
import { PhoneVerificationPolicy, PHONE_MAX_CHECKS } from './phone-verification.policy';
import { PhoneVerificationRecords, type PhoneChallenge, type PhoneRecords } from './phone-verification.records';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { PhoneVerificationService } from './phone-verification.service';

const phone = '+27821234567';
const sid = `VE${'1'.repeat(32)}`;
const status = (expected: number) => (cause: any) => cause.getStatus?.() === expected;
function setup(overrides: Record<string, string | undefined> = {}) {
  const repo = new TestRepository();
  const reservations: { key: string; limit: number; windowMs: number }[] = [];
  const runtime = { reserve: async (options: typeof reservations[number]) => {
    reservations.push(options); return { limited: false, retryAfterSeconds: 30 };
  } } as unknown as RuntimeLimitService;
  const values: Record<string, string | undefined> = { PHONE_VERIFICATION_ENABLED: 'true', NODE_ENV: 'test', ...overrides };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  const policy = new PhoneVerificationPolicy(config, runtime);
  const provider = {
    sends: 0, checks: 0, approved: false, error: null as Error | null,
    assertConfigured: () => undefined,
    start: async (target: string) => { assert.equal(target, phone); provider.sends++; return sid; },
    check: async (id: string, target: string, _code: string) => {
      assert.equal(id, sid); assert.equal(target, phone); provider.checks++;
      if (provider.error) throw provider.error;
      return provider.approved;
    },
  };
  const records: PhoneRecords = {
    get: repo.get.bind(repo),
    getContact: async email => await repo.get<Record<string, unknown>>('contacts', email) || {},
    transaction: work => repo.transaction(tx => work({ ...tx, setContact: (email, value, verifiedAt) => tx.set('contacts', email, { phone: value, phoneVerifiedAt: verifiedAt, phoneVerifiedFor: value }) })),
  };
  return { repo, provider, policy, reservations, service: new PhoneVerificationService(records, policy, provider) };
}

test('all phone endpoints require the central auth guard; codes must be numeric', async () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, PhoneVerificationController), [AuthGuard]);
  const dto = Object.assign(new CheckCodeDto(), { phone, code: 'abcd' });
  assert.ok((await validate(dto)).length);
  dto.code = '123456'; assert.equal((await validate(dto)).length, 0);
});

test('normalization validates full SA numbers, supported countries and malformed input', () => {
  const { policy } = setup();
  assert.equal(policy.normalise('082 123 4567'), phone);
  assert.equal(policy.normalise('+27 (82) 123-4567'), phone);
  for (const invalid of ['0821234', '001234567890', '+271234567', '+14155552671', '082abc4567', null]) {
    assert.throws(() => policy.normalise(invalid), status(400));
  }
});

test('disabled features and unsafe production limit configuration block paid sends', async () => {
  for (const config of [{ PHONE_VERIFICATION_ENABLED: 'false' }, { NODE_ENV: 'production', RUNTIME_LIMIT_STORE: 'memory' }]) {
    const { service, provider } = setup(config);
    await assert.rejects(service.sendCode('owner', phone), status(503));
    assert.equal(provider.sends, 0);
  }
  const { service } = setup();
  await assert.rejects(service.sendCode('', phone), status(401));
});

test('an OTP is bound to the requesting UID, target and server-stored provider challenge', async () => {
  const { service, provider, repo, reservations } = setup();
  await service.sendCode('owner', '082 123 4567', 'trusted-ip');
  await assert.rejects(service.checkCode('other', phone, '123456'), status(400));
  await assert.rejects(service.checkCode('owner', '+27831234567', '123456'), status(400));
  assert.equal(provider.checks, 0);
  const challenge = await repo.get<PhoneChallenge>('challenges', 'owner');
  assert.equal(challenge?.verificationSid, sid);
  assert.equal('code' in challenge!, false);
  assert.ok(reservations.some(item => item.key === 'send:phone-cooldown:' + phone && item.windowMs === 30000));
  assert.ok(reservations.some(item => item.key === 'send:global'));
});

test('wrong codes are capped, resend cannot reset exhausted checks, expired challenges fail closed', async () => {
  const { service, provider, repo } = setup();
  await service.sendCode('owner', phone);
  for (let attempt = 0; attempt < PHONE_MAX_CHECKS; attempt++) await assert.rejects(service.checkCode('owner', phone, '111111'), status(400));
  await assert.rejects(service.checkCode('owner', phone, '111111'), status(429));
  await assert.rejects(service.sendCode('owner', phone), status(429));
  assert.equal(provider.checks, 5); assert.equal(provider.sends, 1);
  const previous = (await repo.get<PhoneChallenge>('challenges', 'owner'))!;
  await repo.transaction(async tx => { tx.set('challenges', 'owner', { ...previous, attempts: 0, expiresAtMs: Date.now() - 1 }); });
  await assert.rejects(service.checkCode('owner', phone, '123456'), status(400));
  assert.equal(provider.checks, 5);
});

test('a resend of the same provider challenge preserves its attempts and original expiry', async () => {
  const { service, repo } = setup();
  await service.sendCode('owner', phone);
  await assert.rejects(service.checkCode('owner', phone, '111111'), status(400));
  const before = (await repo.get<PhoneChallenge>('challenges', 'owner'))!;
  await service.sendCode('owner', phone);
  const after = (await repo.get<PhoneChallenge>('challenges', 'owner'))!;
  assert.equal(after.attempts, 1); assert.equal(after.expiresAtMs, before.expiresAtMs);
});

test('only approved checks persist an owned receipt; retrying confirmation does not consume another OTP', async () => {
  const { service, provider, repo } = setup();
  await service.sendCode('owner', phone);
  provider.approved = true;
  const verified = await service.checkCode('owner', phone, '123456');
  assert.equal(verified.verified, true);
  assert.equal((await repo.get<any>('verified', 'owner'))?.uid, 'owner');
  assert.equal((await service.status('other')).verified, false);
  assert.deepEqual(await service.checkCode('owner', phone, '123456'), verified);
  await service.sendCode('owner', phone);
  assert.equal(provider.checks, 1); assert.equal(provider.sends, 1);
});

test('concurrent checks cannot spend two provider calls on the same challenge', async () => {
  const { service, provider } = setup();
  await service.sendCode('owner', phone);
  let release!: (approved: boolean) => void, started!: () => void;
  const gate = new Promise<boolean>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  provider.check = async () => { provider.checks++; started(); return gate; };
  const first = service.checkCode('owner', phone, '123456');
  await waiting;
  await assert.rejects(service.checkCode('owner', phone, '123456'), status(429));
  release(true); await first;
  assert.equal(provider.checks, 1);
});

test('a delayed approval cannot verify a replaced phone challenge', async () => {
  const { service, provider, repo } = setup();
  await service.sendCode('owner', phone);
  provider.check = async () => {
    const current = (await repo.get<PhoneChallenge>('challenges', 'owner'))!;
    await repo.transaction(async tx => { tx.set('challenges', 'owner', { ...current, nonce: 'new-challenge', phone: '+27831234567', state: 'pending' }); });
    return true;
  };
  await assert.rejects(service.checkCode('owner', phone, '123456'), status(409));
  assert.equal((await service.status('owner')).verified, false);
});

test('provider failures never create a verified receipt and still consume a check attempt', async () => {
  const { service, provider, repo } = setup();
  await service.sendCode('owner', phone);
  provider.error = new BadRequestException('Expired code.');
  await assert.rejects(service.checkCode('owner', phone, '123456'), status(400));
  assert.equal((await service.status('owner')).verified, false);
  assert.equal((await repo.get<PhoneChallenge>('challenges', 'owner'))?.attempts, 1);
});

test('provider approval is not reported as verified when receipt storage fails', async () => {
  const { service, provider, repo } = setup();
  await service.sendCode('owner', phone);
  provider.check = async () => {
    repo.transaction = async () => { throw new Error('Private storage failure details'); };
    return true;
  };
  await assert.rejects(service.checkCode('owner', phone, '123456'), (cause: any) => {
    assert.equal(cause.getStatus(), 503);
    assert.equal(cause.message.includes('Private storage'), false); return true;
  });
  assert.equal((await service.status('owner')).verified, false);
});

test('approval saves the authenticated contact with the receipt; wrong codes cannot change it', async () => {
  const { service, provider, repo } = setup();
  await service.sendCode('owner', phone);
  await assert.rejects(service.checkCode('owner', phone, '000000', 'ip', 'owner@example.test'), status(400));
  assert.equal(await repo.get('contacts', 'owner@example.test'), null);
  provider.approved = true;
  await service.checkCode('owner', phone, '123456', 'ip', 'owner@example.test');
  const contact = await repo.get<any>('contacts', 'owner@example.test');
  assert.equal(contact.phone, phone); assert.equal(contact.phoneVerifiedFor, phone); assert.ok(contact.phoneVerifiedAt);
  assert.equal(await repo.get('contacts', 'other@example.test'), null);
});

test('an old receipt cannot verify a newly edited profile or bypass a fresh OTP', async () => {
  const { service, provider, repo } = setup();
  const email = 'owner@example.test';
  await service.sendCode('owner', phone, 'ip', email);
  provider.approved = true;
  await service.checkCode('owner', phone, '123456', 'ip', email);
  assert.equal((await service.status('owner', email)).verified, true);
  await repo.transaction(async tx => tx.set('contacts', email, { phone: '+27831234567', phoneVerifiedAt: null }));
  assert.equal((await service.status('owner', email)).verified, false);
  await service.sendCode('owner', phone, 'ip', email);
  assert.equal(provider.sends, 2);
  assert.equal((await service.status('owner', email)).verified, false);
});

test('the controller takes contact identity only from the authenticated session', async () => {
  let received: unknown[] = [];
  const service = { checkCode: async (...args: unknown[]) => { received = args; return { verified: true }; } };
  const controller = new PhoneVerificationController(service as unknown as PhoneVerificationService);
  await controller.check({ user: { uid: 'owner', email: 'owner@example.test' }, ip: '127.0.0.1' } as any,
    { phone, code: '123456', email: 'other@example.test', uid: 'other' } as any, {} as any);
  assert.deepEqual(received, ['owner', phone, '123456', '127.0.0.1', 'owner@example.test']);
});

test('production storage merges only contact fields in the same transaction as the receipt', async () => {
  const writes: { path: string; data: any; options: unknown }[] = [];
  let transactions = 0;
  const db = {
    collection: (table: string) => ({ doc: (id: string) => ({ path: `${table}/${id}` }) }),
    runTransaction: async (work: any) => {
      transactions++;
      return work({ set: (ref: any, data: any, options: unknown) => { writes.push({ path: ref.path, data, options }); } });
    },
  };
  const records = new PhoneVerificationRecords({ db: () => db } as unknown as FirebaseAdminService);
  await records.transaction(async tx => {
    tx.set('verified', 'owner', { uid: 'owner', phone });
    tx.setContact('owner@example.test', phone, '2026-01-01T00:00:00.000Z');
  });
  assert.equal(transactions, 1);
  assert.match(writes[0].path, /^phone_verification_verified\//);
  assert.equal(writes[1].path, 'users/owner@example.test');
  assert.equal(writes[1].data.phone, phone); assert.equal(writes[1].data.phoneVerifiedFor, phone);
  assert.equal(writes[1].data.phoneVerifiedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(writes[1].options, { merge: true });
});
