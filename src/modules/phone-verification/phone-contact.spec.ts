import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { assertPhoneVerified, isPhoneRecoveryRequest, normalizeContactPhone, phoneContact, saveContactProfile } from '../auth/phone-contact';

const phone = '+27821234567', other = '+27831234567', verifiedAt = '2026-01-01T00:00:00.000Z';
const verified = { phone, phoneVerifiedFor: phone, phoneVerifiedAt: verifiedAt };
test('only a dated proof bound to the current canonical number grants verification', () => {
  assert.equal(normalizeContactPhone('082 123 4567'), phone);
  assert.equal(phoneContact(verified).phoneVerificationRequired, false);
  assert.equal(phoneContact({ ...verified, phoneVerifiedAt: Timestamp.fromDate(new Date(verifiedAt)) }).phoneVerifiedAt, verifiedAt);
  for (const row of [{ phone }, { phone, phoneVerifiedAt: verifiedAt }, { ...verified, phone: other }, { ...verified, phoneVerifiedAt: 'invalid' },
    { ...verified, phoneVerifiedAt: new Date(Date.now() + 60000) }, { phone: 'invalid' }, { ...verified, phoneNumber: other }]) {
    assert.equal(phoneContact(row).phoneVerificationRequired, true);
    assert.throws(() => assertPhoneVerified(row), (cause: any) => cause.getStatus() === 403 && cause.getResponse().phoneVerificationRequired === true);
  }
  assert.equal(phoneContact({}).phoneVerificationRequired, false);
  assert.equal(phoneContact({ phoneNumber: '082 123 4567' }).phone, phone);
});
function storage(initial: Record<string, unknown>) {
  let row = { ...initial }, reads = 0, writes = 0, authCalls = 0;
  const ref = { set: async (data: object) => { writes++; row = { ...row, ...data }; } };
  const firebase = {
    db: () => ({ collection: () => ({ doc: () => ref }), runTransaction: async (work: any) => work({
      get: async () => { reads++; return { data: () => ({ ...row }) }; },
      set: (_ref: unknown, data: object) => { writes++; row = { ...row, ...data }; },
    }) }),
    auth: () => { authCalls++; throw new Error('Contact edits must never update Firebase phone sign-in'); },
  } as unknown as FirebaseAdminService;
  return { firebase, get row() { return row; }, counts: () => ({ reads, writes, authCalls }) };
}
test('ordinary edits do not read phone state; same-number edits preserve proof; changed numbers clear it', async () => {
  const state = storage(verified);
  await saveContactProfile(state.firebase, 'owner@example.test', { bio: 'Updated' });
  assert.deepEqual(state.counts(), { reads: 0, writes: 1, authCalls: 0 });
  await saveContactProfile(state.firebase, 'owner@example.test', {}, '082 123 4567');
  assert.equal(state.row.phoneVerifiedAt, verifiedAt); assert.equal(state.row.phone, phone);
  await saveContactProfile(state.firebase, 'owner@example.test', {}, other);
  assert.equal(state.row.phoneVerifiedAt, null); assert.equal(state.row.phoneVerifiedFor, null);
  assert.equal(phoneContact({ ...state.row, phoneNumber: undefined }).phoneVerificationRequired, true);
  assert.equal(state.counts().authCalls, 0);
});
test('unverified contacts cannot be removed to bypass the requirement, and malformed edits are rejected', async () => {
  const state = storage({ phone });
  await assert.rejects(saveContactProfile(state.firebase, 'owner@example.test', {}, ''), (cause: any) => cause.getStatus() === 403);
  await assert.rejects(saveContactProfile(state.firebase, 'owner@example.test', {}, '082abc4567'), (cause: any) => cause.getStatus() === 400);
  assert.equal(state.counts().writes, 0);
});
test('only central account recovery routes bypass the application gate', () => {
  for (const path of ['/phone-verification/send', '/phone-verification/check', '/auth/me', '/auth/accounts/switch', '/auth/session/logout', '/auth/profile']) assert.equal(isPhoneRecoveryRequest(path), true);
  for (const path of ['/shopyethu/orders', '/auth/shopyethu/session', '/oauth/userinfo', '/phone-verification/check-extra', '/other']) assert.equal(isPhoneRecoveryRequest(path), false);
});
