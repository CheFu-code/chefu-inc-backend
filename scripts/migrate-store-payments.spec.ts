import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/modules/store/checkout.testing';
import { migrateStorePayments } from './migrate-store-payments';

void test('additive store migration is dry-run by default, repeatable, and never replays legacy delivery', async () => {
  const s = setup();
  s.records.set('storeOrders/legacy', { reference: 'legacy', ownerHash: 'original', status: 'paid', stockReserved: true, createdAt: 1, updatedAt: 2, amountMinor: 100 });
  s.records.set('storeOrders/pending', { reference: 'pending', ownerHash: 'original', status: 'pending', stockReserved: true, createdAt: 1, updatedAt: 2, amountMinor: 100 });
  s.records.set('storeFulfillments/legacy', { status: 'queued' });
  const before = structuredClone([...s.records]);
  await migrateStorePayments(s.firebase);
  assert.deepEqual([...s.records], before);
  await migrateStorePayments(s.firebase, true);
  assert.equal(s.records.get('storePayments/legacy')!.state, 'SUCCESS');
  assert.equal(s.records.get('storePayments/pending')!.initializationDispatched, true);
  assert.equal(s.records.get('storeOrders/legacy')!.ownerHash, 'original');
  assert.equal(s.records.get('storeOrders/pending')!.status, 'pending');
  assert.equal(s.records.get('storeFulfillments/legacy')!.status, 'migration_review');
  const jobs = s.count('storeJobs');
  await migrateStorePayments(s.firebase, true);
  assert.equal(s.count('storeJobs'), jobs);
  assert.equal(s.calls.initialize, 0);
  assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 100);
});
