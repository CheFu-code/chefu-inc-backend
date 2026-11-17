import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogService } from './catalog.service';
import { ApplicationsService } from './applications.service';
import { TestRepository } from './marketplace.testing';
import type { Actor, SellerApplication, Storefront } from './marketplace.types';

const actor: Actor = { uid: 'name-policy-owner', email: 'owner@example.test', roles: [] };
const staff: Actor = { uid: 'name-policy-admin', email: 'staff@example.test', roles: ['admin'] };
const store: Storefront = { id: actor.uid, ownerUid: actor.uid, name: 'Registered Test Business',
  description: 'Original store description.', area: 'Cape Town', status: 'active', reason: '', updatedAt: '2026-01-01T00:00:00Z' };
const fields = { name: store.name, description: store.description, area: store.area };
const forbidden = (cause: any) => cause.getStatus?.() === 403;
async function setup(type: 'registered-business' | 'individual', metadata?: boolean) {
  const repo = new TestRepository();
  await repo.transaction(async tx => {
    tx.set('applications', actor.uid, { id: actor.uid, ownerUid: actor.uid, email: actor.email, businessType: type,
      businessName: store.name, plans: store.description, area: store.area, status: 'approved', updatedAt: store.updatedAt });
    tx.set('stores', actor.uid, { ...store, ...(metadata === undefined ? {} : { nameEditable: metadata }) });
  });
  return { repo, catalog: new CatalogService(repo), applications: new ApplicationsService(repo) };
}

void test('legacy registered stores expose a locked name without writes or a separate client request', async () => {
  const { repo, catalog, applications } = await setup('registered-business');
  const writes = repo.writes;
  assert.equal((await catalog.mine(actor)).store.nameEditable, false);
  assert.equal((await applications.account(actor)).store?.nameEditable, false);
  assert.equal(repo.writes, writes);
  await assert.rejects(catalog.saveStore(actor, { ...fields, name: 'A new name', nameEditable: true, businessType: 'individual' }), forbidden);
  assert.equal(repo.writes, writes, 'forged client policy cannot rename or write');
  assert.equal((await repo.get<Storefront>('stores', actor.uid))!.name, store.name);
});

void test('registered sellers can save other details and unchanged saves do not write again', async () => {
  const { repo, catalog } = await setup('registered-business');
  const updated = await catalog.saveStore(actor, { ...fields, description: 'A new description for the shop.', area: 'Johannesburg' });
  assert.equal(updated.name, store.name); assert.equal(updated.nameEditable, false);
  assert.equal(updated.area, 'Johannesburg');
  assert.equal((await repo.get<Storefront>('stores', actor.uid))!.nameEditable, false, 'save carries the policy forward');
  const writes = repo.writes;
  await catalog.saveStore(actor, { name: updated.name, description: updated.description, area: updated.area });
  assert.equal(repo.writes, writes);
  await assert.rejects(catalog.saveStore(actor, { ...fields, name: 'Another name' }), forbidden);
});

void test('individual sellers retain the ability to rename their storefront', async () => {
  const { catalog } = await setup('individual');
  assert.equal((await catalog.mine(actor)).store.nameEditable, true);
  const updated = await catalog.saveStore(actor, { ...fields, name: 'New trading name' });
  assert.equal(updated.name, 'New trading name'); assert.equal(updated.nameEditable, true);
});

void test('approval stores the application-derived rule, so inventory does not repeatedly read the application', async () => {
  for (const businessType of ['registered-business', 'individual'] as const) {
    const { repo, applications, catalog } = await setup(businessType);
    await repo.transaction(async tx => {
      const application = (await tx.get<SellerApplication>('applications', actor.uid))!;
      tx.set('applications', actor.uid, { ...application, status: 'pending' });
      tx.delete('stores', actor.uid);
    });
    await applications.review(staff, actor.uid, { status: 'approved' });
    assert.equal((await repo.get<Storefront>('stores', actor.uid))!.nameEditable, businessType === 'individual');
    let applicationReads = 0;
    const get = repo.get.bind(repo);
    repo.get = async <T>(table: string, id: string) => { if (table === 'applications') applicationReads++; return get<T>(table, id); };
    await catalog.mine(actor); await catalog.mine(actor);
    assert.equal(applicationReads, 0);
  }
});

void test('name rules cannot bypass seller ownership or suspension', async () => {
  const { repo, catalog } = await setup('registered-business', false);
  await repo.transaction(async tx => { tx.set('stores', actor.uid, { ...store, nameEditable: false, status: 'suspended' }); });
  await assert.rejects(catalog.saveStore(actor, fields), forbidden);
  await assert.rejects(catalog.mine({ ...actor, uid: 'other-account' }), forbidden);
});
