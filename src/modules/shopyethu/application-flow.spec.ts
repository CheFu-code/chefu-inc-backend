import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationsService } from './applications.service';
import { applicationFields, applicationHistory } from './application.validation';
import { TestRepository } from './marketplace.testing';
import type { Actor, SellerApplication, Storefront } from './marketplace.types';

const applicant: Actor = { uid: 'application-test', email: 'owner@example.test', roles: [] };
const staff: Actor = { uid: 'staff-test', email: 'staff@example.test', roles: ['admin'] };
const fields = {
  businessName: 'Unit test business', businessType: 'individual', categories: ['Other', 'Home & Living'],
  contactName: 'Test Contact', phone: '+27 82 123 4567', phoneConfirmed: true, area: 'Test operating area',
  plans: 'Products described only for isolated unit tests.', collectionOffered: true,
  collectionArea: 'Test pickup suburb', pickupHours: 'Weekdays 09:00–17:00',
};
const badRequest = (error: any) => error.getStatus?.() === 400;

void test('application fields are validated server-side and invalid submissions never write', async () => {
  const repo = new TestRepository();
  const service = new ApplicationsService(repo);
  for (const change of [
    { businessType: 'unknown' }, { businessType: ['individual'] }, { categories: [] }, { categories: ['Other', 'Other'] },
    { businessType: 'registered-business' },
    { categories: ['unsupported'] }, { phoneConfirmed: false }, { phoneConfirmed: 'true' },
    { phone: 'call me later' }, { phone: '123' }, { phone: '1234567' }, { phone: '082123456' },
    { phone: '08212345678' }, { phone: '0000000000' }, { phone: '+27 082 123 4567' },
    { phone: '+999123456789' }, { phone: '+44 20 7946 0958' }, { phone: '0821234567 ext 1' }, { collectionOffered: null },
    { collectionArea: '' }, { pickupHours: '' },
  ]) await assert.rejects(service.submit(applicant, { ...fields, ...change }), badRequest);
  assert.equal((await service.account(applicant)).application, null);
});

void test('Google operating areas are verified and only their Place ID is persisted', async () => {
  const repo = new TestRepository();
  const placeId = 'ChIJcapeTown';
  const sessionToken = '123e4567-e89b-12d3-a456-426614174000';
  const resolutions: unknown[][] = [];
  const places = {
    resolve: async (...args: unknown[]) => {
      resolutions.push(args);
      return { placeId, label: 'Cape Town, South Africa' };
    },
  };
  const service = new ApplicationsService(repo, undefined, undefined, places);
  const submitted = await service.submit(applicant, {
    ...fields,
    area: 'Cape Town, South Africa',
    areaPlaceId: placeId,
    areaSessionToken: sessionToken,
  });
  const stored = await repo.get<SellerApplication>('applications', applicant.uid);
  assert.deepEqual(resolutions, [[placeId, sessionToken]]);
  assert.equal(stored?.area, '');
  assert.equal(stored?.areaPlaceId, placeId);
  assert.equal(submitted.area, '');
  await service.review(staff, applicant.uid, { status: 'approved' });
  const store = await repo.get<Storefront>('stores', applicant.uid);
  assert.equal(store?.area, '');
  assert.equal(store?.areaPlaceId, placeId);
  assert.equal(store?.verified, false);
});

void test('registered businesses must submit a certificate owned by their account', async () => {
  const certificateId = `shopyethu-applications/${applicant.uid}/123e4567-e89b-12d3-a456-426614174000.pdf`;
  const valid = applicationFields(applicant, {
    ...fields,
    businessType: 'registered-business',
    cipcCertificateId: certificateId,
    cipcCertificateFormat: 'pdf',
  });
  assert.equal(valid.cipcCertificateId, certificateId);
  assert.equal(valid.cipcCertificateFormat, 'pdf');
  for (const change of [
    { cipcCertificateId: '' },
    { cipcCertificateId: 'shopyethu-applications/someone-else/123e4567-e89b-12d3-a456-426614174000.pdf' },
    { cipcCertificateFormat: 'exe' },
  ]) {
    assert.throws(
      () => applicationFields(applicant, {
        ...fields,
        businessType: 'registered-business',
        cipcCertificateId: certificateId,
        cipcCertificateFormat: 'pdf',
        ...change,
      }),
      badRequest,
    );
  }
});

void test('approved registered-business storefronts persist their verified badge status', async () => {
  const repo = new TestRepository();
  const service = new ApplicationsService(repo);
  const certificateId = `shopyethu-applications/${applicant.uid}/123e4567-e89b-12d3-a456-426614174000.pdf`;
  await service.submit(applicant, {
    ...fields,
    businessType: 'registered-business',
    cipcCertificateId: certificateId,
    cipcCertificateFormat: 'pdf',
  });
  await service.review(staff, applicant.uid, { status: 'approved' });
  const store = await repo.get<Storefront>('stores', applicant.uid);
  assert.equal(store?.verified, true);
});

void test('application contact numbers use canonical international format without changing verification status', () => {
  for (const [input, expected] of [
    ['082 123 4567', '+27821234567'], ['(011) 234-5678', '+27112345678'],
    ['+27 82 123 4567', '+27821234567'],
  ]) {
    const result = applicationFields(applicant, { ...fields, phone: input });
    assert.equal(result.phone, expected);
    assert.equal('phoneVerifiedAt' in result, false);
  }
});

void test('server owns email, approval and timeline; review and resubmission preserve submission date', async () => {
  const repo = new TestRepository();
  const service = new ApplicationsService(repo);
  const submitted = await service.submit(applicant, {
    ...fields, email: 'forged@example.test', status: 'approved', ownerUid: staff.uid,
    history: [{ status: 'approved', at: '1900-01-01' }], createdAt: '1900-01-01', contactConfirmedAt: '1900-01-01',
  });
  assert.equal(submitted.email, applicant.email);
  assert.equal(submitted.phone, '+27821234567');
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

void test('optional collection fields are discarded when collection is declined; old records stay reviewable', async () => {
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

void test('application history remains bounded without accepting client events', () => {
  const previous = { status: 'pending', updatedAt: '2026-01-01', reason: '', history: Array.from({ length: 100 }, (_, index) => ({ status: 'pending', at: String(index) })) } as SellerApplication;
  const history = applicationHistory(previous, { status: 'more-info', at: 'server-time', reason: 'Please clarify.' });
  assert.equal(history.length, 100); assert.equal(history[0].at, '1');
  assert.equal(history[99].at, 'server-time');
});
