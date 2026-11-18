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

void test('store saves sync a verified shared account phone to the private seller application', async () => {
  const seller: Actor = { uid: 'seller-contact-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  const store: Storefront = {
    id: seller.uid, ownerUid: seller.uid, name: 'Test business',
    description: 'A business description long enough for validation.',
    area: 'Cape Town', status: 'active', reason: '', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const application: SellerApplication = {
    id: seller.uid, ownerUid: seller.uid, businessName: store.name,
    contactName: 'Test contact', email: seller.email, phone: '+27821234567',
    area: store.area, plans: store.description, response: '', status: 'approved',
    reason: '', updatedAt: store.updatedAt, phoneConfirmed: true,
  };
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, store);
    tx.set('applications', seller.uid, application);
    tx.set('accountProfiles', seller.email, {
      phone: '+27831234567',
      phoneVerifiedAt: '2026-01-02T00:00:00.000Z',
      phoneVerifiedFor: '+27831234567',
    });
  });
  const updated = await new CatalogService(repo).saveStore(seller, {
    name: store.name,
    description: store.description,
    area: store.area,
  });
  const updatedApplication = await repo.get<SellerApplication>('applications', seller.uid);
  assert.equal(updatedApplication?.phone, '+27831234567');
  assert.equal(updatedApplication?.phoneConfirmed, true);
  assert.ok(updatedApplication?.contactConfirmedAt);
  assert.equal(updated.updatedAt, store.updatedAt);
  assert.equal('phone' in (await repo.get<Storefront>('stores', seller.uid))!, false);
});

void test('store saves sync an unverified shared account phone to seller contact details', async () => {
  const seller: Actor = { uid: 'seller-unverified-contact-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  const store: Storefront = {
    id: seller.uid, ownerUid: seller.uid, name: 'Test business',
    description: 'A business description long enough for validation.',
    area: 'Cape Town', status: 'active', reason: '', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const application: SellerApplication = {
    id: seller.uid, ownerUid: seller.uid, businessName: store.name,
    contactName: 'Test contact', email: seller.email, phone: '+27821234567',
    area: store.area, plans: store.description, response: '', status: 'approved',
    reason: '', updatedAt: store.updatedAt, phoneConfirmed: true,
  };
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, store);
    tx.set('applications', seller.uid, application);
    tx.set('accountProfiles', seller.email, { phone: '+27831234567' });
  });
  await new CatalogService(repo).saveStore(seller, {
    name: store.name,
    description: store.description,
    area: store.area,
  });
  assert.equal(
    (await repo.get<SellerApplication>('applications', seller.uid))?.phone,
    '+27831234567',
  );
});

void test('seller inventory includes the shared account phone for its client cache', async () => {
  const seller: Actor = { uid: 'seller-inventory-phone-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, {
      id: seller.uid, ownerUid: seller.uid, name: 'Test business',
      description: 'A business description long enough for validation.',
      area: 'Cape Town', nameEditable: true, status: 'active', reason: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    tx.set('accountProfiles', seller.email, {
      phone: '+27821234567',
      phoneVerifiedAt: '2026-01-02T00:00:00.000Z',
      phoneVerifiedFor: '+27821234567',
    });
  });
  const inventory = await new CatalogService(repo).minePage(seller);
  assert.equal(inventory.phone, '+27821234567');
  assert.equal(inventory.phoneVerificationRequired, false);
  assert.equal(inventory.whatsappAvailable, false);
});

void test('store saves the shared phone and WhatsApp flag without retaining stale verification proof', async () => {
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
    reason: '', updatedAt: store.updatedAt, phoneConfirmed: true,
  };
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, store);
    tx.set('applications', seller.uid, application);
    tx.set('accountProfiles', seller.email, {
      phone: '+27821234567',
      phoneVerifiedAt: '2026-01-02T00:00:00.000Z',
      phoneVerifiedFor: '+27821234567',
      whatsappAvailable: false,
    });
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
  assert.equal(profile?.phone, '+27831234567');
  assert.equal(profile?.whatsappAvailable, true);
  assert.equal(profile?.phoneVerifiedAt, null);
  assert.equal(profile?.phoneVerifiedFor, null);
  assert.equal(updatedApplication?.phone, '+27831234567');
});
