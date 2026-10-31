import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Module, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { v2 as cloudinary } from 'cloudinary';
import { CloudenceService } from './cloudence.service';
import { CloudenceController } from './cloudence.controller';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { CloudinaryStorageService } from '../../common/cloudinary-storage.service';
import { CloudenceFileDocument } from './cloudence.types';

@Module({})
class ContentTestModule {}

test('HTTP file content requires authorization, streams ranges, prevents shared caching, and never redirects to storage', async (t) => {
  let upstreamRequests = 0;
  const origin = createServer((request, response) => {
    upstreamRequests++;
    assert.equal(request.headers.authorization, undefined, 'User credentials must not be forwarded to storage');
    response.setHeader('Content-Type', 'image/png');
    if (request.headers.range) {
      response.statusCode = 206;
      response.setHeader('Content-Range', 'bytes 0-2/6');
      response.end('abc');
    } else response.end('abcdef');
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address();
  if (!address || typeof address === 'string') throw new Error('Origin did not bind');
  t.mock.method(cloudinary, 'url', () => `http://127.0.0.1:${address.port}/internal-storage`);
  const file: CloudenceFileDocument = {
    id: 'file-1', ownerId: 'owner', owner: { id: 'owner', email: 'owner@example.com', fullName: 'Owner' },
    name: 'image.png', type: 'image', extension: 'png', size: 6, url: 'https://example.com/old.png',
    publicId: 'chefu/cloudence/owner/private-id', resourceType: 'image', deliveryType: 'authenticated',
    users: ['friend@example.com'], createdAt: '', updatedAt: '',
  };
  const service = new CloudenceService(
    { db: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({ ...file }) }) }) }) }) } as unknown as FirebaseAdminService,
    {} as RuntimeLimitService, {} as CloudinaryStorageService,
  );
  Reflect.defineMetadata('design:paramtypes', [CloudenceService], CloudenceController);
  Reflect.defineMetadata(GUARDS_METADATA, [{ canActivate: (context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest();
    const identity = request.headers.authorization?.replace('Bearer ', '');
    if (!identity) throw new UnauthorizedException();
    request.user = { uid: identity, email: `${identity}@example.com`, roles: [] };
    return true;
  } }], CloudenceController);
  const app = await NestFactory.create<NestExpressApplication>({ module: ContentTestModule, controllers: [CloudenceController], providers: [{ provide: CloudenceService, useValue: service }] }, { logger: false, abortOnError: false });
  await app.listen(0, '127.0.0.1');
  const appAddress = app.getHttpServer().address();
  if (!appAddress || typeof appAddress === 'string') throw new Error('Test server did not bind');
  const url = `http://127.0.0.1:${appAddress.port}/cloudence/files/file-1/content`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer stranger' } })).status, 403);
    assert.equal(upstreamRequests, 0);
    const owner = await fetch(url, { headers: { Authorization: 'Bearer owner' } });
    assert.equal(owner.status, 200);
    assert.equal(await owner.text(), 'abcdef');
    assert.equal(owner.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.match(owner.headers.get('vary')!, /Cookie/);
    assert.equal(owner.headers.get('location'), null);
    const shared = await fetch(url, { headers: { Authorization: 'Bearer friend', Range: 'bytes=0-2' } });
    assert.equal(shared.status, 206);
    assert.equal(shared.headers.get('content-range'), 'bytes 0-2/6');
    assert.equal(await shared.text(), 'abc');
    file.users = [];
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer friend' } })).status, 403);
    file.users = ['friend@example.com'];
    file.shareExpiresAt = '2000-01-01';
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer friend' } })).status, 403);
    assert.equal(upstreamRequests, 2);
    const download = await fetch(url + '?download=1', { headers: { Authorization: 'Bearer owner' } });
    assert.match(download.headers.get('content-disposition')!, /^attachment/);
    await download.arrayBuffer();
    const head = await fetch(url, { method: 'HEAD', headers: { Authorization: 'Bearer owner' } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await app.close();
    origin.closeAllConnections();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});
