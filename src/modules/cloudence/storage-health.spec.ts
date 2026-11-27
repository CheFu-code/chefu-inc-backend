import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '../auth/auth.guard';
import type { CloudenceFileDocument } from './cloudence.types';
import { analyzeStorageHealth, HEALTH_ITEMS_LIMIT, HEALTH_SCAN_LIMIT } from './storage-health.analysis';
import { StorageHealthController, StorageHealthService } from './storage-health.controller';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const now = Date.parse('2026-11-27T12:00:00Z');
const MB = 1024 ** 2;
const user = { uid: 'a', email: 'a@example.com', roles: [] };
function file(id: string, input: Partial<CloudenceFileDocument> = {}): CloudenceFileDocument {
  return { id, name: `${id}.txt`, ownerId: 'a', owner: { id: 'a', fullName: 'A', email: user.email },
    type: 'document', extension: 'txt', size: 10, users: [], createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z', url: 'https://private-provider', publicId: `private-storage-key-${id}`, resourceType: 'raw', ...input };
}

void test('duplicate proof requires a valid matching hash and size, excludes deleted and foreign files', () => {
  const report = analyzeStorageHealth([
    file('original', { sha256: 'a'.repeat(64), users: ['teammate@example.com'] }),
    file('copy', { sha256: 'a'.repeat(64) }),
    file('different-size', { sha256: 'a'.repeat(64), size: 20 }),
    file('same-name', { name: 'copy.txt', sha256: 'b'.repeat(64) }),
    file('missing-hash'), file('bad-hash', { sha256: 'invalid' }),
    file('deleted', { sha256: 'a'.repeat(64), isDeleted: true }),
    file('foreign', { ownerId: 'b', sha256: 'a'.repeat(64) }),
  ], 'a', now);
  assert.equal(report.scannedFiles, 6);
  assert.equal(report.unhashedFiles, 2);
  assert.equal(report.duplicateBytes, 10);
  assert.equal(report.categories.duplicates.items[0].file.id, 'copy');
  assert.equal(report.categories.duplicates.items[0].keepId, 'original');
  assert.ok(!JSON.stringify(report).includes('private-provider'));
  assert.ok(!JSON.stringify(report).includes('private-storage-key'));
  assert.ok(!JSON.stringify(report).includes('sha256'));
});

void test('version suggestions use numeric suffixes, retain the newest and do not imply a real version history', () => {
  const report = analyzeStorageHealth([
    file('v9', { name: 'Report_v9.txt' }), file('v10', { name: 'Report_v10.txt' }),
    file('other', { name: 'Report_final.txt' }), file('unrelated', { name: 'Else_v1.txt' }),
  ], 'a', now);
  assert.equal(report.categories.versions.count, 1);
  assert.equal(report.categories.versions.items[0].file.id, 'v9');
  assert.equal(report.categories.versions.items[0].keepId, 'v10');
});

void test('large media thresholds and older-file suggestions do not double count candidates', () => {
  const old = new Date(now - 90 * 86400000).toISOString();
  const report = analyzeStorageHealth([
    file('photo', { type: 'image', size: 10 * MB, updatedAt: old }),
    file('video', { type: 'video', size: 25 * MB }),
    file('small', { type: 'image', size: 10 * MB - 1 }),
    file('old', { updatedAt: old }), file('invalid-date', { updatedAt: 'not-a-date' }),
    file('shared-old', { updatedAt: old, users: ['b@example.com'] }),
  ], 'a', now);
  assert.equal(report.categories.largeMedia.count, 2);
  assert.equal(report.categories.olderFiles.count, 1);
  assert.equal(report.reviewedBytes, 35 * MB + 10);
});

void test('duplicate keepers remain protected from other cleanup suggestions', () => {
  const report = analyzeStorageHealth([
    file('keep', { name: 'photo.jpg', type: 'image', size: 20 * MB, sha256: 'a'.repeat(64), createdAt: '2020-01-01', updatedAt: '2020-01-01' }),
    file('copy', { name: 'photo.jpg', type: 'image', size: 20 * MB, sha256: 'a'.repeat(64) }),
  ], 'a', now);
  assert.equal(report.categories.duplicates.count, 1);
  assert.equal(report.categories.largeMedia.count, 0);
  assert.equal(report.categories.olderFiles.count, 0);
  assert.equal(report.reviewedBytes, 20 * MB);
});

void test('bounded review lists retain accurate totals and partial-scan disclosure', () => {
  const report = analyzeStorageHealth(Array.from({ length: HEALTH_ITEMS_LIMIT + 8 }, (_, i) =>
    file(String(i), { type: 'video', size: 30 * MB })), 'a', now, true);
  assert.equal(report.truncated, true);
  assert.equal(report.categories.largeMedia.count, HEALTH_ITEMS_LIMIT + 8);
  assert.equal(report.categories.largeMedia.items.length, HEALTH_ITEMS_LIMIT);
});

void test('legacy records referencing the same provider object are never suggested for deletion', () => {
  const report = analyzeStorageHealth([
    file('one', { sha256: 'a'.repeat(64), publicId: 'same-object', updatedAt: '2020-01-01' }),
    file('two', { sha256: 'a'.repeat(64), publicId: 'same-object', updatedAt: '2020-01-01' }),
  ], 'a', now);
  assert.equal(report.reviewedBytes, 0);
  assert.equal(report.categories.duplicates.count, 0);
});

void test('the authenticated service scans only its owner with a bounded query and safe projection', async () => {
  const calls: unknown[] = [];
  const query = {
    where: (...args: unknown[]) => { calls.push(args); return query; },
    select: (...args: unknown[]) => { calls.push(args); return query; },
    limit: (size: number) => { calls.push(size); return query; },
    get: async () => ({ docs: [{ id: 'owned', data: () => file('owned') }], size: 1 }),
  };
  const firebase = { db: () => ({ collection: () => query }) } as unknown as FirebaseAdminService;
  const service = new StorageHealthService(firebase);
  assert.equal((await service.scan(user)).scannedFiles, 1);
  assert.deepEqual(calls[0], ['ownerId', '==', 'a']);
  assert.equal(calls[2], HEALTH_SCAN_LIMIT + 1);
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, StorageHealthController), [AuthGuard]);
  assert.throws(() => new StorageHealthController(service).scan({} as never), /Authenticated user missing/);
});
