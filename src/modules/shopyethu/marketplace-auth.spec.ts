import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MarketplaceAuthGuard } from './marketplace-auth.guard';
import { MarketplaceCustomerController } from './marketplace.controller';
import { MarketplaceAdminController } from './marketplace-admin.controller';
import { AuthGuard } from '../auth/auth.guard';
import { ShopYethuAdminGuard } from '../auth/shopyethu-admin.guard';

test('all private marketplace routes require backend authentication; staff mutations require fresh admin permissions', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, MarketplaceCustomerController), [MarketplaceAuthGuard]);
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, MarketplaceAdminController), [AuthGuard, ShopYethuAdminGuard]);
});

test('marketplace authentication accepts only verified ShopYethu access tokens and ignores client roles', async () => {
  let claims: any = { typ: 'access_token', app: 'shopyethu', sub: 'unit-test-user', email: 'user@example.test', roles: ['admin'] };
  const guard = new MarketplaceAuthGuard({ verifyAccessToken: async (token: string) => {
    assert.equal(token, 'test-access-token'); return claims;
  } } as any);
  const request: any = { method: 'GET', headers: { authorization: 'Bearer test-access-token' } };
  const headers = new Map();
  const context: any = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: (key: string, value: string) => headers.set(key, value) }) }) };
  assert.equal(await guard.canActivate(context), true);
  assert.deepEqual(request.user.roles, [], 'a mobile token cannot grant staff privileges');
  assert.equal(headers.get('Cache-Control'), 'private, no-store');
  for (const invalid of [{ ...claims, app: 'liftwise' }, { ...claims, typ: 'id_token' }, { ...claims, sub: '../other' }, { ...claims, email: '' }]) {
    claims = invalid;
    await assert.rejects(guard.canActivate(context), (error: any) => error.getStatus() === 401);
  }
  delete request.headers.authorization;
  await assert.rejects(guard.canActivate(context), (error: any) => error.getStatus() === 401);
  request.method = 'POST'; request.body = [];
  await assert.rejects(guard.canActivate(context), (error: any) => error.getStatus() === 400);
});
