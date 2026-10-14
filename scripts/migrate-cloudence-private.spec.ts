import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import { FieldValue } from 'firebase-admin/firestore';
import { v2 as cloudinary } from 'cloudinary';
import { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';
import { migrateCloudencePrivate } from './migrate-cloudence-private';

function fixture(t: TestContext, file?: Record<string, unknown>, migration?: Record<string, unknown>) {
  const records = new Map<string, Record<string, unknown>>();
  if (file) records.set('cloudenceFiles/file-1', { ...file });
  if (migration) records.set('systemMigrations/cloudence-private-storage-v1', { ...migration });
  let scans = 0;
  let stateReads = 0;
  let renames = 0;
  const writes: string[] = [];
  const reference = (path: string) => ({
    path,
    get: async () => {
      if (path.startsWith('systemMigrations/')) stateReads++;
      return { data: () => records.get(path) };
    },
    set: async (value: Record<string, unknown>) => {
      writes.push(path);
      const next = { ...records.get(path) };
      for (const [key, item] of Object.entries(value)) {
        if (item instanceof FieldValue && item.isEqual(FieldValue.delete())) delete next[key];
        else next[key] = item;
      }
      records.set(path, next);
    },
  });
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => reference(`${collection}/${id}`),
      orderBy: () => {
        let cursor = '';
        const query = {
          limit: () => query,
          startAfter: (value: string) => { cursor = value; return query; },
          get: async () => {
            scans++;
            const docs = [...records.entries()].filter(([path]) => path.startsWith(`${collection}/`) && path.split('/')[1] > cursor)
              .map(([path, data]) => ({ id: path.split('/')[1], data: () => data, ref: reference(path) }));
            return { empty: docs.length === 0, docs };
          },
        };
        return query;
      },
    }),
    runTransaction: async (work: (transaction: unknown) => Promise<unknown>) => work({
      get: (ref: ReturnType<typeof reference>) => ref.get(),
      set: (ref: ReturnType<typeof reference>, value: Record<string, unknown>) => { void ref.set(value); },
    }),
  };
  t.mock.method(FirebaseAdminService.prototype, 'db', () => db);
  t.mock.method(cloudinary, 'config', () => ({}));
  t.mock.method(cloudinary, 'url', () => 'https://res.cloudinary.com/demo/image/upload/old.png');
  t.mock.method(cloudinary.uploader, 'rename', async (_source, target, options) => {
    renames++;
    assert.equal(options.to_type, 'authenticated');
    return { public_id: target, type: 'authenticated', secure_url: 'https://res.cloudinary.com/demo/image/authenticated/new.png' };
  });
  t.mock.method(global, 'fetch', async () => new Response(null, { status: 404 }));
  for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
    const original = process.env[key];
    process.env[key] = 'migration-test-value';
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  return { records, writes, get scans() { return scans; }, get stateReads() { return stateReads; }, get renames() { return renames; } };
}

const legacy = { ownerId: 'owner', publicId: 'chefu/cloudence/owner/old', resourceType: 'image', extension: 'png', url: 'https://res.cloudinary.com/demo/image/upload/old.png' };
const stateKey = 'systemMigrations/cloudence-private-storage-v1';

test('automatic migration runs once even with pending CDN links; manual verification remains available', async (t) => {
  const f = fixture(t, legacy);
  t.mock.method(global, 'fetch', async () => new Response('x', { status: 206 }));
  assert.equal(await migrateCloudencePrivate({ apply: true, once: true }), 2);
  assert.ok(f.records.get(stateKey)?.automaticAttemptedAt);
  assert.equal(f.records.get(stateKey)?.automaticExitCode, 2);
  assert.equal(f.records.get(stateKey)?.completedAt, undefined);
  const scans = f.scans;
  const writes = f.writes.length;
  const reads = f.stateReads;
  assert.equal(await migrateCloudencePrivate({ apply: true, once: true }), 0);
  assert.equal(f.scans, scans);
  assert.equal(f.writes.length, writes);
  assert.equal(f.stateReads - reads, 1);
  t.mock.method(global, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await migrateCloudencePrivate({ apply: true }), 0);
  assert.ok(f.records.get(stateKey)?.completedAt);
});

