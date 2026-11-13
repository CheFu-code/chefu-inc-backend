import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAuthUserProfile } from './auth-user-profile';

test('profile reads share work only inside one request and one identity', async () => {
  let reads = 0;
  const firebase: any = { db: () => ({ collection: () => ({ doc: (email: string) => ({
    get: async () => { reads++; return { data: () => ({ email, roles: ['admin'] }) }; },
  }) }) }) };
  const request: any = {};
  const first = readAuthUserProfile(firebase, 'alice@example.test', request);
  assert.equal(readAuthUserProfile(firebase, 'alice@example.test', request), first);
  assert.equal((await first).email, 'alice@example.test');
  assert.equal((await readAuthUserProfile(firebase, 'bob@example.test', request)).email, 'bob@example.test');
  assert.equal(reads, 2);
  await readAuthUserProfile(firebase, 'alice@example.test', {} as any);
  assert.equal(reads, 3, 'a new HTTP request revalidates the profile');
});

test('database errors fail closed within a request but do not poison the next request', async () => {
  let fail = true;
  let reads = 0;
  const firebase: any = { db: () => ({ collection: () => ({ doc: () => ({ get: async () => {
    reads++;
    if (fail) throw new Error('unavailable');
    return { data: () => ({ roles: [] }) };
  } }) }) }) };
  const request: any = {};
  await assert.rejects(readAuthUserProfile(firebase, 'alice@example.test', request), /unavailable/);
  await assert.rejects(readAuthUserProfile(firebase, 'alice@example.test', request), /unavailable/);
  assert.equal(reads, 1);
  fail = false;
  assert.deepEqual(await readAuthUserProfile(firebase, 'alice@example.test', {} as any), { roles: [] });
  assert.equal(reads, 2);
});
