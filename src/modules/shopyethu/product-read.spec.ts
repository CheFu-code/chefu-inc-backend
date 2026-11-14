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
