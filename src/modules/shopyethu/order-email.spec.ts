import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { OrderEmailService, type OrderConfirmation } from './order-email.service';
import { OrdersService } from './orders.service';
import { MarketplaceService } from './marketplace.service';
import { ApplicationEmailService } from './application-email.service';
import { TestRepository } from './marketplace.testing';
import type { FirestoreMarketplaceRepository } from './marketplace.repository';
import type { Actor, Order, Product, Transaction } from './marketplace.types';

const buyer: Actor = { uid: 'mail-buyer-test', email: 'buyer@example.test', roles: [] };
const receipt = (): OrderConfirmation => ({
  recipientEmail: buyer.email, storeName: '<Test & store>', collectionArea: 'Cape Town',
  order: {
    id: 'order-unit-test-id', reference: 'SY-A1B2C3D4', buyerUid: buyer.uid, sellerUid: 'seller', storeId: 'seller',
    items: [{ productId: 'test-product', name: 'Test & <product>', quantity: 2, priceCents: 12500, photo: '' }],
    subtotalCents: 25000, deliveryCents: 0, totalCents: 25000, fulfilment: 'collection', address: '',
    contact: 'editable-contact@example.test', status: 'placed', paymentStatus: 'not-collected',
    paymentNote: 'Payment due on collection.', createdAt: '2026-11-15T08:30:00Z', updatedAt: '2026-11-15T08:30:00Z',
    history: [{ status: 'placed', at: '2026-11-15T08:30:00Z' }],
  },
});
async function setup() {
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    tx.set('stores', 'seller', { id: 'seller', ownerUid: 'seller', name: 'Test store', area: 'Cape Town', status: 'active' });
    tx.set('products', 'p', { id: 'p', storeId: 'seller', published: true, fulfilment: ['collection'], name: 'Test item', priceCents: 1000, stock: 5, photos: [] });
  });
  const body = { items: [{ productId: 'p', quantity: 1, expectedPriceCents: 1000 }], fulfilment: 'collection',
    contact: 'editable-contact@example.test', email: 'forged@example.test' };
  return { repo, body };
}

void test('order mail sends only a hosted template with escaped saved details and the collection code', async t => {
  const previous = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 're_unit_test_only';
  t.after(() => { if (previous === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous; });
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails'); requests.push(init);
    return Response.json({ id: 'unit-test-email' }, { status: requests.length === 1 ? 503 : 200 });
  });
  const service = new OrderEmailService(), saved = receipt();
  await service.send(saved);
  assert.equal(requests.length, 2); assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(requests[0].headers, requests[1].headers);
  const payload = JSON.parse(String(requests[0].body));
  assert.deepEqual(payload.to, [buyer.email]); assert.equal(payload.from, 'ShopYethu <notifications@chefu.co.za>');
  assert.equal(payload.subject, 'Order SY-A1B2C3D4 confirmed · ShopYethu');
  assert.equal(payload.template.id, 'shopyethu-order-confirmation');
  assert.equal(payload.template.variables.ORDER_CODE, saved.order.reference);
  assert.equal(payload.template.variables.ORDER_ID, saved.order.id);
  assert.equal(payload.template.variables.STORE_NAME, '&lt;Test &amp; store&gt;');
  assert.match(payload.template.variables.ITEMS_SUMMARY, /2 × Test &amp; &lt;product&gt;/);
  assert.match(payload.template.variables.ORDER_TOTAL, /250[.,]00/);
  assert.equal(payload.template.variables.PLACED_AT, new Date(saved.order.createdAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }));
  assert.equal(payload.template.variables.YEAR, '2026');
  for (const field of ['html', 'text', 'react']) assert.equal(field in payload, false);
  assert.equal(new Headers(requests[0].headers).get('Idempotency-Key'), `shopyethu-order-confirmation/${saved.order.id}`);
  assert.ok(requests[0].signal);
});

void test('long hostile item names fit template variables, remain escaped and disclose omitted items', async t => {
  const previous = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 're_unit_test_only';
  t.after(() => { if (previous === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous; });
  let payload: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { payload = JSON.parse(String(init.body)); return Response.json({ id: 'unit-test-email' }); });
  const saved = receipt(); saved.order.items = Array.from({ length: 30 }, (_, index) => ({ ...saved.order.items[0], productId: String(index), name: '<&"'.repeat(40) }));
  await new OrderEmailService().send(saved);
  const variables = payload.template.variables;
  for (const value of Object.values(variables)) assert.ok(typeof value === 'string' && value.length <= 2000);
  assert.match(variables.ITEMS_SUMMARY, /more items/); assert.equal(variables.ITEMS_SUMMARY.includes('<'), false);
  await assert.rejects(new OrderEmailService().send({ ...saved, order: { ...saved.order, status: 'ready' } }), /newly placed/);
});

