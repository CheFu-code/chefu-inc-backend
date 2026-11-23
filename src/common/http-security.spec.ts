import test from 'node:test';
import assert from 'node:assert/strict';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Request, Response } from 'express';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { registeredAppOrigins } from '../modules/apps/app-registry';
import {
  configureCors,
  createCookieCsrfMiddleware,
  createSecurityHeadersMiddleware,
} from './http-security';

const allowedOrigins = ['https://myaccount.chefu.co.za'];

@Module({})
class HttpSecurityTestModule {}

async function startTestServer(trustedProxyAddresses: string[] = [], origins = allowedOrigins, dynamicOrigin?: (origin: string) => Promise<boolean>) {
  const app = await NestFactory.create<NestExpressApplication>(
    HttpSecurityTestModule,
    { bodyParser: false, logger: false },
  );
  app.set('trust proxy', trustedProxyAddresses);
  configureCors(app, origins, dynamicOrigin);
  app.use(express.json());
  app.use(cookieParser());
  app.use(createSecurityHeadersMiddleware());
  app.use(createCookieCsrfMiddleware(origins, dynamicOrigin));
  app.use((request: Request, response: Response) => {
    response.json({
      ip: request.ip,
      rawBodyCaptured: Boolean(
        (request as typeof request & { rawBody?: Buffer }).rawBody,
      ),
    });
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    await app.close();
    throw new Error('Test server did not bind to a TCP port.');
  }
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

void test('runtime origins immediately permit preflight and cookie mutations, and revocation fails closed', async () => {
  let approved = true;
  const origin = 'https://new-app.example.test';
  const server = await startTestServer([], allowedOrigins, async candidate => approved && candidate === origin);
  try {
    const options = { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-chefu-app' } };
    const preflight = await fetch(`${server.baseUrl}/probe`, options);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const mutation = await fetch(`${server.baseUrl}/probe`, { method: 'POST', headers: { Origin: origin, Cookie: '__session=test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(mutation.status, 200);
    approved = false;
    const denied = await fetch(`${server.baseUrl}/probe`, options);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const deniedReferer = await fetch(`${server.baseUrl}/probe`, { method: 'POST', headers: { Referer: `${origin}/settings`, Cookie: '__session=test' } });
    assert.equal(deniedReferer.status, 403);
  } finally { await server.app.close(); }
});

void test('HTTP security middleware enforces CORS and cookie CSRF while preserving API clients', async () => {
  const server = await startTestServer();
  try {
    const preflight = await fetch(`${server.baseUrl}/probe`, {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigins[0],
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigins[0]);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

    const allowedCookieMutation = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: {
        Origin: allowedOrigins[0],
        Cookie: '__session=test-session',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(allowedCookieMutation.status, 200);
    assert.equal(
      allowedCookieMutation.headers.get('x-content-type-options'),
      'nosniff',
    );
    assert.match(
      allowedCookieMutation.headers.get('content-security-policy') || '',
      /frame-ancestors 'self'/,
    );

    const missingOriginCookieMutation = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: {
        Cookie: '__session=test-session',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(missingOriginCookieMutation.status, 403);

    const untrustedOrigin = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        Cookie: '__session=test-session',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(untrustedOrigin.headers.get('access-control-allow-origin'), null);

    const bearerClient = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer api-token',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(bearerClient.status, 200);

    const ordinaryBodyResponse = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"ordinary":"payload"}',
    });
    assert.equal(ordinaryBodyResponse.status, 200);
    assert.deepEqual(await ordinaryBodyResponse.json(), {
      ip: '127.0.0.1',
      rawBodyCaptured: false,
    });

    const spoofedForwardingHeader = await fetch(`${server.baseUrl}/probe`, {
      headers: { 'X-Forwarded-For': '198.51.100.25' },
    });
    assert.deepEqual(await spoofedForwardingHeader.json(), {
      ip: '127.0.0.1',
      rawBodyCaptured: false,
    });
  } finally {
    await server.app.close();
  }
});

void test('deployed admin host passes credentialed preflights and cookie mutation origin checks', async () => {
  const origin = 'https://admin.chefu.co.za';
  const server = await startTestServer([], registeredAppOrigins());
  try {
    for (const method of ['GET', 'PATCH']) {
      const response = await fetch(`${server.baseUrl}/admin/user-management/session`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'content-type,x-chefu-app',
        },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
      assert.match(response.headers.get('access-control-allow-headers') || '', /x-chefu-app/i);
      assert.ok(response.headers.get('access-control-allow-methods')?.includes(method));
    }
    const mutation = await fetch(`${server.baseUrl}/probe`, {
      method: 'PATCH',
      headers: { Origin: origin, Cookie: '__session=test-session', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(mutation.status, 200);
    const untrusted = await fetch(`${server.baseUrl}/probe`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://admin.chefu.co.za.evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
  } finally {
    await server.app.close();
  }
});

void test('proxy forwarding headers are honored only when the peer is explicitly trusted', async () => {
  const trustedProxy = await startTestServer(['127.0.0.1']);
  try {
    const response = await fetch(`${trustedProxy.baseUrl}/probe`, {
      headers: { 'X-Forwarded-For': '198.51.100.25' },
    });
    assert.deepEqual(await response.json(), {
      ip: '198.51.100.25',
      rawBodyCaptured: false,
    });
  } finally {
    await trustedProxy.app.close();
  }
});
