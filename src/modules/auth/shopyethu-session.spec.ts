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
        return { get: async () => ({ data: () => ({ fullname: 'Staff', roles }) }) };
      } };
    } }),
  };
  const auth = new AuthGuard(firebase, {} as any, { inspectRequest: async () => {} } as any,
    { verify: () => ({ uid: 'uid', email: 'staff@example.test', roles: ['admin'] }) } as any);
  (auth as any).logger = { log() {}, warn() {} };
  const admin = new ShopYethuAdminGuard(firebase);
  const request: any = { ip: '127.0.0.1', socket: {}, headers: {}, cookies: { __session: 'central-cookie', __session_meta: 'signed-old-admin' } };
  const context: any = { switchToHttp: () => ({ getRequest: () => request }) };
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ShopYethuSessionController), [AuthGuard, ShopYethuAdminGuard]);
  assert.equal(await auth.canActivate(context), true);
  assert.equal(await admin.canActivate(context), true);
  assert.deepEqual(checks, [['central-cookie', true]]);
  const headers = new Map();
  const response: any = { setHeader: (name: string, value: string) => headers.set(name, value) };
  assert.deepEqual(new ShopYethuSessionController().getSession(request, response), {
    app: 'shopyethu', user: { uid: 'uid', email: 'staff@example.test', name: 'Staff' },
  });
  assert.equal(headers.get('Cache-Control'), 'private, no-store');

  for (const removed of [[], ['user'], undefined, ['administrator'], [null, 123]]) {
    roles = removed;
    assert.equal(await auth.canActivate(context), true, 'old signed metadata still contains admin');
    await assert.rejects(admin.canActivate(context), (error: any) => error.getStatus() === 403);
  }
  roles = [' ADMIN '];
  assert.equal(await admin.canActivate(context), true);
  revoked = true;
  await assert.rejects(auth.canActivate(context), (error: any) => error.getStatus() === 401);
  request.cookies = {};
  await assert.rejects(auth.canActivate(context), (error: any) => error.getStatus() === 401);
  delete request.user;
  await assert.rejects(admin.canActivate(context), (error: any) => error.getStatus() === 401);
});