void test('new committed orders notify the authenticated buyer once; parallel retries and rejected orders do not resend', async () => {
  const { repo, body } = await setup(), sent: OrderConfirmation[] = [];
  const service = new OrdersService(repo, async value => {
    assert.deepEqual(await repo.get('orders', value.order.id), value.order, 'order already exists when sending');
    sent.push(value);
  });
  const [first, second] = await Promise.all([service.place(buyer, body, 'same-email-test-key'), service.place(buyer, body, 'same-email-test-key')]);
  assert.equal(first.id, second.id); assert.equal(sent.length, 1);
  assert.equal(sent[0].recipientEmail, buyer.email); assert.equal(sent[0].storeName, 'Test store');
  assert.equal(sent[0].collectionArea, 'Cape Town'); assert.equal(sent[0].order.reference, first.reference);
  await service.place(buyer, body, 'same-email-test-key'); assert.equal(sent.length, 1);
  await assert.rejects(service.place(buyer, { ...body, items: [{ productId: 'p', quantity: 1, expectedPriceCents: 1 }] }, 'invalid-email-test-key'));
  assert.equal(sent.length, 1); assert.equal((await repo.get<Product>('products', 'p'))?.stock, 4);
});

void test('database callback retries send once; a failed commit never sends and mail failure leaves the order valid', async () => {
  const { repo, body } = await setup(); let sent = 0;
  const repeating = { get: repo.get.bind(repo), list: repo.list.bind(repo),
    transaction: async <T>(work: (tx: Transaction) => Promise<T>) => {
      await work({ get: repo.get.bind(repo), set() {}, delete() { assert.fail('Checkout must not delete records'); } }); // Discarded Firestore attempt.
      return repo.transaction(work);
    },
  };
  const repeated = new OrdersService(repeating, async () => { sent++; });
  await repeated.place(buyer, body, 'transaction-email-key'); assert.equal(sent, 1);
  const failed = new OrdersService({ ...repeating, transaction: async () => { throw new Error('Commit failed'); } }, async () => { sent++; });
  await assert.rejects(failed.place(buyer, body, 'failed-email-key-123'), /Commit failed/); assert.equal(sent, 1);
  const failingMail = new OrdersService(repo, async () => { sent++; throw new Error('Provider unavailable'); });
  const order = await failingMail.place(buyer, body, 'mail-failure-key-123');
  assert.equal((await repo.get<Order>('orders', order.id))?.status, 'placed');
  assert.equal((await repo.get<Product>('products', 'p'))?.stock, 3);
  await failingMail.place(buyer, body, 'mail-failure-key-123'); assert.equal(sent, 2);
});

void test('production service wires the order sender and the hosted HTML uses exactly the sent variables', async t => {
  const { repo, body } = await setup(), email = new OrderEmailService();
  const sent: OrderConfirmation[] = [];
  t.mock.method(email, 'send', async (value: OrderConfirmation) => { sent.push(value); });
  const service = new MarketplaceService(repo as unknown as FirestoreMarketplaceRepository, new ApplicationEmailService(), email);
  const order = await service.orders.place(buyer, body, 'wiring-email-key-123');
  assert.equal(sent[0].order.id, order.id);
  const html = readFileSync('docs/shopyethu-order-confirmation.html', 'utf8');
  const variables = [...new Set([...html.matchAll(/\{\{\{([A-Z_]+)\}\}\}/g)].map(match => match[1]))].sort();
  assert.deepEqual(variables, ['ORDER_CODE', 'ORDER_ID', 'STORE_NAME', 'COLLECTION_AREA', 'ITEMS_SUMMARY', 'ORDER_TOTAL', 'PLACED_AT', 'YEAR'].sort());
  assert.match(html, /Wait until your order is marked/); assert.match(html, /No online payment has been collected/);
});

void test('invalid hosted templates and rate limits do not retry, while network failures retry with the same key', async t => {
  const previous = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 're_unit_test_only';
  t.after(() => { if (previous === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous; });
  const requests: RequestInit[] = []; let status = 422;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests.push(init); if (!status) throw new Error('Network failure'); return Response.json({}, { status }); });
  const service = new OrderEmailService();
  for (status of [404, 422, 429]) {
    const before = requests.length;
    await assert.rejects(service.send(receipt()), new RegExp(`HTTP ${status}`)); assert.equal(requests.length, before + 1);
  }
  status = 0; const before = requests.length;
  await assert.rejects(service.send(receipt()), /could not reach/); assert.equal(requests.length, before + 2);
  assert.equal(requests[before].body, requests[before + 1].body); assert.deepEqual(requests[before].headers, requests[before + 1].headers);
});
