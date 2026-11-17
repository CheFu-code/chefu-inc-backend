import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogService } from './catalog.service';
import { OrdersService } from './orders.service';
import { TestRepository } from './marketplace.testing';
import { MarketplaceCustomerController } from './marketplace.controller';
import { MarketplaceAuthGuard } from './marketplace-auth.guard';
import type { Actor, Product, Storefront } from './marketplace.types';
import { FirestoreMarketplaceRepository } from './marketplace.repository';

const owner: Actor = { uid: 'action-owner', email: 'owner@example.test', roles: [] };
const other: Actor = { uid: 'action-other', email: 'other@example.test', roles: [] };
const buyer: Actor = { uid: 'action-buyer', email: 'buyer@example.test', roles: [] };
const fields = { name: 'Test listing', description: 'Only used for isolated automated tests.', category: 'Other',
  priceCents: 2500, stock: 8, photos: ['https://example.test/product.jpg'], published: true, fulfilment: ['collection'] };
const status = (expected: number) => (cause: any) => cause.getStatus?.() === expected;
async function setup() {
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    for (const actor of [owner, other]) tx.set('stores', actor.uid, { id: actor.uid, ownerUid: actor.uid, status: 'active', name: 'Test store', area: 'Test area' });
  });
  const catalog = new CatalogService(repo), orders = new OrdersService(repo);
  const product = await catalog.saveProduct(owner, fields, undefined, 'product-actions-create');
  return { repo, catalog, orders, product, body: { items: [{ productId: product.id, quantity: 2, expectedPriceCents: fields.priceCents }], fulfilment: 'collection', contact: 'buyer@example.test', address: '' } };
}

void test('a product owner cannot order from their own store or consume its stock', async () => {
  const { repo, orders, product, body } = await setup();
  await assert.rejects(
    orders.place(owner, { ...body, contact: owner.email }, 'self-order-owner-12345'),
    status(409),
  );
  assert.equal((await repo.get<Product>('products', product.id))?.stock, fields.stock);
  assert.equal((await orders.list(owner)).length, 0);
});

void test('moving to draft changes only publication and a repeated action adds no writes', async () => {
  const { repo, catalog, orders, product, body } = await setup();
  await orders.place(buyer, body, 'draft-checkout-12345');
  const current = (await repo.get<Product>('products', product.id))!;
  const draft = await catalog.draftProduct(owner, product.id);
  assert.deepEqual({ ...draft, published: current.published, updatedAt: current.updatedAt }, current);
  assert.equal(draft.stock, 6); assert.equal(draft.published, false);
  const writes = repo.writes;
  assert.deepEqual(await catalog.draftProduct(owner, product.id), draft);
  assert.equal(repo.writes, writes);
  assert.equal((await catalog.browse()).length, 0);
  assert.equal((await catalog.page()).products.length, 0);
  assert.equal((await catalog.mine(owner)).products[0].published, false);
  assert.equal((await catalog.ownProduct(owner, product.id)).product.id, product.id);
  await assert.rejects(catalog.product(product.id), status(400));
  await assert.rejects(orders.place(buyer, body, 'cannot-order-draft-123'), status(409));
});

void test('drafts remain editable and can be published again through the normal validated save', async () => {
  const { catalog, product } = await setup();
  const draft = await catalog.draftProduct(owner, product.id);
  const published = await catalog.saveProduct(owner, { ...fields, expectedUpdatedAt: draft.updatedAt, expectedStock: draft.stock }, product.id);
  assert.equal(published.published, true);
  assert.equal((await catalog.product(product.id)).product.id, product.id);
});

void test('deleting removes the listing, preserves order snapshots and prevents replay or stale edits from recreating it', async () => {
  const { repo, catalog, orders, product, body } = await setup();
  const order = await orders.place(buyer, body, 'delete-order-123456');
  const receipt = await catalog.deleteProduct(owner, product.id);
  assert.equal(receipt.deleted, true); assert.equal(receipt.id, product.id);
  assert.equal(await repo.get('products', product.id), null);
  assert.equal((await catalog.mine(owner)).products.length, 0);
  assert.equal((await catalog.browse()).length, 0);
  assert.deepEqual((await orders.list(buyer))[0], order);
  assert.equal((await orders.list(owner, true))[0].items[0].photo, fields.photos[0]);
  const writes = repo.writes;
  assert.deepEqual(await catalog.deleteProduct(owner, product.id), receipt);
  assert.equal(repo.writes, writes, 'retry uses the deletion receipt without another write');
  await assert.rejects(catalog.ownProduct(owner, product.id), status(404));
  await assert.rejects(catalog.draftProduct(owner, product.id), status(404));
  await assert.rejects(catalog.saveProduct(owner, fields, product.id), status(404));
  await assert.rejects(catalog.saveProduct(owner, fields, undefined, 'product-actions-create'), status(404));
  await assert.rejects(orders.place(buyer, body, 'deleted-new-order-123'), status(409));
  assert.equal((await orders.place(buyer, body, 'delete-order-123456')).id, order.id, 'confirmed order replay still works');
  await orders.update(owner, order.id, 'cancelled');
  assert.equal(await repo.get('products', product.id), null, 'cancellation does not restore a deleted listing');
});

