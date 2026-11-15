import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ApplicationEmailService } from './application-email.service';
import { ApplicationsService } from './applications.service';
import { TestRepository } from './marketplace.testing';
import type { Actor, SellerApplication } from './marketplace.types';

const actor: Actor = { uid: 'email-test-applicant', email: 'applicant@example.test', roles: [] };
const staff: Actor = { uid: 'email-test-admin', email: 'staff@example.test', roles: ['admin'] };
const fields = {
  businessName: 'Test business & products', businessType: 'individual', categories: ['Other'],
  contactName: 'Test Contact', phone: '0821234567', phoneConfirmed: true, area: 'Cape Town',
  plans: 'Locally made products for this isolated test.', collectionOffered: false,
};
const record = (): SellerApplication => ({
  ...fields, businessType: 'individual', id: actor.uid, ownerUid: actor.uid, email: actor.email,
  status: 'pending', updatedAt: '2026-11-15T08:15:00Z', reason: '', response: '',
});

function configure(t: TestContext) {
  for (const [key, value] of Object.entries({ RESEND_API_KEY: 're_test_only' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

void test('confirmation uses only the published Resend template and escaped variables; retries keep one event identity', async t => {
  configure(t);
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails');
    requests.push(init);
    return Response.json({ id: 'test-email' });
  });
  const email = new ApplicationEmailService();
  const application = { ...record(), contactName: '<b>Test</b>', businessName: 'Test & "Products"' };
  await email.send(application);
  await email.send(application);
  const body = JSON.parse(String(requests[0].body));
  assert.equal(body.from, 'ShopYethu <notifications@chefu.co.za>');
  assert.deepEqual(body.to, [actor.email]);
  assert.equal(body.subject, 'We received your ShopYethu seller application');
  assert.equal(body.template.id, 'seller-application-received');
  assert.equal(body.template.variables.CONTACT_NAME, '&lt;b&gt;Test&lt;/b&gt;');
  assert.equal(body.template.variables.BUSINESS_NAME, 'Test &amp; &quot;Products&quot;');
  assert.equal(body.template.variables.SUBMITTED_AT, new Date(application.updatedAt).toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short',
  }));
  assert.equal(body.template.variables.YEAR, '2026');
  assert.equal('html' in body, false); assert.equal('text' in body, false);
  const key = (request: RequestInit) => new Headers(request.headers).get('Idempotency-Key');
  assert.equal(key(requests[0]), key(requests[1]));
  await email.send({ ...application, updatedAt: '2026-11-16T08:15:00Z' });
  assert.notEqual(key(requests[0]), key(requests[2]), 'resubmissions get a new key');
  assert.ok(requests[0].signal);
});

void test('transient failure retries an identical payload; invalid templates and rate limits do not loop', async t => {
  configure(t);
  const requests: RequestInit[] = [];
  let status = 503;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(init);
    if (requests.length === 1) throw new Error('Temporary network failure');
    return Response.json({}, { status });
  });
  const email = new ApplicationEmailService();
  await assert.rejects(email.send(record()), /HTTP 503/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(requests[0].headers, requests[1].headers);
  assert.equal(JSON.parse(String(requests[0].body)).template.id, 'seller-application-received');
  for (status of [404, 422, 429]) {
    const before: number = requests.length;
    await assert.rejects(email.send(record()), new RegExp(`HTTP ${status}`));
    assert.equal(requests.length, before + 1);
  }
});

void test('only committed applications send to the authenticated email; rejected and duplicate submissions send nothing', async () => {
  const repo = new TestRepository();
  const sent: SellerApplication[] = [];
  const service = new ApplicationsService(repo, async application => {
    assert.deepEqual(await repo.get('applications', actor.uid), application, 'record is already committed');
    sent.push(application);
  });
  await assert.rejects(service.submit(actor, { ...fields, businessName: '' }));
  assert.equal(sent.length, 0);
  await service.submit(actor, { ...fields, email: 'forged@example.test' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, actor.email);
  await assert.rejects(service.submit(actor, fields));
  assert.equal(sent.length, 1);
  await service.review(staff, actor.uid, { status: 'more-info', reason: 'Describe your products in more detail.' });
  await service.submit(actor, { ...fields, response: 'Updated my product description.' });
  assert.equal(sent.length, 2);
});

void test('transaction callback retries send once, failed commits never send, and mail failure does not roll back an application', async () => {
  const repo = new TestRepository();
  let sent = 0;
  const repeating = {
    get: repo.get.bind(repo), list: repo.list.bind(repo),
    transaction: async <T>(work: Parameters<TestRepository['transaction']>[0]): Promise<T> => {
      await work({ get: async () => null, set() {} }); // Firestore's discarded first attempt.
      return repo.transaction(work) as Promise<T>;
    },
  };
  const service = new ApplicationsService(repeating, () => { sent++; return Promise.resolve(); });
  await service.submit(actor, fields);
  assert.equal(sent, 1);
  const failing = new ApplicationsService({ ...repeating, transaction: () => Promise.reject(new Error('Commit failed')) }, () => { sent++; return Promise.resolve(); });
  await assert.rejects(failing.submit({ ...actor, uid: 'other-test' }, fields), /Commit failed/);
  assert.equal(sent, 1);
  const savedDespiteMail = new ApplicationsService(repo, () => Promise.reject(new Error('Provider unavailable')));
  const result = await savedDespiteMail.submit({ ...actor, uid: 'mail-failure-test' }, fields);
  assert.equal(result.status, 'pending');
  assert.equal((await repo.get<SellerApplication>('applications', result.id))?.status, 'pending');
});
