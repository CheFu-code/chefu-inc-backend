import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogReadCache } from './catalog-read-cache';
import { CatalogService } from './catalog.service';
import { FirestoreMarketplaceRepository } from './marketplace.repository';
import { TestRepository } from './marketplace.testing';
import { OrdersService } from './orders.service';
import type { PageOptions } from './marketplace.types';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

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

void test('catalogue groups unique store visibility reads through the batch reader', async () => {
  const data = new TestRepository();
  await data.transaction(async tx => {
    for (let id = 0; id < 3; id++) {
      tx.set('stores', `seller-${id}`, { id: `seller-${id}`, name: `Store ${id}`, status: 'active' });
      tx.set('products', String(id), { id: String(id), storeId: `seller-${id}`, published: true, category: 'Other', name: 'Test product', description: 'Only in tests.' });
    }
  });
  let batchCalls = 0;
  const repo = {
    get: data.get.bind(data),
    list: data.list.bind(data),
    transaction: data.transaction.bind(data),
    getMany: async <T>(table: string, ids: string[]) => {
      batchCalls++;
      const stores = new Map<string, T>();
      for (const id of ids) {
        const store = await data.get<T>(table, id);
        if (store !== null) stores.set(id, store);
      }
      return stores;
    },
  };
  const result = await new CatalogService(repo).page();
  assert.equal(result.products.length, 3);
  assert.equal(batchCalls, 1);
});

void test('catalogue discovery sorts by price and keeps sort-order cursor pagination stable', async () => {
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    tx.set('stores', 'seller', { id: 'seller', name: 'Test store', status: 'active' });
    for (const [id, priceCents] of [['mid', 2000], ['low', 1000], ['high', 3000]] as const) {
      tx.set('products', id, {
        id, storeId: 'seller', published: true, category: 'Other', name: `${id} listing`,
        description: 'Only in tests.', priceCents, stock: 1, photos: [],
        fulfilment: ['collection'], updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }
  });
  const catalog = new CatalogService(repo);
  const lowToHigh = await catalog.page('', 'Other', '', '', true, { sort: 'price-low' });
  const highToLow = await catalog.page('', 'Other', '', '', true, { sort: 'price-high' });
  assert.deepEqual(lowToHigh.products.map(product => product.id), ['low', 'mid', 'high']);
  assert.deepEqual(highToLow.products.map(product => product.id), ['high', 'mid', 'low']);
  await assert.rejects(catalog.page('', '', '', '', true, { sort: 'invalid' }), (error: any) => error.getStatus?.() === 400);

  const orderOptions: PageOptions = {
    order: { field: 'priceCents', direction: 'asc' },
  };
  const first = await repo.page<any>('products', [['published', 'true']], '', 1, orderOptions);
  const second = await repo.page<any>('products', [['published', 'true']], first.nextCursor!, 1, orderOptions);
  assert.equal(first.items[0].id, 'low');
  assert.equal(second.items[0].id, 'mid');
});

