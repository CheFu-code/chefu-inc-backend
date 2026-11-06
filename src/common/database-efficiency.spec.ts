import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InFlightReads } from './in-flight-reads';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { AcademyMobileService } from '../modules/academy-mobile/academy-mobile.service';
import { ApiKeyService } from '../modules/api-key/api-key.service';
import { AcademySdkApiKeysService } from '../modules/academy-sdk/services/academy-sdk-api-keys.service';
import { AcademySdkCatalogService } from '../modules/academy-sdk/services/academy-sdk-catalog.service';
import { CloudenceFoldersService } from '../modules/cloudence/cloudence-folders.service';
import { QuantumAgentDataService } from '../modules/quantum/agent/agent-data.service';
import { QuantumAgentToolsService } from '../modules/quantum/agent/agent-tools.service';
import { ProductsService } from '../modules/products/products.service';

const user = { uid: 'alice', email: 'alice@example.test', roles: ['developer'] };
function fixture() {
  const rows = new Map<string, any>();
  const counts = { reads: 0, writes: 0 };
  const ref = (path: string): any => ({
    path, id: path.split('/').at(-1),
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => {
      counts.reads++;
      return { id: path.split('/').at(-1), exists: rows.has(path), data: () => structuredClone(rows.get(path)) };
    },
    set: async (data: any, options?: any) => {
      counts.writes++;
      rows.set(path, options?.merge ? { ...rows.get(path), ...data } : data);
    },
    update: async (data: any) => {
      counts.writes++;
      rows.set(path, { ...rows.get(path), ...data });
    },
  });
  const collection = (path: string): any => ({
    doc: (id: string) => ref(`${path}/${id}`),
    add: async (data: any) => { counts.writes++; rows.set(`${path}/audit`, data); },
  });
  const db: any = {
    collection,
    runTransaction: async (task: any) => task({
      get: (reference: any) => reference.get(),
      set: (reference: any, data: any, options?: any) => { void reference.set(data, options); },
      update: (reference: any, data: any) => { void reference.update(data); },
    }),
  };
  return { rows, counts, db, firebase: { db: () => db } as any };
}

test('simultaneous reads share work; later reads and failures are not cached', async () => {
  const reads = new InFlightReads();
  let loads = 0;
  const load = async () => ++loads;
  const first = reads.run('course-a', load);
  assert.equal(reads.run('course-a', load), first);
  assert.deepEqual(await Promise.all([first, reads.run('course-b', load)]), [1, 2]);
  assert.equal(await reads.run('course-a', load), 3);
  await assert.rejects(reads.run('failed', async () => { throw new Error('offline'); }));
  assert.equal(await reads.run('failed', load), 4);
});

test('in-flight sharing stays bounded and independent per service instance', async () => {
  const reads = new InFlightReads(1);
  let release!: (value: number) => void;
  const first = reads.run('a', () => new Promise<number>(resolve => { release = resolve; }));
  let overflow = 0;
  await Promise.all([reads.run('b', async () => ++overflow), reads.run('b', async () => ++overflow)]);
  assert.equal(overflow, 2);
  assert.equal(await new InFlightReads().run('a', async () => 99), 99);
  release(1);
  await first;
});

test('unchanged notification preferences use one read and zero writes; real changes persist', async () => {
  const { rows, counts, firebase } = fixture();
  rows.set(`users/${user.email}`, { emailPreferences: { marketing: false, security: true } });
  const service = new NotificationsService(firebase);
  await service.updatePreferences(user, { marketing: false });
  assert.deepEqual(counts, { reads: 1, writes: 0 });
  const result = await service.updatePreferences(user, { marketing: true });
  assert.equal(result.preferences.marketing, true);
  assert.equal(result.preferences.security, true);
  assert.deepEqual(counts, { reads: 2, writes: 1 });
  await assert.rejects(service.updatePreferences(user, {}));
  assert.equal(counts.reads, 2, 'invalid patches fail before accessing Firestore');
});

test('Academy settings use one read, preserve unpatched preferences, and skip identical saves', async () => {
  const { rows, counts, firebase } = fixture();
  rows.set(`users/${user.email}`, { notifications: true, useBiometrics: false, emailPreferences: { marketing: true, security: true } });
  const service = new AcademyMobileService(firebase);
  await service.updateSettings(user, { useBiometrics: false });
  assert.deepEqual(counts, { reads: 1, writes: 0 });
  const result = await service.updateSettings(user, { emailPreferences: { marketing: false } });
  assert.equal(result.emailPreferences.marketing, false);
  assert.equal(result.emailPreferences.security, true);
  assert.equal(result.useBiometrics, false);
  assert.deepEqual(counts, { reads: 2, writes: 1 });
  await service.updateSettings(user, { emailPreferences: { marketing: false } });
  assert.deepEqual(counts, { reads: 3, writes: 1 });
});

