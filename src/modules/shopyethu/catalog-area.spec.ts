import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogService } from './catalog.service';
import { TestRepository } from './marketplace.testing';
import type { Actor, SellerApplication, Storefront } from './marketplace.types';

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

void test('unchanged store details do not write another Firestore document', async () => {
  const seller: Actor = { uid: 'seller-area-noop-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  const store: Storefront = {
    id: seller.uid, ownerUid: seller.uid, name: 'Test business',
    description: 'A business description long enough for validation.',
    area: 'Cape Town', status: 'active', reason: '', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await repo.transaction(async tx => tx.set('stores', seller.uid, store));
  repo.writes = 0;
  const updated = await new CatalogService(repo).saveStore(seller, {
    name: store.name, description: store.description, area: store.area,
  });
  assert.equal(updated.updatedAt, store.updatedAt);
  assert.equal(repo.writes, 0);
});

void test('store contact updates use the marketplace store instead of the shared SSO profile', async () => {
  const seller: Actor = { uid: 'seller-contact-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  const store: Storefront = {
    id: seller.uid, ownerUid: seller.uid, name: 'Test business',
    description: 'A business description long enough for validation.',
    area: 'Cape Town', phone: '+27821234567', whatsappAvailable: false,
    status: 'active', reason: '', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const application: SellerApplication = {
    id: seller.uid, ownerUid: seller.uid, businessName: store.name,
    contactName: 'Test contact', email: seller.email, phone: '+27821234567',
    whatsappAvailable: false,
    area: store.area, plans: store.description, response: '', status: 'approved',
    reason: '', updatedAt: store.updatedAt,
  };
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, store);
    tx.set('applications', seller.uid, application);
    tx.set('accountProfiles', seller.email, {
      phone: '+27831234567',
    });
  });
  const updated = await new CatalogService(repo).saveStore(seller, {
    name: store.name,
    description: store.description,
    area: store.area,
    phone: '083 123 4567',
    whatsappAvailable: true,
  });
  const updatedStore = await repo.get<Storefront>('stores', seller.uid);
  const updatedApplication = await repo.get<SellerApplication>('applications', seller.uid);
  const profile = await repo.get<Record<string, unknown>>('accountProfiles', seller.email);
  assert.equal(updated.phone, '+27831234567');
  assert.equal(updated.whatsappAvailable, true);
  assert.equal(updatedStore?.phone, '+27831234567');
  assert.equal(updatedStore?.whatsappAvailable, true);
  assert.equal(updatedApplication?.phone, '+27821234567');
  assert.equal(updatedApplication?.whatsappAvailable, false);
  assert.equal(profile?.phone, '+27831234567');
  assert.equal(profile?.whatsappAvailable, undefined);
});

void test('seller inventory includes the marketplace contact for its client cache', async () => {
  const seller: Actor = { uid: 'seller-inventory-phone-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, {
      id: seller.uid, ownerUid: seller.uid, name: 'Test business',
      description: 'A business description long enough for validation.',
      area: 'Cape Town', nameEditable: true, phone: '+27821234567',
      whatsappAvailable: true, status: 'active', reason: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });
  const inventory = await new CatalogService(repo).minePage(seller);
  assert.equal(inventory.phone, '+27821234567');
  assert.equal(inventory.whatsappAvailable, true);
});

void test('store contact updates do not alter the shared SSO profile', async () => {
  const seller: Actor = { uid: 'seller-whatsapp-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  const store: Storefront = {
    id: seller.uid, ownerUid: seller.uid, name: 'Test business',
    description: 'A business description long enough for validation.',
    area: 'Cape Town', nameEditable: true, status: 'active', reason: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const application: SellerApplication = {
    id: seller.uid, ownerUid: seller.uid, businessName: store.name,
    contactName: 'Test contact', email: seller.email, phone: '+27821234567',
    area: store.area, plans: store.description, response: '', status: 'approved',
    reason: '', updatedAt: store.updatedAt,
  };
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, store);
    tx.set('applications', seller.uid, application);
  });
  await new CatalogService(repo).saveStore(seller, {
    name: store.name,
    description: store.description,
    area: store.area,
    phone: '083 123 4567',
    whatsappAvailable: true,
  });
  const profile = await repo.get<Record<string, unknown>>('accountProfiles', seller.email);
  const updatedApplication = await repo.get<SellerApplication>('applications', seller.uid);
  const updatedStore = await repo.get<Storefront>('stores', seller.uid);
  assert.equal(profile, null);
  assert.equal(updatedApplication?.phone, '+27821234567');
  assert.equal(updatedStore?.phone, '+27831234567');
  assert.equal(updatedStore?.whatsappAvailable, true);
});
