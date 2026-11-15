import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogService } from './catalog.service';
import { TestRepository } from './marketplace.testing';
import type { Actor, Product, Storefront } from './marketplace.types';

const actor: Actor = { uid: 'product-unit-test', email: 'seller@example.test', roles: [] };
const fields = { name: 'Test product', description: 'For isolated unit tests only.', category: 'Other', priceCents: 2000, stock: 5, photos: ['https://example.test/item.png'], published: true, fulfilment: ['collection'] };
const status = (expected: number) => (cause: any) => cause.getStatus?.() === expected;
async function setup() {
  const repo = new TestRepository();
  await repo.transaction(async tx => { tx.set('stores', actor.uid, { id: actor.uid, ownerUid: actor.uid, status: 'active' }); });
  return { repo, catalog: new CatalogService(repo) };
}

test('simultaneous creates and lost-response retries produce one product and one reservation', async () => {
  const { catalog, repo } = await setup();
  const key = 'create-product-attempt-1234';
  const [first, replay] = await Promise.all([catalog.saveProduct(actor, fields, undefined, key), catalog.saveProduct(actor, fields, undefined, key)]);
  assert.equal(first.id, replay.id);
  assert.equal((await repo.list('products')).length, 1);
  assert.equal((await repo.list('idempotency')).length, 1);
  await assert.rejects(catalog.saveProduct(actor, { ...fields, priceCents: 3000 }, undefined, key), status(409));
  assert.equal((await repo.get<Product>('products', first.id))?.priceCents, 2000);
});

test('unchanged product saves avoid product writes while retaining idempotent retries', async () => {
  const { catalog, repo } = await setup();
  const product = await catalog.saveProduct(actor, fields);
  repo.writes = 0;
  const body = { ...fields, expectedUpdatedAt: product.updatedAt, expectedStock: product.stock };
  const saved = await catalog.saveProduct(actor, body, product.id, 'unchanged-save-attempt');
  assert.equal(saved.updatedAt, product.updatedAt);
  assert.equal(repo.writes, 1, 'only the retry reservation is written');
  repo.writes = 0;
  await catalog.saveProduct(actor, body, product.id);
  assert.equal(repo.writes, 0, 'legacy unkeyed no-op saves write nothing');
});

test('replaying a product save never restores stock changed by a later order', async () => {
  const { catalog, repo } = await setup();
  const product = await catalog.saveProduct(actor, fields, undefined, 'initial-product-attempt');
  const edit = { ...fields, name: 'Updated product', expectedUpdatedAt: product.updatedAt, expectedStock: product.stock };
  const saved = await catalog.saveProduct(actor, edit, product.id, 'update-product-attempt');
  await repo.transaction(async tx => { tx.set('products', product.id, { ...saved, stock: 4 }); });
  const replay = await catalog.saveProduct(actor, edit, product.id, 'update-product-attempt');
  assert.equal(replay.stock, 4);
  assert.equal((await repo.get<Product>('products', product.id))?.stock, 4);
  await assert.rejects(catalog.saveProduct(actor, { ...fields, expectedUpdatedAt: saved.updatedAt, expectedStock: 5 }, product.id, 'stale-stock-attempt-123'), status(409));
});

test('retry keys are account-scoped; suspended sellers and unrelated owners remain blocked', async () => {
  const { catalog, repo } = await setup();
  const other: Actor = { uid: 'other-product-test', email: 'other@example.test', roles: [] };
  await repo.transaction(async tx => { tx.set('stores', other.uid, { id: other.uid, ownerUid: other.uid, status: 'active' }); });
  const first = await catalog.saveProduct(actor, fields, undefined, 'shared-attempt-123456');
  const second = await catalog.saveProduct(other, fields, undefined, 'shared-attempt-123456');
  assert.notEqual(first.id, second.id);
  await assert.rejects(catalog.saveProduct(other, fields, first.id, 'unrelated-owner-attempt'), status(403));
  await repo.transaction(async tx => {
    const store = await tx.get<Storefront>('stores', actor.uid);
    tx.set('stores', actor.uid, { ...store!, status: 'suspended', reason: 'Review in progress.' });
  });
  await assert.rejects(catalog.saveProduct(actor, fields, undefined, 'shared-attempt-123456'), status(403));
  assert.equal((await repo.list('products')).length, 2);
});

test('invalid keys, stale versions and updates to missing products cannot create or overwrite listings', async () => {
  const { catalog, repo } = await setup();
  await assert.rejects(catalog.saveProduct(actor, fields, undefined, ''), status(400));
  await assert.rejects(catalog.saveProduct(actor, fields, 'missing-product'), status(404));
  const product = await catalog.saveProduct(actor, fields);
  await assert.rejects(catalog.saveProduct(actor, { ...fields, expectedUpdatedAt: 'old-version' }, product.id, 'stale-version-attempt'), status(409));
  assert.equal((await repo.list('products')).length, 1);
});
