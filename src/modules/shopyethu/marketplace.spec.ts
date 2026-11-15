import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestRepository } from './marketplace.testing';
import { ApplicationsService } from './applications.service';
import { CatalogService } from './catalog.service';
import { OrdersService } from './orders.service';
import { ReportsService } from './reports.service';
import type { Actor } from './marketplace.types';

const buyer: Actor = { uid: 'buyer-test', email: 'buyer@example.test', roles: [] };
const seller: Actor = { uid: 'seller-test', email: 'seller@example.test', roles: [] };
const other: Actor = { uid: 'other-test', email: 'other@example.test', roles: [] };
const staff: Actor = { uid: 'staff-test', email: 'staff@example.test', roles: ['admin'] };
const application = { businessName: 'Test business', contactName: 'Test Contact', email: seller.email, phone: '0123456789', area: 'Test area', plans: 'Items supplied only in an isolated unit test.', businessType: 'individual', categories: ['Other'], phoneConfirmed: true, collectionOffered: false };
const listing = { name: 'Test listing', description: 'This record exists only inside a unit test.', category: 'Other', priceCents: 10000, stock: 3, photos: ['https://example.test/item.jpg'], fulfilment: ['collection'], published: true };
const status = (expected: number) => (error: any) => error.getStatus?.() === expected;

function setup() {
  const repo = new TestRepository();
  return { repo, applications: new ApplicationsService(repo), catalog: new CatalogService(repo), orders: new OrdersService(repo), reports: new ReportsService(repo) };
}
async function approved() {
  const context = setup();
  await context.applications.submit(seller, application);
  await context.applications.review(staff, seller.uid, { status: 'approved' });
  return context;
}

test('application review, more-information response, approval and rejection remain server controlled', async () => {
  const { applications, catalog } = setup();
  const submitted = await applications.submit(seller, { ...application, email: buyer.email, status: 'approved', ownerUid: buyer.uid });
  assert.equal(submitted.status, 'pending'); assert.equal(submitted.ownerUid, seller.uid);
  assert.equal(submitted.email, seller.email);
  await assert.rejects(catalog.mine(seller), status(403));
  await assert.rejects(applications.review(seller, seller.uid, { status: 'approved' }), status(403));
  await assert.rejects(applications.submit(seller, application), status(400));
  await applications.review(staff, seller.uid, { status: 'more-info', reason: 'Please provide operating hours.' });
  await assert.rejects(applications.submit(seller, application), status(400));
  const resubmitted = await applications.submit(seller, { ...application, email: buyer.email, response: 'Weekdays from 9am until 5pm.' });
  assert.equal(resubmitted.email, seller.email);
  await applications.review(staff, seller.uid, { status: 'approved' });
  assert.equal((await catalog.mine(seller)).store.ownerUid, seller.uid);
  await applications.submit(other, { ...application, email: other.email });
  await applications.review(staff, other.uid, { status: 'rejected', reason: 'Business details could not be verified.' });
  assert.equal((await applications.account(other)).application?.reason, 'Business details could not be verified.');
  await assert.rejects(catalog.mine(other), status(403));
});

test('published product -> buyer order -> seller updates -> customer history; retries do not duplicate stock writes', async () => {
  const { catalog, orders, repo } = await approved();
  const product = await catalog.saveProduct(seller, listing);
  assert.equal((await catalog.browse('test', 'Other')).length, 1);
  const body = { items: [{ productId: product.id, quantity: 1, expectedPriceCents: 10000 }], fulfilment: 'collection', contact: buyer.email };
  const [first, retry] = await Promise.all([orders.place(buyer, body, 'same-key-12345678'), orders.place(buyer, body, 'same-key-12345678')]);
  assert.equal(first.id, retry.id); assert.equal((await repo.get<any>('products', product.id)).stock, 2);
  assert.equal(first.paymentStatus, 'not-collected');
  await assert.rejects(orders.confirmPayment(seller, first.id), status(409));
  for (const state of ['accepted', 'preparing', 'ready']) await orders.update(seller, first.id, state);
  await assert.rejects(orders.update(seller, first.id, 'collected'), status(400));
  await assert.rejects(orders.confirmPayment(other, first.id), status(403));
  const paid = await orders.confirmPayment(seller, first.id);
  const paidRetry = await orders.confirmPayment(seller, first.id);
  assert.equal(paid.paymentStatus, 'paid-on-collection');
  assert.equal(paid.paymentReceivedBy, seller.uid);
  assert.equal(paidRetry.paymentReceivedAt, paid.paymentReceivedAt);
  await orders.update(seller, first.id, 'collected');
  const history = await orders.list(buyer);
  assert.equal(history[0].status, 'collected'); assert.equal(history[0].history.length, 5);
  assert.equal(history[0].paymentStatus, 'paid-on-collection');
  assert.equal((await orders.list(other)).length, 0);
  await assert.rejects(orders.place(buyer, { ...body, contact: 'changed@example.test' }, 'same-key-12345678'), status(409));
});

