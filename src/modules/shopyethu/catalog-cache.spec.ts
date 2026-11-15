import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogReadCache } from './catalog-read-cache';
import { CatalogService } from './catalog.service';
import { FirestoreMarketplaceRepository } from './marketplace.repository';
import { TestRepository } from './marketplace.testing';
import { OrdersService } from './orders.service';
import { readFileSync } from 'node:fs';

void test('public query cache combines concurrent reads, clones payloads, expires and never caches failures', async () => {
  let now = 1000, calls = 0;
  const cache = new CatalogReadCache(() => now);
  const load = async () => { calls++; return { products: [{ id: 'test-only' }] }; };
  const results = await Promise.all([cache.read('products', load), cache.read('products', load), cache.read('products', load)]);
  assert.equal(calls, 1); results[0].products.length = 0;
  assert.equal((await cache.read('products', load)).products.length, 1);
  now += 10000; await cache.read('products', load); assert.equal(calls, 2);
  cache.invalidate(); await cache.read('products', load); assert.equal(calls, 3);
  let failures = 0;
  const fail = async () => { failures++; throw new Error('test failure'); };
  await assert.rejects(cache.read('failed', fail)); await assert.rejects(cache.read('failed', fail));
  assert.equal(failures, 2);
});

void test('an invalidation during an in-flight read cannot repopulate the cache with old products', async () => {
  const cache = new CatalogReadCache(); let finish!: (value: object) => void;
  const old = cache.read('products', () => new Promise(resolve => { finish = resolve; }));
  await new Promise(setImmediate); cache.invalidate(); finish({ version: 'old' }); await old;
  assert.equal((await cache.read('products', async () => ({ version: 'new' }))).version, 'new');
});

void test('repository pages use a bounded cursor query; committed product/store writes invalidate only the public cache', async () => {
  let queryReads = 0, limits: number[] = [], cursors: unknown[] = [], privateReads = 0;
  const records = Array.from({ length: 26 }, (_, index) => ({ id: `id-${index}`, data: () => ({ id: `id-${index}`, published: true }) }));
  const collection = () => {
    let limit = 100, after: unknown;
    const query = {
      where: (_field: string, _operator: string, _value: unknown) => query,
      orderBy: (_field: unknown) => query,
      startAfter: (value: unknown) => { after = value; cursors.push(value); return query; },
      limit: (value: number) => { limit = value; limits.push(value); return query; },
      get: async () => { queryReads++; const docs = (after ? records.slice(24) : records).slice(0, limit); return { docs, size: docs.length }; },
      doc: (id: string) => ({ get: async () => { privateReads++; return { exists: true, data: () => ({ id }) }; } }),
    };
    return query;
  };
  const firebase = { db: () => ({ collection, runTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({ set() {} }) }) };
  const repo = new FirestoreMarketplaceRepository(firebase as any);
  const first = await repo.page('products', [['published', 'true']], '', 24);
  assert.equal(first.items.length, 24); assert.equal(first.nextCursor, 'id-23'); assert.deepEqual(limits, [25]);
  await repo.page('products', [['published', 'true']], '', 24); assert.equal(queryReads, 1);
  await repo.page('products', [['published', 'true']], first.nextCursor!, 24); assert.deepEqual(cursors, ['id-23']);
  await repo.get('stores', 'seller'); await repo.get('stores', 'seller'); assert.equal(privateReads, 2, 'visibility is never TTL cached');
  await repo.transaction(async tx => { tx.set('stores', 'seller', { status: 'suspended' }); });
  await repo.page('products', [['published', 'true']], '', 24); assert.equal(queryReads, 3);
  await repo.list('products', [['ownerUid', 'seller']]); await repo.list('products', [['ownerUid', 'seller']]);
  assert.equal(queryReads, 5, 'private inventory bypasses public caching');
});

void test('catalogue reads only referenced stores and excludes a suspension even if products are cached', async () => {
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    tx.set('stores', 'seller', { id: 'seller', name: 'Test store', status: 'active' });
    for (let id = 0; id < 3; id++) tx.set('products', String(id), { id: String(id), storeId: 'seller', published: true, category: 'Other', name: 'Test product', description: 'Only in tests.' });
  });
  const original = repo.get.bind(repo); let storeReads = 0;
  repo.get = async <T>(table: string, id: string) => { if (table === 'stores') storeReads++; return original<T>(table, id); };
  const catalog = new CatalogService(repo);
  assert.equal((await catalog.page()).products.length, 3); assert.equal(storeReads, 1);
  await repo.transaction(async tx => { tx.set('stores', 'seller', { id: 'seller', status: 'suspended' }); });
  assert.equal((await catalog.page()).products.length, 0); assert.equal(storeReads, 2);
});

void test('a confirmed order is recovered by its original key after a seller suspension; new orders remain blocked', async () => {
  const repo = new TestRepository(), actor = { uid: 'buyer', email: 'test@example.test', roles: [] };
  await repo.transaction(async tx => {
    tx.set('stores', 'seller', { id: 'seller', ownerUid: 'seller', status: 'active' });
    tx.set('products', 'p', { id: 'p', storeId: 'seller', published: true, fulfilment: ['collection'], name: 'Test', priceCents: 100, stock: 2, photos: [] });
  });
  const body = { items: [{ productId: 'p', quantity: 1, expectedPriceCents: 100 }], fulfilment: 'collection', contact: actor.email };
  const service = new OrdersService(repo);
  const placed = await service.place(actor, body, 'test-recovery-key');
  await repo.transaction(async tx => { tx.set('stores', 'seller', { id: 'seller', ownerUid: 'seller', status: 'suspended' }); });
  assert.equal((await service.place(actor, body, 'test-recovery-key')).id, placed.id);
  await assert.rejects(service.place(actor, body, 'different-test-key'), (error: any) => error.getStatus?.() === 409);
  assert.equal((await repo.get<any>('products', 'p')).stock, 1);
});

void test('catalogue composite indexes cover category, store and combined cursor queries', () => {
  const { indexes } = JSON.parse(readFileSync('firestore.indexes.json', 'utf8'));
  for (const fields of [['published', 'category'], ['published', 'storeId'], ['published', 'category', 'storeId']]) {
    assert.ok(indexes.some((index: any) => index.collectionGroup === 'shopyethu_products' &&
      index.fields.map((field: any) => field.fieldPath).join(',') === fields.join(',')));
  }
});
