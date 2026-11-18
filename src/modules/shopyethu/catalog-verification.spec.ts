import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogService } from './catalog.service';
import { TestRepository } from './marketplace.testing';
import type { Actor, SellerApplication, Storefront } from './marketplace.types';

void test('public storefront verification reflects approved registered-business documents only', async () => {
  const seller: Actor = { uid: 'seller-verification-test', email: 'seller@example.test', roles: [] };
  const repo = new TestRepository();
  const store: Storefront = {
    id: seller.uid, ownerUid: seller.uid, name: 'Test business',
    description: 'A business description long enough for validation.',
    area: 'Cape Town', status: 'active', reason: '', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const application: SellerApplication = {
    id: seller.uid,
    ownerUid: seller.uid,
    businessName: store.name,
    contactName: 'Test contact',
    email: seller.email,
    phone: '0123456789',
    area: store.area,
    plans: store.description,
    response: '',
    status: 'approved',
    reason: '',
    updatedAt: store.updatedAt,
    businessType: 'registered-business',
    cipcCertificateId: 'private-certificate-id',
    cipcCertificateFormat: 'pdf',
  };
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, store);
    tx.set('applications', seller.uid, application);
    tx.set('products', 'verified-product', {
      id: 'verified-product', storeId: seller.uid, ownerUid: seller.uid,
      name: 'Verified product', description: 'A test product.',
      category: 'Other', priceCents: 1000, stock: 1, photos: [],
      published: true, fulfilment: ['collection'], updatedAt: store.updatedAt,
    });
  });

  const catalog = new CatalogService(repo);
  const verified = await catalog.storefront(seller.uid);
  assert.equal(verified.store.verified, true);
  assert.equal('cipcCertificateId' in verified.store, false);
  assert.equal((await catalog.product('verified-product')).store.verified, true);
  assert.equal((await catalog.page('', '', '', '', false, { includeStoreVerification: true })).products[0].storeVerified, true);

  for (const updatedApplication of [
    { ...application, status: 'pending' as const },
    { ...application, businessType: 'individual' as const },
    { ...application, cipcCertificateId: undefined },
    { ...application, cipcCertificateFormat: undefined },
  ]) {
    await repo.transaction(async tx => {
      tx.set('applications', seller.uid, updatedApplication);
    });
    const result = await catalog.storefront(seller.uid);
    assert.equal(result.store.verified, false);
    assert.equal((await catalog.product('verified-product')).store.verified, false);
    assert.equal((await catalog.page('', '', '', '', false, { includeStoreVerification: true })).products[0].storeVerified, false);
  }
});

void test('public storefront exposes a valid marketplace phone and WhatsApp status only', async () => {
  const seller: Actor = { uid: 'seller-contact-test', email: 'contact@example.test', roles: [] };
  const repo = new TestRepository();
  const store: Storefront = {
    id: seller.uid, ownerUid: seller.uid, name: 'Contact test store',
    description: 'A business description long enough for validation.',
    area: 'Cape Town', status: 'active', reason: '', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const application: SellerApplication = {
    id: seller.uid,
    ownerUid: seller.uid,
    businessName: store.name,
    contactName: 'Test contact',
    email: seller.email,
    phone: '0821234567',
    whatsappAvailable: true,
    area: store.area,
    plans: store.description,
    response: '',
    status: 'pending',
    reason: '',
    updatedAt: store.updatedAt,
  };
  await repo.transaction(async tx => {
    tx.set('stores', seller.uid, store);
    tx.set('applications', seller.uid, application);
  });

  const catalog = new CatalogService(repo);
  const publicStore = (await catalog.storefront(seller.uid)).store;
  assert.equal(publicStore.phone, '+27821234567');
  assert.equal(publicStore.whatsappAvailable, true);
  assert.equal('phoneVerificationRequired' in publicStore, false);

  await repo.transaction(async tx => {
    tx.set('applications', seller.uid, {
      ...application,
      phone: 'not-a-phone-number',
    });
  });
  const invalidContact = (await catalog.storefront(seller.uid)).store;
  assert.equal(invalidContact.phone, undefined);
  assert.equal(invalidContact.whatsappAvailable, undefined);
});
