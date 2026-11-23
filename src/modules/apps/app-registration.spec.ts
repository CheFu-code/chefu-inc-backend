import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AppsService } from './apps.service';
import { AppsController } from './apps.controller';
import { AuthGuard } from '../auth/auth.guard';
import { UserManagementGuard } from '../user-management/user-management.guard';
import { validateRegistration, type RegistrationInput } from './app-validation';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const input: RegistrationInput = { appId: 'new-product', clientId: 'new-product-web', name: 'New product', owner: 'owner@example.test', origins: ['https://new.example.test'], redirectUris: ['https://new.example.test/callback'], allowedScopes: ['openid', 'profile', 'email'] };

function fixture() {
  const rows = new Map<string, any>();
  let sequence = 0;
  const snapshot = (id: string) => ({ id: id.split('/').at(-1), exists: rows.has(id), data: () => rows.get(id) });
  function collection(name: string) {
    const conditions: [string, string, unknown][] = [];
    let maximum = Infinity;
    const query = {
      doc: (id = String(++sequence)) => ({ path: `${name}/${id}`, get: async () => snapshot(`${name}/${id}`) }),
      where: (key: string, op: string, value: unknown) => { conditions.push([key, op, value]); return query; },
      orderBy: () => query,
      limit: (value: number) => { maximum = value; return query; },
      get: async () => {
        const docs = [...rows.keys()].filter(id => id.startsWith(`${name}/`) && conditions.every(([key, op, value]) => op === 'array-contains' ? rows.get(id)[key]?.includes(value) : rows.get(id)[key] === value)).slice(0, maximum).map(snapshot);
        return { docs, empty: !docs.length };
      },
    };
    return query;
  }
  const db = { collection, batch: () => {
    const operations: { path: string; data: any; create?: boolean }[] = [];
    return {
      create: (ref: any, data: any) => operations.push({ path: ref.path, data, create: true }),
      update: (ref: any, data: any) => operations.push({ path: ref.path, data }),
      commit: async () => {
        if (operations.some(op => op.create && rows.has(op.path))) throw Object.assign(new Error('duplicate'), { code: 6 });
        for (const op of operations) rows.set(op.path, op.create ? { ...op.data } : { ...rows.get(op.path), ...op.data });
      },
    };
  } };
  return { rows, service: new AppsService({ db: () => db } as unknown as FirebaseAdminService) };
}

test('registration rejects privilege injection, reserved apps, unsafe origins and callbacks', () => {
  for (const changes of [
    { appId: 'admin' }, { appId: 'infinity' }, { clientId: 'liftwise-mobile' },
    { approvedBy: 'attacker@example.test' }, { origins: ['https://*.example.test'] },
    { origins: ['http://new.example.test'] }, { origins: ['https://new.example.test/'] },
    { redirectUris: ['https://evil.example/callback'] }, { redirectUris: ['javascript://alert(1)'] },
    { redirectUris: ['https://user:pass@new.example.test/callback'] },
    { redirectUris: ['https://new.example.test/callback#fragment'] },
    { redirectUris: ['https://new.example.test/%0aevil'] }, { allowedScopes: ['openid', 'admin'] },
    { origins: 'https://new.example.test' }, { redirectUris: [] },
  ]) assert.throws(() => validateRegistration({ ...input, ...changes } as RegistrationInput), undefined, JSON.stringify(changes));
  assert.equal(validateRegistration({ ...input, origins: [], redirectUris: ['newproduct://callback'] }).redirectUris[0], 'newproduct://callback');
  assert.throws(() => validateRegistration({ ...input, clientType: 'confidential', origins: [], redirectUris: ['newproduct://callback'] }));
  assert.equal(validateRegistration({ ...input, origins: ['http://localhost:3000'], redirectUris: ['http://localhost:3000/callback'] }).origins[0], 'http://localhost:3000');
});

test('all application management routes require authentication and fresh admin privileges', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AppsController), [AuthGuard, UserManagementGuard]);
});

test('registration immediately enables app IDs, CORS origins and exact OAuth callbacks; revocation disables them', async () => {
  const { service, rows } = fixture();
  assert.equal(await service.resolveId(input.appId), null);
  const result = await service.registerOauthClient(input, 'admin@example.test');
  assert.equal('clientSecret' in result, false);
  assert.equal(await service.resolveId(input.appId), input.appId);
  assert.equal(await service.allowsOrigin(input.origins[0]), true);
  assert.equal(await service.allowsOrigin('https://evil.example'), false);
  assert.deepEqual((await service.resolveOauthClient(input.clientId))?.redirectUris, input.redirectUris);
  assert.equal(rows.get(`oauth_apps/${input.clientId}`).approved_by, 'admin@example.test');
  assert.equal(JSON.stringify(await service.policy(input.appId)).includes('owner@example.test'), false);
  await assert.rejects(service.registerOauthClient(input, 'admin@example.test'), /already registered/);
  await service.revokeOauthClient(input.clientId!, 'admin@example.test');
  assert.equal(await service.resolveId(input.appId), null);
  assert.equal(await service.resolveOauthClient(input.clientId), null);
  assert.equal(await service.allowsOrigin(input.origins[0]), false);
  await service.approveOauthClient(input.clientId!, 'admin@example.test');
  assert.equal(await service.resolveId(input.appId), input.appId);
});

test('pending and legacy registrations never become trusted without admin activation', async () => {
  const { service, rows } = fixture();
  await service.registerOauthClient({ ...input, status: 'pending' }, 'admin@example.test');
  assert.equal(await service.policy(input.appId), null);
  const row = rows.get(`oauth_apps/${input.clientId}`);
  rows.set(`oauth_apps/${input.clientId}`, { ...row, status: 'approved', registry_version: undefined });
  assert.equal(await service.resolveOauthClient(input.clientId), null);
  assert.equal(await service.allowsOrigin(input.origins[0]), false);
  await service.approveOauthClient(input.clientId!, 'admin@example.test');
  assert.equal(await service.allowsOrigin(input.origins[0]), true);
});

test('confidential secrets are returned once, hashed at rest, and rotation invalidates the previous secret', async () => {
  const { service, rows } = fixture();
  const result = await service.registerOauthClient({ ...input, clientType: 'confidential' }, 'admin@example.test');
  assert.ok(result.clientSecret);
  assert.equal(await service.verifyClientSecret(input.clientId!, result.clientSecret!), true);
  const rotated = await service.rotateClientSecret(input.clientId!, 'admin@example.test');
  assert.equal(await service.verifyClientSecret(input.clientId!, result.clientSecret!), false);
  assert.equal(await service.verifyClientSecret(input.clientId!, rotated.secret), true);
  assert.equal(await service.verifyClientSecret(input.clientId!, 'incorrect'), false);
  const serialized = JSON.stringify([...rows.values()]);
  assert.equal(serialized.includes(rotated.secret), false);
  const listing = JSON.stringify(await service.listRegisteredApps());
  assert.equal(listing.includes('secret'), false);
  assert.equal([...rows.values()].some(row => row.action === 'rotate-secret' && row.actor === 'admin@example.test'), true);
});
