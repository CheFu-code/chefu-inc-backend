import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationEmailService } from './application-email.service';
import { OrderEmailService } from './order-email.service';
import { ApplicationsService } from './applications.service';
import { MarketplaceService } from './marketplace.service';
import { TestRepository } from './marketplace.testing';
import type { FirestoreMarketplaceRepository } from './marketplace.repository';
import type { Actor, SellerApplication, Storefront, Transaction } from './marketplace.types';

const applicant: Actor = { uid: 'approval-email-test', email: 'applicant@example.test', roles: [] };
const staff: Actor = { uid: 'approval-staff-test', email: 'staff@example.test', roles: ['admin'] };
const fields = {
  businessName: 'Test business', businessType: 'individual', categories: ['Other'],
  contactName: 'Test Contact', phone: '0821234567', phoneConfirmed: true, area: 'Cape Town',
  plans: 'Locally made items for an isolated test.', collectionOffered: false,
};

void test('approval uses its own template, variables and idempotency key with no inline content', async t => {
  const previousKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_unit_test';
  t.after(() => { if (previousKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousKey; });
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(init);
    // Exercise the shared transient-error retry for an approval email.
    return Response.json({}, { status: requests.length === 1 ? 503 : 200 });
  });
  const application: SellerApplication = {
    ...fields, businessType: 'individual', id: applicant.uid, ownerUid: applicant.uid, email: applicant.email,
    status: 'approved', reason: '', response: '', updatedAt: '2026-11-15T08:00:00Z',
    contactName: '<Test>', businessName: 'Test & products',
  };
  const service = new ApplicationEmailService();
  await service.sendApproval(application);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(requests[0].headers, requests[1].headers);
  const payload = JSON.parse(String(requests[0].body));
  assert.equal(payload.from, 'ShopYethu <notifications@chefu.co.za>');
  assert.deepEqual(payload.to, [applicant.email]);
  assert.equal(payload.subject, 'Your ShopYethu seller application is approved');
  assert.equal(payload.template.id, 'seller-account-approval');
  assert.deepEqual(payload.template.variables, {
    CONTACT_NAME: '&lt;Test&gt;', BUSINESS_NAME: 'Test &amp; products', YEAR: '2026',
    APPROVED_AT: new Date(application.updatedAt).toLocaleString('en-ZA', {
      timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short',
    }),
  });
  assert.equal('html' in payload, false); assert.equal('text' in payload, false);
  const key = new Headers(requests[0].headers).get('Idempotency-Key');
  await service.sendApproval(application);
  assert.equal(new Headers(requests[2].headers).get('Idempotency-Key'), key);
  await service.send(application);
  assert.notEqual(new Headers(requests[3].headers).get('Idempotency-Key'), key, 'receipt and approval cannot collide');
  await assert.rejects(service.sendApproval({ ...application, status: 'pending' }), /saved approval/);
  assert.equal(requests.length, 4);
});

void test('only a committed authorized approval sends, after the store exists, and duplicate approval sends nothing', async () => {
  const repo = new TestRepository();
  const sent: SellerApplication[] = [];
  const service = new ApplicationsService(repo, undefined, async application => {
    assert.deepEqual(await repo.get('applications', applicant.uid), application);
    assert.equal((await repo.get<Storefront>('stores', applicant.uid))?.status, 'active');
    sent.push(application);
  });
  await service.submit(applicant, fields);
  assert.equal(sent.length, 0);
  await assert.rejects(service.review(applicant, applicant.uid, { status: 'approved' }));
  await assert.rejects(service.review(staff, 'missing', { status: 'approved' }));
  await service.review(staff, applicant.uid, { status: 'more-info', reason: 'Please describe the products.' });
  assert.equal(sent.length, 0);
  await service.submit(applicant, { ...fields, response: 'The product details are now complete.' });
  const approved = await service.review(staff, applicant.uid, { status: 'approved', email: 'forged@example.test' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, applicant.email);
  assert.equal(sent[0], approved);
  await assert.rejects(service.review(staff, applicant.uid, { status: 'approved' }));
  assert.equal(sent.length, 1);
  const rejectedApplicant = { ...applicant, uid: 'rejected-email-test' };
  await service.submit(rejectedApplicant, fields);
  await service.review(staff, rejectedApplicant.uid, { status: 'rejected', reason: 'Products do not meet requirements.' });
  assert.equal(sent.length, 1);
});

void test('approval survives mail failure; failed database commit sends nothing; transaction retries send once', async () => {
  const repo = new TestRepository();
  await new ApplicationsService(repo).submit(applicant, fields);
  let sent = 0;
  const notify = () => { sent++; return Promise.resolve(); };
  const failed = new ApplicationsService({
    get: repo.get.bind(repo), list: repo.list.bind(repo),
    transaction: () => Promise.reject(new Error('Database failed')),
  }, undefined, notify);
  await assert.rejects(failed.review(staff, applicant.uid, { status: 'approved' }), /Database failed/);
  assert.equal(sent, 0);
  const repeating = new ApplicationsService({
    get: repo.get.bind(repo), list: repo.list.bind(repo),
    transaction: async <T>(work: (tx: Transaction) => Promise<T>) => {
      await work({ get: repo.get.bind(repo), set() {} });
      return repo.transaction(work);
    },
  }, undefined, notify);
  await repeating.review(staff, applicant.uid, { status: 'approved' });
  assert.equal(sent, 1);
  const other = { ...applicant, uid: 'approval-mail-failure-test' };
  const failingMail = new ApplicationsService(repo, undefined, () => Promise.reject(new Error('Resend unavailable')));
  await failingMail.submit(other, fields);
  const result = await failingMail.review(staff, other.uid, { status: 'approved' });
  assert.equal(result.status, 'approved');
  assert.equal((await repo.get<Storefront>('stores', other.uid))?.status, 'active');
});

void test('production marketplace service wires both receipt and approval senders', async t => {
  const repo = new TestRepository();
  const events: string[] = [];
  const email = new ApplicationEmailService();
  t.mock.method(email, 'send', () => { events.push('received'); return Promise.resolve(); });
  t.mock.method(email, 'sendApproval', () => { events.push('approved'); return Promise.resolve(); });
  const service = new MarketplaceService(repo as unknown as FirestoreMarketplaceRepository, email, new OrderEmailService());
  await service.applications.submit(applicant, fields);
  await service.applications.review(staff, applicant.uid, { status: 'approved' });
  assert.deepEqual(events, ['received', 'approved']);
});