test('failed automatic attempts are not repeated on later deployments', async (t) => {
  const f = fixture(t, legacy);
  t.mock.method(cloudinary.uploader, 'rename', async () => { throw new Error('Provider unavailable'); });
  t.mock.method(cloudinary.api, 'resource', async () => { throw new Error('Target missing'); });
  await assert.rejects(migrateCloudencePrivate({ apply: true, once: true }), /Provider unavailable/);
  assert.ok(f.records.get(stateKey)?.automaticAttemptedAt);
  assert.equal(f.records.get(stateKey)?.completedAt, undefined);
  const scans = f.scans;
  assert.equal(await migrateCloudencePrivate({ apply: true, once: true }), 0);
  assert.equal(f.scans, scans);
});

test('a finished migration costs one marker read and no file scans, writes, or Cloudinary calls', async (t) => {
  const f = fixture(t, legacy, { completedAt: 'done' });
  assert.equal(await migrateCloudencePrivate({ apply: true }), 0);
  assert.equal(f.stateReads, 1);
  assert.equal(f.scans, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.renames, 0);
});

test('full migration protects files and marks completion only after old URLs are revoked', async (t) => {
  const f = fixture(t, legacy);
  assert.equal(await migrateCloudencePrivate({ apply: true }), 0);
  assert.equal(f.renames, 1);
  const protectedFile = f.records.get('cloudenceFiles/file-1')!;
  assert.equal(protectedFile.deliveryType, 'authenticated');
  assert.equal(protectedFile.privateMigration, undefined);
  assert.ok(f.records.get(stateKey)?.completedAt);
  assert.equal(f.records.get(stateKey)?.runId, undefined);
  const scans = f.scans;
  await migrateCloudencePrivate({ apply: true });
  assert.equal(f.scans, scans);
});

test('pending CDN links retain the plan and retry without renaming or rewriting protected storage', async (t) => {
  const f = fixture(t, legacy);
  t.mock.method(global, 'fetch', async () => new Response('x', { status: 206 }));
  assert.equal(await migrateCloudencePrivate({ apply: true }), 2);
  assert.equal(f.records.get(stateKey)?.completedAt, undefined);
  assert.ok(f.records.get('cloudenceFiles/file-1')?.privateMigration);
  const fileWrites = f.writes.filter((path) => path.startsWith('cloudenceFiles/')).length;
  assert.equal(await migrateCloudencePrivate({ apply: true }), 2);
  assert.equal(f.renames, 1);
  assert.equal(f.writes.filter((path) => path.startsWith('cloudenceFiles/')).length, fileWrites);
  t.mock.method(global, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await migrateCloudencePrivate({ apply: true }), 0);
  assert.ok(f.records.get(stateKey)?.completedAt);
});

test('dry runs and limited migrations never mark the full migration complete', async (t) => {
  const f = fixture(t, legacy);
  assert.equal(await migrateCloudencePrivate({ apply: false }), 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.renames, 0);
  assert.equal(await migrateCloudencePrivate({ apply: true, limit: 1 }), 0);
  assert.equal(f.records.get(stateKey)?.completedAt, undefined);
});

test('active migration leases stop competing deployments before changing any files', async (t) => {
  const f = fixture(t, legacy, { runId: 'other', leaseUntil: Date.now() + 60_000 });
  await assert.rejects(migrateCloudencePrivate({ apply: true }), /already running/);
  assert.equal(f.scans, 0);
  assert.equal(f.renames, 0);
  assert.equal(f.writes.length, 0);
});

test('provider failures preserve the resume plan, release the lease, and do not mark completion', async (t) => {
  const f = fixture(t, legacy);
  t.mock.method(cloudinary.uploader, 'rename', async () => { throw new Error('Provider unavailable'); });
  t.mock.method(cloudinary.api, 'resource', async () => { throw new Error('Target missing'); });
  await assert.rejects(migrateCloudencePrivate({ apply: true }), /Provider unavailable/);
  assert.ok(f.records.get('cloudenceFiles/file-1')?.privateMigration);
  assert.equal(f.records.get(stateKey)?.completedAt, undefined);
  assert.equal(f.records.get(stateKey)?.runId, undefined);
});
