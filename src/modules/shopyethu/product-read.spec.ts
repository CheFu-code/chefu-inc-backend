import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogService } from './catalog.service';
import { TestRepository } from './marketplace.testing';

test('single-product editing requires an active owner, including access to private drafts', async () => {
  const repo = new TestRepository();
  const catalog = new CatalogService(repo);
  const owner = { uid: 'read-owner', email: 'owner@example.test', roles: [] };
  const other = { uid: 'read-other', email: 'other@example.test', roles: [] };
  await repo.transaction(async tx => {
    for (const actor of [owner, other]) tx.set('stores', actor.uid, { id: actor.uid, ownerUid: actor.uid, status: 'active' });
    tx.set('products', 'private-product', { id: 'private-product', ownerUid: owner.uid, storeId: owner.uid, published: false });
  });
  assert.equal((await catalog.ownProduct(owner, 'private-product')).product.published, false);
  await assert.rejects(catalog.ownProduct(other, 'private-product'), (cause: any) => cause.getStatus() === 403);
  await assert.rejects(catalog.ownProduct(owner, 'missing-product'), (cause: any) => cause.getStatus() === 404);
  await repo.transaction(async tx => { tx.set('stores', owner.uid, { id: owner.uid, ownerUid: owner.uid, status: 'suspended' }); });
  await assert.rejects(catalog.ownProduct(owner, 'private-product'), (cause: any) => cause.getStatus() === 403);
});

test('seller inventory uses bounded owner-scoped cursor pages', async () => {
  const repo = new TestRepository();
  const catalog = new CatalogService(repo);
  const owner = { uid: 'paged-owner', email: 'owner@example.test', roles: [] };
  await repo.transaction(async tx => {
    tx.set('stores', owner.uid, { id: owner.uid, ownerUid: owner.uid, status: 'active' });
    tx.set('stores', 'other-owner', { id: 'other-owner', ownerUid: 'other-owner', status: 'active' });
    for (let index = 0; index < 55; index++) {
      const id = `product-${String(index).padStart(3, '0')}`;
      tx.set('products', id, { id, ownerUid: owner.uid, storeId: owner.uid });
    }
    tx.set('products', 'other-product', { id: 'other-product', ownerUid: 'other-owner', storeId: 'other-owner' });
  });

  let pageReads = 0;
  const page = repo.page.bind(repo);
  repo.page = async (...args) => { pageReads++; return page(...args); };

  const first = await catalog.minePage(owner);
  assert.equal(first.products.length, 24);
  assert.equal(first.products[0].id, 'product-000');
  assert.equal(first.products.at(-1)?.id, 'product-023');
  assert.equal(first.nextCursor, 'product-023');
  assert.ok(first.products.every(product => product.ownerUid === owner.uid));

  const second = await catalog.minePage(owner, first.nextCursor!);
  assert.equal(second.products.length, 24);
  assert.equal(second.products[0].id, 'product-024');
  assert.equal(second.products.at(-1)?.id, 'product-047');
  assert.equal(second.nextCursor, 'product-047');

  const third = await catalog.minePage(owner, second.nextCursor!);
  assert.equal(third.products.length, 7);
  assert.equal(third.products[0].id, 'product-048');
  assert.equal(third.nextCursor, null);
  assert.equal(pageReads, 3);
});