test('repeat API key revocation saves writes without bypassing ownership checks', async () => {
  for (const sdk of [false, true]) {
    const { rows, counts, firebase } = fixture();
    rows.set('api_keys/key', { active: true, userId: user.uid, ownerUid: user.uid });
    const service = sdk ? new AcademySdkApiKeysService(firebase, {} as any) : new ApiKeyService(firebase);
    const revoke = (identity = user) => sdk
      ? (service as AcademySdkApiKeysService).revokeApiKey(identity, 'key')
      : (service as ApiKeyService).revokeApiKey(identity.uid, 'key');
    await revoke();
    await revoke();
    assert.deepEqual(counts, { reads: 2, writes: 1 });
    await assert.rejects(revoke({ ...user, uid: 'bob' }));
    assert.equal(counts.writes, 1);
  }
});

test('identical message edits preserve timestamps and do not write', async () => {
  const { rows, counts, firebase } = fixture();
  const path = 'quantum_agent_users/alice/threads/main/messages/message';
  rows.set(path, { content: 'hello', metadata: { a: 1, b: 2 }, updated_at: 'original' });
  const service = new QuantumAgentDataService(firebase);
  const unchanged = await service.updateMessage(user, 'main', 'message', { content: 'hello', metadata: { b: 2, a: 1 } });
  assert.equal((unchanged as Record<string, unknown>).updated_at, 'original');
  assert.equal(counts.writes, 0);
  await service.updateMessage(user, 'main', 'message', { content: 'edited', metadata: { b: 2, a: 1 } });
  assert.equal(counts.writes, 1);
  await assert.rejects(service.updateMessage({ ...user, uid: 'bob' }, 'main', 'message', { content: 'private' }));
});

test('identical folder rename and repeated moves skip writes but still check file access', async () => {
  const { rows, counts, firebase } = fixture();
  const folder = { id: 'folder', name: 'Work', section: 'documents', createdAt: 'original' };
  rows.set('cloudenceFolders/alice', { folders: [folder], placements: {} });
  const service = new CloudenceFoldersService(firebase);
  await service.save(user, { id: 'folder', name: 'Work' });
  assert.equal(counts.writes, 0);
  rows.set('cloudenceFiles/file', { id: 'file', ownerId: 'alice', users: [], type: 'document', isDeleted: false });
  await service.move(user, 'file', 'folder');
  await service.move(user, 'file', 'folder'); // advances cleanup cursor once
  const writes = counts.writes;
  await service.move(user, 'file', 'folder');
  assert.equal(counts.writes, writes);
  await assert.rejects(service.move({ ...user, uid: 'bob' }, 'file', 'folder'));
  assert.equal(counts.writes, writes);
});

test('unchanged product updates and repeated archives skip product and duplicate audit writes', async () => {
  const { rows, counts, firebase } = fixture();
  const service = new ProductsService(firebase);
  const product = { ...(service as any).validate({ name: 'Test', slug: 'test', sku: 'TEST', priceMinor: 100, inventoryQuantity: 1, status: 'ACTIVE' }, true), id: 'p', createdAt: 'original', updatedAt: 'original', createdBy: user.email };
  rows.set('products/p', product);
  const result = await service.update(user, 'p', { name: 'Test' });
  assert.equal(result.updatedAt, 'original');
  assert.equal(counts.writes, 0);
  await service.update(user, 'p', { name: 'Changed' });
  assert.equal(counts.writes, 2, 'one product write and one audit write for a real change');
  await service.archive(user, 'p');
  const writes = counts.writes;
  await service.archive(user, 'p');
  assert.equal(counts.writes, writes);
});

test('concurrent course and tool catalog reads share queries without caching later changes', async () => {
  const { rows, counts, firebase, db } = fixture();
  rows.set('course/course-a', { courseTitle: 'Original' });
  const service = new AcademySdkCatalogService(firebase);
  await Promise.all([service.getCourseById('course-a'), service.getCourseById('course-a')]);
  assert.equal(counts.reads, 1);
  rows.set('course/course-a', { courseTitle: 'Updated' });
  assert.equal((await service.getCourseById('course-a')).courseTitle, 'Updated');
  assert.equal(counts.reads, 2);
  const originalCollection = db.collection;
  let catalogReads = 0;
  db.collection = (path: string) => path === 'quantum_agent_tools' ? { get: async () => {
    catalogReads++;
    return { empty: true, docs: [] };
  } } : originalCollection(path);
  const tools = new QuantumAgentToolsService(firebase, new QuantumAgentDataService(firebase));
  await Promise.all([tools.catalog(), tools.catalog()]);
  assert.equal(catalogReads, 1);
  await tools.catalog();
  assert.equal(catalogReads, 2);
});
