import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldValue } from 'firebase-admin/firestore';
import { MAX_STORAGE_BYTES } from './cloudence.constants';
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
  let failTransactions = false;
  const versions = new Map<string, number>();
  let epoch = 0;
  const operations = { quotaReads: 0, quotaWrites: 0 };
  const snapshot = (key: string) => {
    const value = records.get(key);
    const cloned = value ? structuredClone(value) : undefined;
    return { exists: !!value, data: () => cloned };
  };
  function write(key: string, data: Record<string, unknown>, merge = false) {
    if (key.startsWith('cloudence_quotas/')) operations.quotaWrites++;
    const next = merge ? { ...records.get(key) } : {} as Record<string, unknown>;
    for (const [field, value] of Object.entries(data)) {
      if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete next[field];
      else if (value !== undefined) next[field] = value;
    }
    records.set(key, next);
    versions.set(key, (versions.get(key) || 0) + 1);
    epoch++;
  }
  const doc = (key: string) => ({
    key,
    get: async () => snapshot(key),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => { write(key, data, options?.merge); },
  });
  function collection(name: string, filters: Array<(data: Record<string, unknown>) => boolean> = []) {
    return {
      doc: (id: string) => doc(`${name}/${id}`),
      where: (field: string, op: string, value: unknown) => collection(name, [...filters, (data) =>
        op === 'array-contains' ? (data[field] as unknown[]).includes(value) : data[field] === value]),
      orderBy: () => collection(name, filters),
      limit: () => collection(name, filters),
      select: () => collection(name, filters),
      get: async () => ({ docs: [...records.entries()]
        .filter(([key, data]) => key.startsWith(`${name}/`) && filters.every((filter) => filter(data)))
        .map(([key]) => snapshot(key)) }),
    };
  }
  const db = {
    collection,
    runTransaction: async <T>(operation: (transaction: any) => Promise<T>): Promise<T> => {
      if (failTransactions) throw new Error('Quota store unavailable');
      for (let retry = 0; retry < 20; retry++) {
        const reads = new Map<string, number>();
        let queryEpoch: number | undefined;
        const writes: Array<{ key: string; data: Record<string, unknown> }> = [];
        const transaction = {
          get: async (target: { key?: string; get(): Promise<unknown> }) => {
            if (target.key) {
              if (target.key.startsWith('cloudence_quotas/')) operations.quotaReads++;
              reads.set(target.key, versions.get(target.key) || 0);
              return snapshot(target.key);
            }
            queryEpoch = epoch;
            return target.get();
          },
          set: (ref: { key: string }, data: Record<string, unknown>) => { writes.push({ key: ref.key, data }); },
        };
        const result = await operation(transaction);
        if ([...reads].some(([key, version]) => (versions.get(key) || 0) !== version) || (queryEpoch !== undefined && queryEpoch !== epoch)) continue;
        writes.forEach(({ key, data }) => write(key, data));
        return result;
      }
      throw new Error('Transaction retry limit exceeded');
    },
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
  const uploads: string[] = [];
  const deletions: string[] = [];
  let uploadHandler: (() => Promise<void>) | undefined;
  const service = new CloudenceService(
    firebase as unknown as FirebaseAdminService,
    { reserve: async () => ({ limited: false }) } as unknown as RuntimeLimitService,
    {
      uploadBuffer: async () => {
        const id = `asset-${uploads.length}`;
        uploads.push(id);
        await uploadHandler?.();
        return { secure_url: 'https://example.com/upload.txt', public_id: id, resource_type: 'raw' };
      },
      delete: async (id: string) => { deletions.push(id); },
    } as unknown as CloudinaryStorageService,
  );
  return { service, records, operations, authNames, authCalls, profileBatches, uploads, deletions, setUploadHandler: (handler: () => Promise<void>) => { uploadHandler = handler; }, failProfiles: () => { failProfiles = true; }, failTransactions: () => { failTransactions = true; } };
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

function quota(used: number) {
  return { used, image: { size: 0, latestDate: '' }, document: { size: used, latestDate: '' }, video: { size: 0, latestDate: '' }, audio: { size: 0, latestDate: '' }, other: { size: 0, latestDate: '' } };
}

async function withUploadConfig(operation: () => Promise<void>) {
  const keys = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key) => { process.env[key] = 'test-value'; });
  try { await operation(); } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

