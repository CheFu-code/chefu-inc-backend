import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestRepository } from './marketplace.testing';
import { ApplicationsService } from './applications.service';
import { CatalogService } from './catalog.service';
import { OrdersService } from './orders.service';
import { ReportsService } from './reports.service';
import { ReviewsService } from './reviews.service';
import type { Actor } from './marketplace.types';

const buyer: Actor = { uid: 'buyer-test', email: 'buyer@example.test', roles: [] };
const seller: Actor = { uid: 'seller-test', email: 'seller@example.test', roles: [] };
const other: Actor = { uid: 'other-test', email: 'other@example.test', roles: [] };
const staff: Actor = { uid: 'staff-test', email: 'staff@example.test', roles: ['admin'] };
const application = { businessName: 'Test business', contactName: 'Test Contact', email: seller.email, phone: '0123456789', area: 'Test area', plans: 'Items supplied only in an isolated unit test.', businessType: 'individual', categories: ['Other'], collectionOffered: false };
const listing = { name: 'Test listing', description: 'This record exists only inside a unit test.', category: 'Other', priceCents: 10000, stock: 3, photos: ['https://example.test/item.jpg'], fulfilment: ['collection'], published: true };
const status = (expected: number) => (error: any) => error.getStatus?.() === expected;

function setup() {
  const repo = new TestRepository();
  return { repo, applications: new ApplicationsService(repo), catalog: new CatalogService(repo), orders: new OrdersService(repo), reports: new ReportsService(repo), reviews: new ReviewsService(repo) };
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

void test('seller can return an unpaid collection order from ready to preparing', async () => {
  const { catalog, orders } = await approved();
  const product = await catalog.saveProduct(seller, listing);
  const order = await orders.place(buyer, {
    items: [{ productId: product.id, quantity: 1, expectedPriceCents: listing.priceCents }],
    fulfilment: 'collection',
    contact: buyer.email,
  }, 'ready-backtrack-123456');

  await orders.update(seller, order.id, 'accepted');
  await orders.update(seller, order.id, 'preparing');
  await orders.update(seller, order.id, 'ready');
  const returned = await orders.update(seller, order.id, 'preparing');
  assert.equal(returned.status, 'preparing');
  assert.deepEqual(returned.history.map(event => event.status), [
    'placed', 'accepted', 'preparing', 'ready', 'preparing',
  ]);

  await orders.update(seller, order.id, 'ready');
  await orders.confirmPayment(seller, order.id);
  await assert.rejects(orders.update(seller, order.id, 'preparing'), status(400));
});

void test('only the order buyer and seller can retrieve order details', async () => {
  const { catalog, orders } = await approved();
  const product = await catalog.saveProduct(seller, listing);
  const order = await orders.place(buyer, {
    items: [{ productId: product.id, quantity: 1, expectedPriceCents: listing.priceCents }],
    fulfilment: 'collection',
    contact: buyer.email,
  }, 'private-order-detail-123');

  assert.equal((await orders.getForParty(buyer, order.id)).id, order.id);
  assert.equal((await orders.getForParty(seller, order.id)).id, order.id);
  await assert.rejects(orders.getForParty(other, order.id), status(404));
});

test('only the owning seller can regenerate an order QR and prior QR tokens are revoked', async () => {
  const { catalog, orders } = await approved();
  const product = await catalog.saveProduct(seller, listing);
  const order = await orders.place(buyer, {
    items: [{ productId: product.id, quantity: 1, expectedPriceCents: listing.priceCents }],
    fulfilment: 'collection',
    contact: buyer.email,
  }, 'qr-rotation-order-123');
  const originalToken = order.qrToken || order.reference;

  await orders.assertCurrentQrToken(order.id, originalToken);
  assert.equal((await orders.getForParty(buyer, order.id, originalToken)).id, order.id);
  await assert.rejects(orders.regenerateQrToken(buyer, order.id), status(403));
  await assert.rejects(orders.regenerateQrToken(other, order.id), status(403));

  const updated = await orders.regenerateQrToken(seller, order.id);
  assert.ok(updated.qrToken);
  assert.notEqual(updated.qrToken, originalToken);
  await orders.assertCurrentQrToken(order.id, updated.qrToken!);
  await assert.rejects(orders.assertCurrentQrToken(order.id, originalToken), status(404));
  await assert.rejects(orders.getForParty(buyer, order.id, originalToken), status(404));
  assert.equal(
    (await orders.getForParty(buyer, order.id, updated.qrToken)).qrToken,
    updated.qrToken,
  );
});

test('a successful order locks product identity while leaving price and stock editable', async () => {
  const { catalog, orders, repo } = await approved();
  const product = await catalog.saveProduct(seller, listing);
  const order = await orders.place(buyer, {
    items: [{ productId: product.id, quantity: 1, expectedPriceCents: listing.priceCents }],
    fulfilment: 'collection',
    contact: buyer.email,
  }, 'identity-lock-order-123');
  const ordered = await repo.get<any>('products', product.id);
  assert.equal(ordered.identityLocked, true);

  for (const change of [
    { name: 'A different product' },
    { description: 'This is a different product description.' },
    { category: 'Different category' },
    { photos: ['https://example.test/different-item.jpg'] },
  ]) {
    await assert.rejects(catalog.saveProduct(seller, {
      ...listing,
      ...change,
      expectedUpdatedAt: ordered.updatedAt,
      expectedStock: ordered.stock,
    }, product.id), status(409));
  }

  const saved = await catalog.saveProduct(seller, {
    ...listing,
    priceCents: 12000,
    stock: 7,
    expectedUpdatedAt: ordered.updatedAt,
    expectedStock: ordered.stock,
  }, product.id);
  assert.equal(saved.identityLocked, true);
  assert.equal(saved.priceCents, 12000);
  assert.equal(saved.stock, 7);
  assert.equal(order.items[0].productId, product.id);
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

test('product reviews require the buyer’s completed order, verify item membership and prevent duplicate ratings', async () => {
  const { catalog, orders, reviews, repo } = await approved();
  const product = await catalog.saveProduct(seller, listing);
  const otherProduct = await catalog.saveProduct(seller, { ...listing, name: 'Another listing' });
  const order = await orders.place(buyer, {
    items: [{ productId: product.id, quantity: 1, expectedPriceCents: 10000 }],
    fulfilment: 'collection', contact: buyer.email,
  }, 'review-order-12345678');

  await assert.rejects(reviews.create(buyer, product.id, {
    orderId: order.id, rating: 5, comment: 'Great quality.',
  }), status(409));
  await assert.rejects(reviews.create(other, product.id, {
    orderId: order.id, rating: 5,
  }), status(403));

  for (const state of ['accepted', 'preparing', 'ready']) await orders.update(seller, order.id, state);
  await orders.confirmPayment(seller, order.id);
  await orders.update(seller, order.id, 'collected');
  await assert.rejects(reviews.create(buyer, otherProduct.id, {
    orderId: order.id, rating: 4,
  }), status(400));

  const review = await reviews.create(buyer, product.id, {
    orderId: order.id, rating: 5, comment: 'Great quality.',
  });
  assert.equal(review.verifiedPurchase, true);
  assert.equal((await reviews.list(product.id)).averageRating, 5);
  assert.equal((await reviews.list(product.id)).reviewCount, 1);
  assert.deepEqual((await reviews.reviewedProducts(buyer, order.id)).reviewedProductIds, [product.id]);
  assert.equal((await repo.get<any>('products', product.id)).identityLocked, true);
  await assert.rejects(reviews.create(buyer, product.id, {
    orderId: order.id, rating: 4,
  }), status(409));
  await assert.rejects(reviews.reviewedProducts(other, order.id), status(403));

  const edited = await catalog.saveProduct(seller, { ...listing, stock: 2 }, product.id);
  assert.equal(edited.reviewCount, 1);
  assert.equal(edited.ratingTotal, 5);
  assert.equal((await repo.get<any>('products', product.id)).reviewCount, 1);
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
  repo.writes = 0;
  await applications.suspend(staff, seller.uid, { status: 'suspended', reason: 'Under review' });
  assert.equal(repo.writes, 1);
  repo.writes = 0;
  await applications.suspend(staff, seller.uid, { status: 'suspended', reason: 'Under review' });
  assert.equal(repo.writes, 0, 'repeating the current moderation state must not write');
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
