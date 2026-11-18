import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { normalizeContactPhone, phoneContact, saveContactProfile } from './phone-contact';

const phone = '+27821234567';

void test('phone contact normalization accepts supported international and South African formats', () => {
  assert.equal(normalizeContactPhone('082 123 4567'), phone);
  assert.equal(normalizeContactPhone('+27 82 123 4567'), phone);
  assert.equal(normalizeContactPhone('invalid'), null);
  assert.deepEqual(phoneContact({ phone: '082 123 4567' }), { phone });
  assert.deepEqual(phoneContact({}), { phone: '' });
});

void test('profile contact edits save normalized numbers without sending a verification code', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const ref = { set: async (data: Record<string, unknown>) => { writes.push(data); } };
  const firebase = {
    db: () => ({ collection: () => ({ doc: () => ref }) }),
  } as unknown as FirebaseAdminService;

  await saveContactProfile(firebase, 'owner@example.test', { bio: 'Updated' }, '082 123 4567');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].phone, phone);
  assert.equal(writes[0].bio, 'Updated');
});

void test('profile contact edits reject malformed numbers and permit clearing a number', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const ref = { set: async (data: Record<string, unknown>) => { writes.push(data); } };
  const firebase = {
    db: () => ({ collection: () => ({ doc: () => ref }) }),
  } as unknown as FirebaseAdminService;

  await assert.rejects(saveContactProfile(firebase, 'owner@example.test', {}, '082abc4567'));
  await saveContactProfile(firebase, 'owner@example.test', {}, '');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].phone, null);
});