test('concurrent uploads cannot exceed quota and rejected assets are cleaned up', async () => withUploadConfig(async () => {
  const f = fixture();
  f.records.set('users/viewer@example.com', { fullname: 'Viewer' });
  f.records.set('cloudence_quotas/viewer', quota(MAX_STORAGE_BYTES - 10));
  let release!: () => void;
  const bothUploading = new Promise<void>((resolve) => { release = resolve; });
  f.setUploadHandler(async () => { if (f.uploads.length === 2) release(); await bothUploading; });
  const results = await Promise.allSettled([
    f.service.upload(viewer, Buffer.from('abcdef'), 'one.txt', 'text/plain'),
    f.service.upload(viewer, Buffer.from('abcdef'), 'two.txt', 'text/plain'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.records.get('cloudence_quotas/viewer')?.used, MAX_STORAGE_BYTES - 4);
  assert.equal([...f.records.keys()].filter((key) => key.startsWith('cloudenceFiles/')).length, 1);
  assert.equal(f.deletions.length, 1);
}));

test('concurrent uploads retain the exact total and cold quota initialization includes legacy files', async () => withUploadConfig(async () => {
  const f = fixture([file('legacy')]);
  f.records.set('users/viewer@example.com', { fullname: 'Viewer' });
  await Promise.all([
    f.service.upload(viewer, Buffer.from('abc'), 'one.txt', 'text/plain'),
    f.service.upload(viewer, Buffer.from('abcdef'), 'two.txt', 'text/plain'),
  ]);
  assert.equal(f.records.get('cloudence_quotas/viewer')?.used, 19);
  assert.equal((f.records.get('cloudence_quotas/viewer')?.document as { size: number }).size, 19);
  assert.equal((await f.service.usage(viewer)).used, 19);
}));

test('concurrent deletes decrement quota once and edits cannot restore a deleted file', async () => {
  const f = fixture([file('owned')]);
  f.records.set('users/viewer@example.com', { fullname: 'Viewer' });
  f.records.set('cloudence_quotas/viewer', quota(10));
  const results = await Promise.allSettled([
    f.service.remove(viewer, 'owned'), f.service.remove(viewer, 'owned'),
    f.service.update(viewer, 'owned', { name: 'renamed.txt' }),
  ]);
  assert.equal(results.slice(0, 2).filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.records.get('cloudence_quotas/viewer')?.used, 0);
  assert.equal(f.records.get('cloudenceFiles/owned')?.isDeleted, true);
});

test('concurrent rename and sharing updates preserve both changes', async () => {
  const f = fixture([file('owned')]);
  f.records.set('users/viewer@example.com', { fullname: 'Viewer' });
  await Promise.all([
    f.service.update(viewer, 'owned', { name: 'renamed.txt' }),
    f.service.update(viewer, 'owned', { users: ['friend@example.com'] }),
  ]);
  assert.equal(f.records.get('cloudenceFiles/owned')?.name, 'renamed.txt');
  assert.deepEqual(f.records.get('cloudenceFiles/owned')?.users, ['friend@example.com']);
});

test('expiry-only updates support future dates and clearing but reject past dates and non-owners', async () => {
  const f = fixture([file('owned')]);
  f.records.set('users/viewer@example.com', { fullname: 'Viewer' });
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await f.service.update(viewer, 'owned', { shareExpiresAt: future })).shareExpiresAt, future);
  await assert.rejects(f.service.update(viewer, 'owned', { shareExpiresAt: '2000-01-01' }), /future/);
  await assert.rejects(f.service.update({ uid: 'other', email: 'other@example.com', roles: [] }, 'owned', { shareExpiresAt: future }), /owner/);
  const cleared = await f.service.update(viewer, 'owned', { shareExpiresAt: '' });
  assert.equal(cleared.shareExpiresAt, undefined);
  assert.equal('shareExpiresAt' in f.records.get('cloudenceFiles/owned')!, false);
  assert.equal(cleared.isOwner, true);
  await assert.rejects(f.service.update(viewer, 'owned', { name: 'changed.pdf' }), /format/);
});

