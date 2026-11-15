import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogService } from './catalog.service';
import { TestRepository } from './marketplace.testing';
import type { Actor, Storefront } from './marketplace.types';

void test('store updates persist a selected South African Place ID without its Google label', async () => {
  const seller: Actor = { uid: 'seller-area-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, {
      id: seller.uid,
      ownerUid: seller.uid,
      name: 'Test business',
      description: 'A business description long enough for validation.',
      area: 'Old manual area',
      status: 'active',
      reason: '',
      updatedAt: new Date().toISOString(),
    });
  });
  const placeId = 'ChIJcapeTown';
  const places = {
    resolve: async (id: unknown) => {
      assert.equal(id, placeId);
      return { placeId, label: 'Cape Town, South Africa' };
    },
  };
  const catalog = new CatalogService(repo, places);
  const updated = await catalog.saveStore(seller, {
    name: 'Test business',
    description: 'A business description long enough for validation.',
    area: 'Cape Town, South Africa',
    areaPlaceId: placeId,
    areaSessionToken: '123e4567-e89b-12d3-a456-426614174000',
  });
  const stored = await repo.get<Storefront>('stores', seller.uid);
  assert.equal(updated.area, '');
  assert.equal(stored?.area, '');
  assert.equal(stored?.areaPlaceId, placeId);
});
