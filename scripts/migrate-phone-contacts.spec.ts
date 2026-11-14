import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';
import { planPhoneMigration, migratePhoneContacts } from './phone-contact-migration';

const phone = '+27821234567', other = '+27831234567', verifiedAt = '2026-01-01T00:00:00.000Z';
const verified = { phone, phoneVerifiedFor: phone, phoneVerifiedAt: verifiedAt };
test('migration preserves matching trusted receipts, flags conflicts and never trusts Firebase phone presence', () => {
  const receipt = { uid: 'owner', phone, verifiedAt, provider: 'twilio-verify' };
  const plan = planPhoneMigration({ phoneNumber: '082 123 4567' }, 'owner', receipt);
  assert.equal(plan.fields.phone, phone); assert.equal(plan.fields.phoneVerifiedAt, verifiedAt); assert.equal(plan.removeAlias, true);
  assert.equal(planPhoneMigration(plan.fields, 'owner', receipt).changed, false);
  assert.equal(planPhoneMigration({ phone, phoneVerifiedAt: verifiedAt }, 'owner', null).fields.phoneVerifiedAt, null);
  assert.equal(planPhoneMigration({ phone }, 'owner', { ...receipt, uid: 'other' }).fields.phoneVerifiedAt, null);
  const conflict = planPhoneMigration({ ...verified, phoneNumber: other }, 'owner', receipt);
  assert.equal(conflict.conflict, true); assert.equal(conflict.removeAlias, false); assert.equal(conflict.fields.phoneVerifiedAt, null);
  assert.equal(planPhoneMigration({ phone: 'broken' }, 'owner', receipt).invalid, true);
  assert.equal(planPhoneMigration({ phone, phoneContactSchemaVersion: 1 }, 'owner', receipt).fields.phoneVerifiedAt, null);
});
test('dry-run migration reports planned changes without writing profiles or invoking authentication', async () => {
  let page = 0, writes = 0;
  const document = { id: 'owner@example.test', data: () => ({ uid: 'owner', phoneNumber: phone }) };
  const query: any = { orderBy: () => query, limit: () => query, startAfter: () => query,
    get: async () => ++page === 1 ? { empty: false, docs: [document] } : { empty: true } };
  const firebase = { db: () => ({ collection: (table: string) => table === 'users' ? query : ({ doc: () => ({ get: async () => ({ data: () => undefined }) }) }),
    runTransaction: () => { writes++; throw new Error('Dry run cannot write'); } }) } as unknown as FirebaseAdminService;
  const result = await migratePhoneContacts(firebase);
  assert.deepEqual(result, { apply: false, scanned: 1, changed: 1, conflicts: 0, invalid: 0, identityMissing: 0 });
  assert.equal(writes, 0);
});
