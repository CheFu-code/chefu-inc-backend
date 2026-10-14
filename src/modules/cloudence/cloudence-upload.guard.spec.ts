import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { Module } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { CloudenceController } from './cloudence.controller';
import { CloudenceService } from './cloudence.service';
import { CloudenceUploadGuard } from './cloudence-upload.guard';
import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';

@Module({})
class TestModule {}

test('HTTP admission returns 429 before an upload body is sent and reserves each admitted upload once', async () => {
  let limited = true;
  let reservations = 0;
  let uploaded = 0;
  const limiter = { reserve: async () => { reservations++; return { limited, retryAfterSeconds: 30 }; } };
  // tsx does not emit constructor metadata; use the same dependencies explicitly in this fixture.
  Reflect.defineMetadata('design:paramtypes', [CloudenceService], CloudenceController);
  Reflect.defineMetadata(GUARDS_METADATA, [{ canActivate: (context: ExecutionContext) => {
    context.switchToHttp().getRequest().user = { uid: 'user', email: 'user@example.com', roles: [] }; return true;
  } }], CloudenceController);
  Reflect.defineMetadata(GUARDS_METADATA, [new CloudenceUploadGuard(limiter as unknown as RuntimeLimitService)], CloudenceController.prototype.upload);
  const app = await NestFactory.create<NestExpressApplication>({
    module: TestModule,
    controllers: [CloudenceController],
    providers: [
      { provide: RuntimeLimitService, useValue: limiter },
      { provide: CloudenceService, useValue: { upload: async () => { uploaded++; return { id: 'file-1' }; } } },
    ],
  }, { logger: false, abortOnError: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if(!address || typeof address === 'string') throw new Error('Failed to get server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/cloudence/files`, {
        method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Transfer-Encoding': 'chunked' },
      }, (response) => {
        try {
          assert.equal(response.statusCode, 429);
          assert.equal(response.headers['retry-after'], '30');
          assert.equal(uploaded, 0);
          response.resume();
          response.once('end', () => { request.destroy(); resolve(); });
        } catch (error) { request.destroy(); reject(error); }
      });
      request.on('error', reject);
      request.setTimeout(3000, () => { request.destroy(); reject(new Error('Admission waited for the file body')); });
      request.flushHeaders(); // No file bytes are sent; Multer must never run for this rejection.
    });
    limited = false;
    const body = new FormData();
    body.append('file', new File(['content'], 'test.txt'));
    const accepted = await fetch(`${baseUrl}/cloudence/files`, { method: 'POST', body });
    assert.equal(accepted.status, 201);
    assert.equal(uploaded, 1);
    assert.equal(reservations, 2);
  } finally { await app.close(); }
});

test('concurrency admission is bounded and slots are released after completion or disconnection', async () => {
  let reservations = 0;
  const guard = new CloudenceUploadGuard({ reserve: async () => { reservations++; return { limited: false }; } } as unknown as RuntimeLimitService);
  function context(uid: string) {
    const response = Object.assign(new EventEmitter(), { setHeader() {} });
    return { response, value: { switchToHttp: () => ({ getRequest: () => ({ user: { uid } }), getResponse: () => response }) } as ExecutionContext };
  }
  const first = [context('a'), context('a'), context('a')];
  for (const item of first) await guard.canActivate(item.value);
  await assert.rejects(guard.canActivate(context('a').value), /busy/);
  const second = [context('b'), context('b'), context('b')];
  for (const item of second) await guard.canActivate(item.value);
  await assert.rejects(guard.canActivate(context('c').value), /busy/);
  assert.equal(reservations, 6);
  first[0].response.emit('finish');
  first[0].response.emit('close'); // Both events must release only one slot.
  const next = context('c');
  assert.equal(await guard.canActivate(next.value), true);
  next.response.emit('close');
  assert.equal(await guard.canActivate(context('a').value), true);
});
