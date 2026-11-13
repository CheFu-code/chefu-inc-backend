import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationsService } from './applications.service';
import { applicationHistory } from './application.validation';
import { TestRepository } from './marketplace.testing';
import type { Actor, SellerApplication } from './marketplace.types';

const applicant: Actor = { uid: 'application-test', email: 'owner@example.test', roles: [] };
const staff: Actor = { uid: 'staff-test', email: 'staff@example.test', roles: ['admin'] };
const fields = {
  businessName: 'Unit test business', businessType: 'individual', categories: ['Other', 'Home & Living'],
  contactName: 'Test Contact', phone: '+27 82 123 4567', phoneConfirmed: true, area: 'Test operating area',
  plans: 'Products described only for isolated unit tests.', collectionOffered: true,
  collectionArea: 'Test pickup suburb', pickupHours: 'Weekdays 09:00–17:00',
};
const badRequest = (error: any) => error.getStatus?.() === 400;

test('application fields are validated server-side and invalid submissions never write', async () => {
  const repo = new TestRepository();
  const service = new ApplicationsService(repo);
  for (const change of [
    { businessType: 'unknown' }, { businessType: ['individual'] }, { categories: [] }, { categories: ['Other', 'Other'] },
    { categories: ['unsupported'] }, { phoneConfirmed: false }, { phoneConfirmed: 'true' },
    { phone: 'call me later' }, { phone: '123' }, { collectionOffered: null },
    { collectionArea: '' }, { pickupHours: '' },
  ]) await assert.rejects(service.submit(applicant, { ...fields, ...change }), badRequest);
  assert.equal((await service.account(applicant)).application, null);
});

test('server owns email, approval and timeline; review and resubmission preserve submission date', async () => {
  const repo = new TestRepository();
  const service = new ApplicationsService(repo);
  const submitted = await service.submit(applicant, {
    ...fields, email: 'forged@example.test', status: 'approved', ownerUid: staff.uid,
    history: [{ status: 'approved', at: '1900-01-01' }], createdAt: '1900-01-01', contactConfirmedAt: '1900-01-01',
  });
  assert.equal(submitted.email, applicant.email);
  assert.equal(submitted.ownerUid, applicant.uid);
  assert.equal(submitted.status, 'pending');
  assert.equal(submitted.history?.length, 1);
  assert.equal(submitted.createdAt, submitted.updatedAt);
  assert.equal(submitted.contactConfirmedAt, submitted.updatedAt);
  const requested = await service.review(staff, applicant.uid, { status: 'more-info', reason: 'Please clarify pickup availability.' });
  assert.equal(requested.history?.[1].reason, 'Please clarify pickup availability.');
  const response = 'Pickup is available on weekdays only.';
  await assert.rejects(service.submit(applicant, { ...fields, response: '' }), badRequest);
  const resubmitted = await service.submit(applicant, { ...fields, response });
  assert.equal(resubmitted.createdAt, submitted.createdAt);
  assert.equal(resubmitted.history?.[2].response, response);
  assert.equal(resubmitted.status, 'pending');
  const approved = await service.review(staff, applicant.uid, { status: 'approved', reason: 'Welcome to the marketplace.' });
  assert.deepEqual(approved.history?.map(event => event.status), ['pending', 'more-info', 'pending', 'approved']);
  const account = await service.account(applicant);
  assert.equal(account.store?.status, 'active');
  assert.equal('phone' in account.store!, false);
  assert.equal('email' in account.store!, false);
  assert.equal('collectionArea' in account.store!, false);
});

test('optional collection fields are discarded when collection is declined; old records stay reviewable', async () => {
  const repo = new TestRepository();
  const service = new ApplicationsService(repo);
  const first = await service.submit(applicant, { ...fields, collectionOffered: false, collectionArea: { invalid: true }, pickupHours: null });
  assert.equal(first.collectionArea, ''); assert.equal(first.pickupHours, '');
  const legacy = { ...first, status: 'more-info', reason: 'Please update your contact details.', updatedAt: '2026-01-01T12:00:00.000Z' } as SellerApplication;
  delete legacy.createdAt; delete legacy.history; delete legacy.businessType;
  await repo.transaction(async tx => { tx.set('applications', applicant.uid, legacy); });
  const resubmitted = await service.submit(applicant, { ...fields, response: 'My current contact details are included.' });
  assert.equal(resubmitted.createdAt, undefined);
  assert.equal(resubmitted.history?.[0].at, legacy.updatedAt);
  assert.equal(resubmitted.history?.[0].status, 'more-info');
  assert.equal(resubmitted.history?.length, 2);
  await service.review(staff, applicant.uid, { status: 'approved' });
});

test('application history remains bounded without accepting client events', () => {
  const previous = { status: 'pending', updatedAt: '2026-01-01', reason: '', history: Array.from({ length: 100 }, (_, index) => ({ status: 'pending', at: String(index) })) } as SellerApplication;
  const history = applicationHistory(previous, { status: 'more-info', at: 'server-time', reason: 'Please clarify.' });
  assert.equal(history.length, 100); assert.equal(history[0].at, '1');
  assert.equal(history[99].at, 'server-time');
});