test('checkout rejects stale prices, insufficient stock and unsupported delivery', async () => {
  const { catalog, orders, repo } = await approved();
  const product = await catalog.saveProduct(seller, listing);
  const body = { items: [{ productId: product.id, quantity: 1, expectedPriceCents: 9000 }], fulfilment: 'collection', contact: buyer.email };
  await assert.rejects(orders.place(buyer, body, 'price-key-12345678'), status(409));
  await assert.rejects(orders.place(buyer, { ...body, items: [{ ...body.items[0], expectedPriceCents: 10000, quantity: 4 }] }, 'stock-key-12345678'), status(409));
  await assert.rejects(orders.place(buyer, { ...body, fulfilment: 'local-delivery' }, 'delivery-12345678'), status(400));
  assert.equal((await repo.get<any>('products', product.id)).stock, 3);
  assert.equal((await orders.list(buyer)).length, 0);
});

test('seller ownership, status transitions, cancellation restocking, suspension and report access fail closed', async () => {
  const { catalog, orders, applications, reports, repo } = await approved();
  await applications.submit(other, { ...application, email: other.email });
  await applications.review(staff, other.uid, { status: 'approved' });
  const product = await catalog.saveProduct(seller, listing);
  await assert.rejects(catalog.saveProduct(other, listing, product.id), status(403));
  const order = await orders.place(buyer, { items: [{ productId: product.id, quantity: 1, expectedPriceCents: 10000 }], fulfilment: 'collection', contact: buyer.email }, 'permissions-12345678');
  await assert.rejects(orders.update(other, order.id, 'accepted'), status(403));
  await assert.rejects(orders.update(seller, order.id, 'completed'), status(400));
  await assert.rejects(reports.submit(other, { orderId: order.id, message: 'An unrelated user cannot access the order.' }), status(403));
  assert.equal((await reports.submit(buyer, { orderId: order.id, message: 'Please investigate my order issue.' })).status, 'open');
  await orders.update(seller, order.id, 'cancelled');
  assert.equal((await repo.get<any>('products', product.id)).stock, 3);
  await assert.rejects(orders.update(seller, order.id, 'cancelled'), status(400));
  await applications.suspend(staff, seller.uid, { status: 'suspended', reason: 'Under review' });
  await assert.rejects(catalog.saveProduct(seller, listing), status(403));
  await assert.rejects(catalog.mine(seller), status(403));
  assert.equal((await catalog.browse()).length, 0);
  assert.equal((await applications.account(seller)).store?.status, 'suspended');
});

test('unpublished items cannot be bought, competing buyers cannot oversell stock', async () => {
  const { catalog, orders, repo } = await approved();
  const product = await catalog.saveProduct(seller, { ...listing, stock: 1, published: false });
  const body = { items: [{ productId: product.id, quantity: 1, expectedPriceCents: 10000 }], fulfilment: 'collection', contact: buyer.email };
  await assert.rejects(orders.place(buyer, body, 'draft-key-12345678'), status(409));
  await catalog.saveProduct(seller, { ...listing, stock: 1 }, product.id);
  const result = await Promise.allSettled([orders.place(buyer, body, 'buyer-one-12345678'), orders.place(other, body, 'buyer-two-12345678')]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await repo.get<any>('products', product.id)).stock, 0);
});
