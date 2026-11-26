import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, type ArgumentsHost } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureCors } from './http-security';
import { GlobalExceptionFilter } from './global-exception.filter';

type OriginCheck = (
  origin: string | undefined,
  callback: (error: Error | null, allowed?: boolean) => void,
) => void;

function originChecker(dynamicOrigin?: (origin: string) => Promise<boolean>) {
  let check!: OriginCheck;
  const app = {
    enableCors: (options: { origin: OriginCheck }) => { check = options.origin; },
  } as unknown as NestExpressApplication;
  configureCors(app, ['https://myaccount.chefu.co.za'], dynamicOrigin);
  return (origin?: string) => new Promise<{ error: Error | null; allowed?: boolean }>((resolve) => {
    check(origin, (error, allowed) => resolve({ error, allowed }));
  });
}

void test('static and dynamic CORS denials are expected 403 errors, not unhandled server errors', async () => {
  for (const check of [originChecker(), originChecker(async () => false)]) {
    const result = await check('https://unregistered.example.test');
    assert.ok(result.error instanceof ForbiddenException);
    assert.equal(result.error.getStatus(), 403);
    assert.equal(result.error.message, 'Origin is not allowed by CORS.');
    assert.equal(result.allowed, false);
  }
});

void test('native and approved origins bypass the registry, while a registry outage remains a real server failure', async () => {
  let lookups = 0;
  const outage = new Error('Registry unavailable');
  const check = originChecker(async () => { lookups++; throw outage; });
  assert.deepEqual(await check(), { error: null, allowed: true });
  assert.deepEqual(await check('https://myaccount.chefu.co.za'), { error: null, allowed: true });
  assert.equal(lookups, 0);
  assert.equal((await check('https://registered-at-runtime.example.test')).error, outage);
  assert.equal(lookups, 1);
});

void test('CORS denial diagnostics include the origin without logging cookies or URL query secrets', () => {
  const filter = new GlobalExceptionFilter();
  const logs: string[] = [];
  Reflect.set(filter, 'logger', {
    warn: (message: string) => logs.push(message),
    error: () => assert.fail('Expected CORS denial must not be logged as a server error'),
  });
  let status = 0;
  let body: unknown;
  const response = {
    status: (value: number) => { status = value; return response; },
    json: (value: unknown) => { body = value; },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'OPTIONS', originalUrl: '/auth/me?token=private-query',
        headers: { origin: 'https://unregistered.example.test', cookie: '__session=private-cookie' },
        socket: {}, requestId: 'cors-test',
      }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  filter.catch(new ForbiddenException('Origin is not allowed by CORS.'), host);
  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'Origin is not allowed by CORS.', requestId: 'cors-test' });
  const logged = JSON.parse(logs[0]);
  assert.equal(logged.origin, 'https://unregistered.example.test');
  assert.equal(logged.path, '/auth/me');
  assert.ok(!logs.join('').includes('private-query'));
  assert.ok(!logs.join('').includes('private-cookie'));
});