void test('compact catalogue responses keep searchable summaries but omit descriptions and extra photo URLs', async t => {
  const repo = new TestRepository();
  const products = Array.from({ length: 24 }, (_, productIndex) => ({
    id: `large-listing-${productIndex}`, storeId: 'seller', ownerUid: 'seller',
    name: `Searchable product ${productIndex}`, description: `needle ${'x'.repeat(3990)} ${productIndex}`,
    category: 'Other', priceCents: 2000, stock: 5,
    photos: Array.from({ length: 5 }, (_, photoIndex) =>
      `https://res.cloudinary.com/test/image/upload/${'a'.repeat(180)}${productIndex}-${photoIndex}.jpg`),
    published: true, fulfilment: ['collection'], updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  await repo.transaction(async tx => {
    tx.set('stores', 'seller', { id: 'seller', name: 'Test store', status: 'active' });
    for (const product of products) tx.set('products', product.id, product);
  });
  const catalog = new CatalogService(repo);
  const full = await catalog.page('needle');
  const compact = await catalog.page('needle', '', '', '', true);
  const storePage = await catalog.storefront('seller', true, true);
  assert.equal(full.products.length, 24);
  assert.equal(full.products[0].description.length, 3999);
  assert.equal(compact.products[0].description, '');
  assert.deepEqual(compact.products[0].photos, [full.products[0].photos[0]]);
  assert.equal(storePage.products[0].description, '');
  assert.deepEqual(storePage.products[0].photos, [full.products[0].photos[0]]);
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  const fullGzipBytes = gzipSync(JSON.stringify(full)).length;
  const compactGzipBytes = gzipSync(JSON.stringify(compact)).length;
  assert.ok(compactBytes < fullBytes);
  assert.ok(compactGzipBytes < fullGzipBytes);
  t.diagnostic(`24-product fixture JSON bytes: ${fullBytes} -> ${compactBytes} (${((fullBytes - compactBytes) / fullBytes * 100).toFixed(1)}% smaller); gzip: ${fullGzipBytes} -> ${compactGzipBytes} (${((fullGzipBytes - compactGzipBytes) / fullGzipBytes * 100).toFixed(1)}% smaller)`);
});

void test('Firestore batch reader deduplicates references and makes one batch request', async () => {
  let batchCalls = 0;
  let readIds: string[] = [];
  const firebase = {
    db: () => ({
      collection: (table: string) => ({ doc: (id: string) => ({ table, id }) }),
      getAll: async (...refs: { table: string; id: string }[]) => {
        batchCalls++;
        readIds = refs.map(ref => `${ref.table}/${ref.id}`);
        return refs.map(ref => ({ exists: ref.id !== 'missing', data: () => ({ id: ref.id }) }));
      },
    }),
  };
  const repo = new FirestoreMarketplaceRepository(firebase as any);
  const stores = await repo.getMany<{ id: string }>('stores', ['one', 'two', 'one', 'missing']);
  assert.equal(batchCalls, 1);
  assert.deepEqual(readIds, ['shopyethu_stores/one', 'shopyethu_stores/two', 'shopyethu_stores/missing']);
  assert.deepEqual([...stores.keys()], ['one', 'two']);
});

void test('Firestore sorted cursors carry both ordered field and document ID', async () => {
  const orderings: unknown[][] = [], cursors: unknown[][] = [];
  const docs = [
    { id: 'one', get: (field: string) => field === 'priceCents' ? 100 : null, data: () => ({ id: 'one', priceCents: 100 }) },
    { id: 'two', get: (field: string) => field === 'priceCents' ? 200 : null, data: () => ({ id: 'two', priceCents: 200 }) },
  ];
  const collection = () => {
    const query = {
      where: () => query,
      orderBy: (...args: unknown[]) => { orderings.push(args); return query; },
      startAfter: (...args: unknown[]) => { cursors.push(args); return query; },
      limit: () => query,
      get: async () => ({ docs, size: docs.length }),
    };
    return query;
  };
  const repo = new FirestoreMarketplaceRepository({ db: () => ({ collection }) } as any);
  const options: PageOptions = { order: { field: 'priceCents', direction: 'asc' } };
  const first = await repo.page<any>('products', [['published', 'true']], '', 1, options);
  assert.equal(first.items[0].id, 'one');
  assert.equal(typeof first.nextCursor, 'string');
  await repo.page<any>('products', [['published', 'true']], first.nextCursor!, 1, options);
  assert.deepEqual(cursors, [[100, 'one']]);
  assert.equal(orderings.length, 4);
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
  assert.ok(indexes.some((index: any) => index.collectionGroup === 'shopyethu_reviews' &&
    index.fields.map((field: any) => field.fieldPath).join(',') === 'productId,createdAt'));
  for (const sortField of ['updatedAt', 'priceCents']) {
    assert.ok(indexes.some((index: any) => index.collectionGroup === 'shopyethu_products' &&
      index.fields.some((field: any) => field.fieldPath === 'published') &&
      index.fields.some((field: any) => field.fieldPath === sortField)));
  }
});