void test('ownership, suspension and missing seller approval are checked on every action and retry', async () => {
  const { repo, catalog, product } = await setup();
  let writes = repo.writes;
  for (const action of [catalog.draftProduct.bind(catalog), catalog.deleteProduct.bind(catalog)]) {
    await assert.rejects(action(other, product.id), status(403));
    await assert.rejects(action(buyer, product.id), status(403));
  }
  assert.equal(repo.writes, writes);
  const store = (await repo.get<Storefront>('stores', owner.uid))!;
  await repo.transaction(async tx => { tx.set('stores', owner.uid, { ...store, status: 'suspended' }); });
  writes = repo.writes;
  await assert.rejects(catalog.deleteProduct(owner, product.id), status(403));
  await assert.rejects(catalog.draftProduct(owner, product.id), status(403));
  assert.equal(repo.writes, writes);
  await repo.transaction(async tx => { tx.set('stores', owner.uid, store); });
  await catalog.deleteProduct(owner, product.id);
  await assert.rejects(catalog.deleteProduct(other, product.id), status(403));
  await assert.rejects(catalog.deleteProduct(owner, 'unknown-product'), status(404));
});

void test('a concurrent checkout and deletion leave no oversold or resurrected listing', async () => {
  const { repo, catalog, orders, product, body } = await setup();
  const [placed, deleted] = await Promise.all([
    orders.place(buyer, body, 'concurrent-delete-order'), catalog.deleteProduct(owner, product.id),
  ]);
  assert.equal(deleted.id, product.id); assert.equal(placed.items[0].quantity, 2);
  assert.equal(await repo.get('products', product.id), null);
  await orders.update(owner, placed.id, 'accepted');
  await orders.update(owner, placed.id, 'preparing');
  await orders.update(owner, placed.id, 'ready');
  await orders.confirmPayment(owner, placed.id);
  await orders.update(owner, placed.id, 'collected');
  assert.equal((await orders.list(buyer))[0].status, 'collected');
});

void test('seller mutations inherit marketplace authentication and use the intended methods', () => {
  assert.ok(Reflect.getMetadata('__guards__', MarketplaceCustomerController).includes(MarketplaceAuthGuard));
  assert.equal(Reflect.getMetadata('path', MarketplaceCustomerController.prototype.sellerStoreStatus), 'seller/store/status');
  assert.equal(Reflect.getMetadata('method', MarketplaceCustomerController.prototype.sellerStoreStatus), 2); // PUT
  assert.equal(Reflect.getMetadata('path', MarketplaceCustomerController.prototype.draftProduct), 'seller/products/:id/draft');
  assert.equal(Reflect.getMetadata('method', MarketplaceCustomerController.prototype.draftProduct), 2); // PUT
  assert.equal(Reflect.getMetadata('path', MarketplaceCustomerController.prototype.deleteProduct), 'seller/products/:id');
  assert.equal(Reflect.getMetadata('method', MarketplaceCustomerController.prototype.deleteProduct), 3); // DELETE
});

void test('a committed Firestore delete invalidates the public product cache', async () => {
  let reads = 0, removed = false;
  const query: any = {
    where: () => query, limit: () => query,
    get: async () => { reads++; return { docs: removed ? [] : [{ data: () => ({ id: 'product' }) }] }; },
  };
  const repo = new FirestoreMarketplaceRepository({ db: () => ({
    collection: (table: string) => ({ ...query, doc: (id: string) => ({ path: `${table}/${id}` }) }),
    runTransaction: async (work: any) => work({ delete(ref: { path: string }) {
      assert.equal(ref.path, 'shopyethu_products/product'); removed = true;
    } }),
  }) } as any);
  await repo.list('products', [['published', 'true']]);
  await repo.list('products', [['published', 'true']]);
  assert.equal(reads, 1);
  await repo.transaction(async tx => { tx.delete('products', 'product'); });
  assert.equal((await repo.list('products', [['published', 'true']])).length, 0);
  assert.equal(reads, 2);
});
