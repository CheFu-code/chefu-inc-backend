import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from './auth.guard';
import { ShopYethuAdminGuard } from './shopyethu-admin.guard';
import { ShopYethuSessionController } from './shopyethu-session.controller';

test('ShopYethu endpoint validates the central cookie and fresh roles before exposing identity', async () => {
  let roles: unknown = ['admin'];
  let revoked = false;
  let profileReads = 0;
  const checks: unknown[][] = [];
  const firebase: any = {
    auth: () => ({ verifySessionCookie: async (...args: unknown[]) => {
      checks.push(args);
      if (revoked) throw new Error('revoked');
      return { uid: 'uid', email: 'staff@example.test' };
    } }),
    db: () => ({ collection: (collection: string) => {
      assert.equal(collection, 'users');
      return { doc: (email: string) => {
        assert.equal(email, 'staff@example.test');
        return { get: async () => { profileReads++; return { data: () => ({ fullname: 'Staff', roles }) }; } };
      } };
    } }),
  };
  const auth = new AuthGuard(firebase, {} as any, { inspectRequest: async () => {} } as any,
    { verify: () => ({ uid: 'uid', email: 'staff@example.test', roles: ['admin'] }) } as any);
  (auth as any).logger = { log() {}, warn() {} };
  const admin = new ShopYethuAdminGuard(firebase);
  let request: any = { ip: '127.0.0.1', socket: {}, headers: {}, cookies: { __session: 'central-cookie', __session_meta: 'signed-old-admin' } };
  const context: any = { switchToHttp: () => ({ getRequest: () => request }) };
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ShopYethuSessionController), [AuthGuard, ShopYethuAdminGuard]);
  assert.equal(await auth.canActivate(context), true);
  assert.equal(await admin.canActivate(context), true);
  assert.equal(profileReads, 1);
  assert.deepEqual(checks, [['central-cookie', true]]);
  const headers = new Map();
  const response: any = { setHeader: (name: string, value: string) => headers.set(name, value) };
  assert.deepEqual(new ShopYethuSessionController().getSession(request, response), {
    app: 'shopyethu', user: { uid: 'uid', email: 'staff@example.test', name: 'Staff' },
  });
  assert.equal(headers.get('Cache-Control'), 'private, no-store');

  for (const removed of [[], ['user'], undefined, ['administrator'], [null, 123]]) {
    roles = removed;
    request = { ...request, user: undefined, shopyethuAccount: undefined };
    const before: number = profileReads;
    assert.equal(await auth.canActivate(context), true, 'old signed metadata still contains admin');
    await assert.rejects(admin.canActivate(context), (error: any) => error.getStatus() === 403);
    assert.equal(profileReads - before, 1, 'each new request reads current permissions once');
  }
  roles = [' ADMIN '];
  request = { ...request, user: { uid: 'uid', email: 'staff@example.test', roles: [] } };
  assert.equal(await admin.canActivate(context), true);
  revoked = true;
  await assert.rejects(auth.canActivate(context), (error: any) => error.getStatus() === 401);
  request.cookies = {};
  await assert.rejects(auth.canActivate(context), (error: any) => error.getStatus() === 401);
  delete request.user;
  await assert.rejects(admin.canActivate(context), (error: any) => error.getStatus() === 401);
});

test('missing session metadata uses one profile read across both guards and never writes', async () => {
  const counts = { reads: 0, writes: 0, verifications: 0 };
  let roles = ['admin'];
  const firebase: any = {
    auth: () => ({ verifySessionCookie: async (_cookie: string, revoked: boolean) => {
      assert.equal(revoked, true);
      counts.verifications++;
      return { uid: 'uid', email: 'staff@example.test' };
    } }),
    db: () => ({ collection: () => ({ doc: () => ({
      get: async () => { counts.reads++; return { data: () => ({ roles, fullname: 'Staff' }) }; },
      set: async () => { counts.writes++; }, update: async () => { counts.writes++; },
    }) }) }),
  };
  const auth = new AuthGuard(firebase, {} as any, { inspectRequest: async () => {} } as any, { verify: () => null } as any);
  (auth as any).logger = { log() {}, warn() {} };
  const admin = new ShopYethuAdminGuard(firebase);
  const context = () => {
    const request = { ip: '127.0.0.1', socket: {}, headers: {}, cookies: { __session: 'central-cookie' } };
    return { switchToHttp: () => ({ getRequest: () => request }) } as any;
  };
  const first = context();
  await auth.canActivate(first);
  await admin.canActivate(first);
  assert.deepEqual(counts, { reads: 1, writes: 0, verifications: 1 });
  roles = [];
  const second = context();
  await auth.canActivate(second);
  await assert.rejects(admin.canActivate(second), (error: any) => error.getStatus() === 403);
  assert.deepEqual(counts, { reads: 2, writes: 0, verifications: 2 }, 'later requests must not reuse stale roles');
});
