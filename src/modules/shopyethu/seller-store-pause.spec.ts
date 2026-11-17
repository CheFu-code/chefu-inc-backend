import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogService } from './catalog.service';
import { OrdersService } from './orders.service';
import { TestRepository } from './marketplace.testing';
import type { Actor, Storefront } from './marketplace.types';

const seller: Actor = { uid: 'pause-owner', email: 'seller@example.test', roles: [] };
const anotherSeller: Actor = { uid: 'pause-owner', email: 'other@example.test', roles: [] };
const store: Storefront = {
  id: seller.uid,
  ownerUid: seller.uid,
  name: 'Test store',
  description: 'Store description',
  area: 'Cape Town',
  status: 'active',
  reason: '',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

void test('seller pause hides the public store and prevents new orders, then resume restores access', async () => {
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    tx.set('stores', store.id, store);
    tx.set('products', 'test-product', {
      id: 'test-product',
      storeId: store.id,
      ownerUid: seller.uid,
      published: true,
      fulfilment: ['collection'],
      name: 'Test product',
      priceCents: 100,
      stock: 2,
      photos: [],
    });
  });
  const catalog = new CatalogService(repo);
  const orders = new OrdersService(repo);

  const paused = await catalog.setSellerPaused(seller, true);
  assert.equal(paused.sellerPaused, true);
  assert.equal((await catalog.mine(seller)).store.sellerPaused, true);
  assert.equal((await catalog.browse()).length, 0);
  await assert.rejects(catalog.storefront(store.id), error => (error as { getStatus?: () => number }).getStatus?.() === 400);
  await assert.rejects(
    orders.place(
      { uid: 'buyer', email: 'buyer@example.test', roles: [] },
      { items: [{ productId: 'test-product', quantity: 1, expectedPriceCents: 100 }], fulfilment: 'collection', contact: 'buyer@example.test' },
      'paused-store-order-key',
    ),
    error => (error as { getStatus?: () => number }).getStatus?.() === 409,
  );

  const resumed = await catalog.setSellerPaused(seller, false);
  assert.equal(resumed.sellerPaused, false);
  assert.equal((await catalog.storefront(store.id)).store.sellerPaused, false);
  assert.equal((await catalog.browse()).length, 1);
});

void test('only the store owner may pause it and seller actions cannot override staff suspension', async () => {
  const repo = new TestRepository();
  await repo.transaction(async tx => tx.set('stores', store.id, { ...store, ownerUid: 'different-owner' }));
  const catalog = new CatalogService(repo);

  await assert.rejects(catalog.setSellerPaused(anotherSeller, true), error => (error as { getStatus?: () => number }).getStatus?.() === 403);
  await repo.transaction(async tx => tx.set('stores', store.id, store));
  await repo.transaction(async tx => tx.set('stores', store.id, { ...store, status: 'suspended', reason: 'Under review' }));
  await assert.rejects(catalog.setSellerPaused(seller, false), error => (error as { getStatus?: () => number }).getStatus?.() === 403);
  assert.equal((await repo.get<Storefront>('stores', store.id))?.status, 'suspended');
});
