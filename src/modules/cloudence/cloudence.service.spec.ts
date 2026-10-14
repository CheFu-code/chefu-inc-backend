import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudenceService } from './cloudence.service';
import type { CloudenceFileDocument } from './cloudence.types';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import type { RuntimeLimitService } from '../../common/runtime-limit.service';
import type { CloudinaryStorageService } from '../../common/cloudinary-storage.service';

const viewer = { uid: 'viewer', email: 'viewer@example.com', roles: ['user'] };

function file(id: string, uid = viewer.uid, email = viewer.email): CloudenceFileDocument {
  return {
    id, ownerId: uid, owner: { id: uid, email, fullName: email.split('@')[0] },
    name: `${id}.txt`, type: 'document', extension: 'txt', size: 10,
    url: 'https://example.com/file.txt', publicId: '', resourceType: 'raw',
    users: [viewer.email, 'other@example.com'], isDeleted: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fixture(files: CloudenceFileDocument[] = []) {
  const records = new Map<string, Record<string, unknown>>(
    files.map((value) => [`cloudenceFiles/${value.id}`, value]),
  );
  const authNames = new Map<string, string>();
  const authCalls: string[] = [];
  const profileBatches: string[][] = [];
  let failProfiles = false;
  const snapshot = (key: string) => ({ exists: records.has(key), data: () => records.get(key) });
  const doc = (key: string) => ({
    key,
    get: async () => snapshot(key),
    set: async (data: Record<string, unknown>) => { records.set(key, data); },
  });
  function collection(name: string, filters: Array<(data: Record<string, unknown>) => boolean> = []) {
    return {
      doc: (id: string) => doc(`${name}/${id}`),
      where: (field: string, op: string, value: unknown) => collection(name, [...filters, (data) =>
        op === 'array-contains' ? (data[field] as unknown[]).includes(value) : data[field] === value]),
      orderBy: () => collection(name, filters),
      limit: () => collection(name, filters),
      get: async () => ({ docs: [...records.entries()]
        .filter(([key, data]) => key.startsWith(`${name}/`) && filters.every((filter) => filter(data)))
        .map(([key]) => snapshot(key)) }),
    };
  }
  const db = {
    collection,
    getAll: async (...refs: Array<{ key: string }>) => {
      profileBatches.push(refs.map((ref) => ref.key));
      if (failProfiles) throw new Error('Profile store unavailable');
      return refs.map((ref) => snapshot(ref.key));
    },
  };
  const firebase = {
    db: () => db,
    auth: () => ({ getUser: async (uid: string) => {
      authCalls.push(uid);
      if (!authNames.has(uid)) throw new Error('Account unavailable');
      return { displayName: authNames.get(uid) };
    } }),
  };
  const service = new CloudenceService(
    firebase as unknown as FirebaseAdminService,
    { reserve: async () => ({ limited: false }) } as unknown as RuntimeLimitService,
    { uploadBuffer: async () => ({ secure_url: 'https://example.com/upload.txt', public_id: '', resource_type: 'raw' }) } as unknown as CloudinaryStorageService,
  );
  return { service, records, authNames, authCalls, profileBatches, failProfiles: () => { failProfiles = true; } };
}

test('existing owned and shared files use their own account names without exposing shared recipients', async () => {
  const f = fixture([file('owned'), file('shared', 'owner', 'owner@example.com'), file('shared-2', 'owner', 'owner@example.com')]);
  f.records.set('users/viewer@example.com', { fullname: 'Viewer Name' });
  f.records.set('users/owner@example.com', { fullname: '  Actual Owner  ' });
  const result = await f.service.list(viewer, {});
  assert.equal(result.documents.find((item) => item.id === 'owned')?.owner.fullName, 'Viewer Name');
  for (const shared of result.documents.filter((item) => item.id.startsWith('shared'))) {
    assert.equal(shared.owner.fullName, 'Actual Owner');
    assert.equal(shared.owner.id, 'owner');
    assert.deepEqual(shared.users, []);
  }
  assert.equal(f.profileBatches.length, 1);
  assert.equal(f.profileBatches[0].length, 2);
  assert.deepEqual(f.authCalls, []);
  // Reading old documents fixes the response without changing stored files.
  assert.equal((f.records.get('cloudenceFiles/shared')?.owner as { fullName: string }).fullName, 'owner');
});

test('name lookup uses first and last names, then Firebase display names for old placeholders', async () => {
  const f = fixture([file('owned'), file('shared', 'owner', 'owner@example.com')]);
  f.records.set('users/viewer@example.com', { fullname: ' ', firstName: 'First', lastName: 'Last' });
  f.records.set('users/owner@example.com', { fullname: 'owner' });
  f.authNames.set('owner', 'Firebase Owner');
  const result = await f.service.list(viewer, {});
  assert.equal(result.documents.find((item) => item.id === 'owned')?.owner.fullName, 'First Last');
  assert.equal(result.documents.find((item) => item.id === 'shared')?.owner.fullName, 'Firebase Owner');
});

test('profile failures preserve saved owner names and empty lists skip profile reads', async () => {
  const saved = file('owned');
  saved.owner.fullName = 'Saved Name';
  const f = fixture([saved]);
  f.failProfiles();
  assert.equal((await f.service.list(viewer, {})).documents[0].owner.fullName, 'Saved Name');
  const empty = fixture();
  assert.deepEqual((await empty.service.list(viewer, {})).documents, []);
  assert.deepEqual(empty.profileBatches, []);
});

test('sharing an old file refreshes and persists its account owner name', async () => {
  const f = fixture([file('owned')]);
  f.records.set('users/viewer@example.com', { fullname: 'Account Name' });
  const result = await f.service.update(viewer, 'owned', { users: ['friend@example.com'] });
  assert.equal(result.owner.fullName, 'Account Name');
  assert.equal((f.records.get('cloudenceFiles/owned')?.owner as { fullName: string }).fullName, 'Account Name');
});

test('new uploads store the account owner name', async () => {
  const f = fixture();
  f.records.set('users/viewer@example.com', { fullname: 'Account Name' });
  f.records.set('cloudence_quotas/viewer', { used: 0 });
  const keys = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key) => { process.env[key] = 'test-value'; });
  try {
    const result = await f.service.upload(viewer, Buffer.from('Plain file content'), 'notes.txt', 'text/plain');
    assert.equal(result.owner.fullName, 'Account Name');
    assert.equal((f.records.get(`cloudenceFiles/${result.id}`)?.owner as { fullName: string }).fullName, 'Account Name');
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