test('quota lookup failures stop uploads before sending an asset to storage', async () => withUploadConfig(async () => {
  const f = fixture();
  f.failTransactions();
  await assert.rejects(f.service.upload(viewer, Buffer.from('content'), 'test.txt', 'text/plain'), /Quota store unavailable/);
  assert.deepEqual(f.uploads, []);
}));

test('expired sharing hides files from recipients and blocks download requests', async () => {
  const shared = file('shared', 'owner', 'owner@example.com');
  shared.shareExpiresAt = '2000-01-01T00:00:00Z';
  const f = fixture([shared]);
  assert.deepEqual((await f.service.list(viewer, {})).documents, []);
  await assert.rejects(f.service.getDownloadUrl(viewer, 'shared'), /expired/);
});

test('owner names are reused without extra profile reads until the display cache expires', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture([file('owned')]);
  f.records.set('users/viewer@example.com', { fullname: 'Original Name' });
  await f.service.list(viewer, {});
  f.records.set('users/viewer@example.com', { fullname: 'New Name' });
  assert.equal((await f.service.list(viewer, {})).documents[0].owner.fullName, 'Original Name');
  assert.equal(f.profileBatches.length, 1);
  now += 5 * 60_000 + 1;
  assert.equal((await f.service.list(viewer, {})).documents[0].owner.fullName, 'New Name');
  assert.equal(f.profileBatches.length, 2);
});

test('overlapping cold quota requests share one database lookup and initialization', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 10 }, () => f.service.usage(viewer)));
  assert.deepEqual(f.operations, { quotaReads: 1, quotaWrites: 1 });
  await f.service.usage(viewer);
  assert.deepEqual(f.operations, { quotaReads: 1, quotaWrites: 1 });
});

test('warm uploads use only the authoritative quota read and write while enforcing the cap', async () => withUploadConfig(async () => {
  const f = fixture();
  f.records.set('users/viewer@example.com', { fullname: 'Viewer' });
  f.records.set('cloudence_quotas/viewer', quota(0));
  await f.service.usage(viewer);
  const before = { ...f.operations };
  await f.service.upload(viewer, Buffer.from('content'), 'test.txt', 'text/plain');
  assert.equal(f.operations.quotaReads - before.quotaReads, 1);
  assert.equal(f.operations.quotaWrites - before.quotaWrites, 1);
  assert.equal((await f.service.usage(viewer)).used, 7);
  assert.equal(f.operations.quotaReads - before.quotaReads, 1);
  // Simulate another server taking the remaining space while this instance has a cached low total.
  f.records.set('cloudence_quotas/viewer', quota(MAX_STORAGE_BYTES));
  await assert.rejects(f.service.upload(viewer, Buffer.from('content'), 'retry.txt', 'text/plain'), /quota/);
  assert.equal(f.deletions.length, 1);
}));

test('recipient deltas preserve concurrent additions and removals', async () => {
  const f = fixture([file('owned')]);
  f.records.set('users/viewer@example.com', { fullname: 'Viewer' });
  await Promise.all([
    f.service.update(viewer, 'owned', { addUsers: ['alice@example.com'] }),
    f.service.update(viewer, 'owned', { addUsers: ['bob@example.com'] }),
    f.service.update(viewer, 'owned', { removeUsers: ['other@example.com'] }),
  ]);
  assert.deepEqual((f.records.get('cloudenceFiles/owned')?.users as string[]).sort(), [viewer.email, 'alice@example.com', 'bob@example.com'].sort());
  await assert.rejects(f.service.update(viewer, 'owned', { addUsers: ['invalid'] }), /valid email/);
  await assert.rejects(f.service.update(viewer, 'owned', { users: [], addUsers: [] }), /either/);
});
